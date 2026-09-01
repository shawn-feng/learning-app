/**
 * 学习考核 · 孩子端锁定考试视图（EXAM-REQUIREMENTS.md §4）。
 * - 全屏覆盖（fixed inset 0）：考试期间无导航、无资料、无 AI 提示；关闭 app = 本次作废（严格一次性）。
 * - 流程：取考核配置 → 选科目 → 客户端出卷（内存 session）→ iframe 渲染考试模板（srcDoc + allow="microphone"）
 *   → 逐题语音作答（重录/转写回显/文字兜底/计时）→ 提交 → 客户端判分（内存 session，prompt 取自服务端）
 *   → 上传语音 + 上报结果到服务端 → 展示报告（逐题得分/评语 + 课程掌握度 + 加强计划）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { buildExamHtml } from "../lib/exam-template";

type Stage = "pick" | "exam" | "scoring" | "report" | "error";

interface TopicCard {
  topicKey: string;
  name: string;
  assessMethod: string;
  courses: Array<{ title: string; firstLearned: string; lastReview: string; mastery: string; assessRubric: string }>;
}

interface QuestionUI {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
}

interface ScoredResult {
  perQuestion: Array<{ qid: string; pointGot: number; correct: boolean; aiComment: string }>;
  courseMastery: Record<string, { correct: number; total: number; rate: number }>;
  reinforcePlan: Record<string, { planReviewAt: string; focus: string[]; aiSuggestion?: string }>;
  score: number;
  overall: string;
}

interface Props {
  childId: string;
  onExit: () => void;
}

const btn: React.CSSProperties = {
  padding: "10px 22px",
  borderRadius: 10,
  border: "none",
  fontSize: 15,
  cursor: "pointer",
  fontWeight: 600,
};

export default function ExamView({ childId, onExit }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [topics, setTopics] = useState<TopicCard[]>([]);
  const [error, setError] = useState("");
  const [examHtml, setExamHtml] = useState("");
  const [examTopic, setExamTopic] = useState<TopicCard | null>(null);
  const [scoringPrompt, setScoringPrompt] = useState("");
  const [report, setReport] = useState<ScoredResult | null>(null);
  const [reportTitle, setReportTitle] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const busyRef = useRef(false);

  // 初始化：取考核配置
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r: any = await window.api.examConfig(childId);
        if (!r?.success) {
          if (alive) { setError(r?.error || "获取考核配置失败"); setStage("error"); }
          return;
        }
        const cfg = r.data as { topics: TopicCard[]; scoringPrompt: string };
        setScoringPrompt(cfg.scoringPrompt || "");
        if (alive) {
          if (!cfg.topics?.length) {
            setError("当前没有可考核的科目（需要家长先在「考核要点」里写好考核方法说明，且孩子学/复习过课程）");
            setStage("error");
          } else {
            setTopics(cfg.topics);
          }
        }
      } catch (e: any) {
        if (alive) { setError(String(e?.message || e)); setStage("error"); }
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId]);

  // 开始一场考核：客户端出卷 → 渲染考试页面
  const startExam = useCallback(
    async (t: TopicCard) => {
      setExamTopic(t);
      setStage("scoring"); // 出卷也属于"准备"，用 loading 态
      try {
        const g: any = await window.api.examGenerate(childId, t);
        if (!g?.success) throw new Error(g?.error || "出卷失败");
        const questions: QuestionUI[] = (g.data || []).map((q: any, i: number) => ({
          qid: q.qid || `q${i + 1}`,
          course: q.course,
          stem: q.stem,
          pointMax: Number(q.pointMax) || 10,
        }));
        if (!questions.length) throw new Error("出卷未返回题目");
        setExamHtml(
          buildExamHtml(
            questions.map((q) => ({ id: q.qid, course: q.course, pointMax: q.pointMax, stem: q.stem })),
            t.name,
            `${t.name} · 学习考核`
          )
        );
        setStage("exam");
      } catch (e: any) {
        setError(`出卷失败：${String(e?.message || e)}`);
        setStage("error");
      }
    },
    []
  );

  // 接收 iframe 消息：ASR 转写请求 / 考核提交
  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      const d = ev.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "exam:asr") {
        try {
          const buf = await (d.blob as Blob).arrayBuffer();
          const r: any = await window.api.voiceTranscribe(buf);
          const text = r?.success ? (r.text || "") : "";
          iframeRef.current?.contentWindow?.postMessage({ type: "exam:asr:done", qid: d.qid, text }, "*");
        } catch {
          iframeRef.current?.contentWindow?.postMessage({ type: "exam:asr:done", qid: d.qid, text: "" }, "*");
        }
        return;
      }
      if (d.type === "exam:submit" && !busyRef.current) {
        busyRef.current = true;
        await handleSubmit(d.payload);
        busyRef.current = false;
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [childId, scoringPrompt, examTopic]);

  async function handleSubmit(payload: {
    title?: string;
    subject?: string;
    submittedAt?: string;
    perQuestion: Array<{
      qid: string;
      course: string;
      stem: string;
      pointMax: number;
      audioBlob: Blob | null;
      asr: string;
      startedAt: number | null;
      answeredAt: number | null;
      durationMs: number | null;
    }>;
  }) {
    if (!examTopic) return;
    setStage("scoring");
    try {
      // 1) 客户端判分（独立内存 session，prompt 取自服务端；每题带上家长写的考核要点 rubric 作判分锚定）
      const rubricByCourse = new Map((examTopic.courses || []).map((c) => [c.title, c.assessRubric || ""]));
      const answers = payload.perQuestion.map((q) => ({
        qid: q.qid,
        course: q.course,
        stem: q.stem,
        pointMax: Number(q.pointMax) || 10,
        rubric: rubricByCourse.get(q.course) || "",
        asrText: q.asr || "",
        durationMs: q.durationMs ?? null,
      }));
      const s: any = await window.api.examScore(childId, scoringPrompt, answers);
      if (!s?.success) throw new Error(s?.error || "判分失败");
      const scored = s.data as ScoredResult;

      // 2) 上传语音（files 通道），提交时携带 fileId
      const voices: Array<{ qid: string; buffer: ArrayBuffer; name: string }> = [];
      for (const q of payload.perQuestion) {
        if (q.audioBlob) {
          voices.push({ qid: q.qid, buffer: await q.audioBlob.arrayBuffer(), name: `voice-${q.qid}.webm` });
        }
      }
      const gotByQid = new Map(scored.perQuestion.map((x) => [x.qid, x]));
      const perQuestion = payload.perQuestion.map((q) => {
        const g = gotByQid.get(q.qid);
        return {
          qid: q.qid,
          course: q.course,
          question: q.stem,
          asrText: q.asr || "",
          startedAt: q.startedAt ?? undefined,
          answeredAt: q.answeredAt ?? undefined,
          durationMs: q.durationMs ?? undefined,
          pointGot: g?.pointGot ?? 0,
          pointMax: Number(q.pointMax) || 10,
          correct: !!g?.correct,
          aiComment: g?.aiComment || "",
        };
      });
      const wrongQuestions = perQuestion.filter((x) => !x.correct).map((x) => x.qid);

      // 3) 上报服务端（exam_attempts + exam_mastery 回写）
      const attempt = {
        childId,
        topic: examTopic.topicKey,
        title: `${examTopic.name} · ${new Date().toLocaleDateString("zh-CN")}考核`,
        startedAt: new Date(payload.perQuestion[0]?.startedAt ?? Date.now()).toISOString(),
        submittedAt: payload.submittedAt || new Date().toISOString(),
        score: Number(scored.score) || 0,
        perQuestion,
        courseMastery: scored.courseMastery || {},
        reinforcePlan: scored.reinforcePlan || {},
        wrongQuestions,
      };
      const sub: any = await window.api.examSubmit(attempt, voices);
      if (!sub?.success) throw new Error(sub?.error || "提交失败");

      setReport(scored);
      setReportTitle(attempt.title);
      setStage("report");
    } catch (e: any) {
      setError(`提交失败：${String(e?.message || e)}`);
      setStage("error");
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        background: "#f5f7fa",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* 头部（锁定提示） */}
      <div
        style={{
          background: "#fff",
          borderBottom: "1px solid #e6eaf0",
          padding: "12px 18px",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 700, fontSize: 16 }}>🎯 学习考核</span>
        <span
          style={{
            color: "#fff",
            background: "#3b6ef5",
            borderRadius: 999,
            padding: "2px 12px",
            fontSize: 12,
          }}
        >
          {examTopic?.name || "考核"}
        </span>
        <span style={{ flex: 1 }} />
        {stage === "exam" && (
          <span style={{ color: "#b9770a", fontSize: 13 }}>🔒 考核进行中，不可退出</span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {stage === "pick" && (
          <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>选择要考核的科目</div>
            <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
              系统会按家长写的「考核方法说明」自动出题，考的是你最近学过的内容。开始后不能中途退出。
            </p>
            {topics.map((t) => (
              <div
                key={t.topicKey}
                style={{
                  background: "#fff",
                  border: "1px solid #e6eaf0",
                  borderRadius: 12,
                  padding: "14px 16px",
                  marginBottom: 10,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{t.name}</div>
                  <div style={{ color: "#6b7686", fontSize: 12, marginTop: 2 }}>
                    可考 {t.courses.length} 课（学/复习过的知识点）
                  </div>
                </div>
                <button style={{ ...btn, background: "#3b6ef5", color: "#fff" }} onClick={() => startExam(t)}>
                  开始考核
                </button>
              </div>
            ))}
            <button
              style={{ ...btn, background: "#fff", border: "1px solid #ddd", color: "#555", marginTop: 8 }}
              onClick={onExit}
            >
              返回
            </button>
          </div>
        )}

        {stage === "exam" && examHtml && (
          <iframe
            ref={iframeRef}
            srcDoc={examHtml}
            sandbox="allow-scripts allow-modals allow-forms"
            allow="microphone"
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            title="学习考核"
          />
        )}

        {stage === "scoring" && (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 40 }}>⏳</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>老师正在批改你的回答…</div>
            <div style={{ color: "#6b7686", fontSize: 13 }}>逐题评估中，请稍等（约 10~30 秒）</div>
          </div>
        )}

        {stage === "report" && report && (
          <div style={{ padding: 24, maxWidth: 760, margin: "0 auto" }}>
            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6eaf0", padding: 20, marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
                <div style={{ fontSize: 20, fontWeight: 800 }}>{reportTitle}</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: report.score >= 60 ? "#27ae60" : "#e74c3c" }}>
                  {report.score} 分
                </div>
              </div>
              {report.overall && <p style={{ color: "#333", fontSize: 14, marginBottom: 0 }}>{report.overall}</p>}
            </div>

            <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6eaf0", padding: 20, marginBottom: 14 }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>📝 逐题评估</div>
              {report.perQuestion.map((q, i) => (
                <div key={q.qid} style={{ padding: "8px 0", borderBottom: i < report.perQuestion.length - 1 ? "1px solid #f0f0f0" : "none" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>第 {i + 1} 题</span>
                    <span style={{ fontSize: 12, color: q.correct ? "#27ae60" : "#e74c3c", fontWeight: 700 }}>
                      {q.correct ? `✓ ${q.pointGot} 分` : `✗ ${q.pointGot} 分`}
                    </span>
                  </div>
                  {q.aiComment && <div style={{ fontSize: 13, color: "#555", marginTop: 2 }}>{q.aiComment}</div>}
                </div>
              ))}
            </div>

            {Object.keys(report.courseMastery).length > 0 && (
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6eaf0", padding: 20, marginBottom: 14 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>📊 每课掌握情况</div>
                {Object.entries(report.courseMastery).map(([course, m]) => (
                  <div key={course} style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 0" }}>
                    <span style={{ flex: 1, fontSize: 13 }}>{course}</span>
                    <div style={{ width: 140, height: 8, background: "#eef2f8", borderRadius: 99, overflow: "hidden" }}>
                      <div
                        style={{
                          height: "100%",
                          width: `${Math.round((m.rate || 0) * 100)}%`,
                          background: (m.rate || 0) >= 0.6 ? "#27ae60" : "#e74c3c",
                        }}
                      />
                    </div>
                    <span style={{ fontSize: 12, color: "#6b7686", width: 40, textAlign: "right" }}>
                      {Math.round((m.rate || 0) * 100)}%
                    </span>
                  </div>
                ))}
              </div>
            )}

            {Object.keys(report.reinforcePlan).length > 0 && (
              <div style={{ background: "#fff", borderRadius: 14, border: "1px solid #e6eaf0", padding: 20, marginBottom: 14 }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>📌 复习计划</div>
                {Object.entries(report.reinforcePlan).map(([course, p]) => (
                  <div key={course} style={{ padding: "6px 0", fontSize: 13 }}>
                    <div style={{ fontWeight: 600 }}>
                      {course}
                      {p.planReviewAt ? <span style={{ color: "#3b6ef5", marginLeft: 8 }}>计划复习：{p.planReviewAt}</span> : null}
                    </div>
                    {p.focus?.length > 0 && (
                      <div style={{ color: "#6b7686", marginTop: 2 }}>
                        重点：{p.focus.join("；")}
                        {p.aiSuggestion ? `（${p.aiSuggestion}）` : ""}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <button style={{ ...btn, background: "#27ae60", color: "#fff", width: "100%" }} onClick={onExit}>
              完成，返回
            </button>
          </div>
        )}

        {stage === "error" && (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, padding: 24 }}>
            <div style={{ fontSize: 40 }}>😥</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>考核无法进行</div>
            <div style={{ color: "#6b7686", fontSize: 13, textAlign: "center", maxWidth: 420 }}>{error}</div>
            <button style={{ ...btn, background: "#3b6ef5", color: "#fff" }} onClick={onExit}>
              返回
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

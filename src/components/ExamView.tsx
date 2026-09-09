/**
 * 学习考核 · 孩子端锁定考试视图（EXAM-REQUIREMENTS.md §4 / §14.6）。
 * v2：左侧进入后先展示「今天可考核的排期」（固定排期 + 家长自定义；考核只按日期，当天 0 点起可考），点「开始这次考核」。
 * - 流程：取排期列表 → 点开始 → 服务端按排期选课（config?schedule=）→ 客户端出卷（内存 session，每课完整出题）
 *   → iframe 渲染考试模板（srcDoc + allow="microphone"）→ 逐题语音作答 → 提交 → 客户端判分（prompt 取自服务端）
 *   → 上传语音 + 上报结果（关联 scheduleId）→ 排期标记完成 → 展示报告。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { buildExamHtml } from "../lib/exam-template";
import type { SpeechAssessment } from "../../electron/lib/exam";

type Stage = "pick" | "exam" | "scoring" | "report" | "error";

interface ScheduleItem {
  id: string;
  kind: "fixed" | "custom";
  freq: string;
  scheduledAt: string;
  status: "pending" | "started" | "done" | "expired";
  attemptId: string;
  title: string;
  scope: Record<string, unknown>;
  pending: boolean;
}

interface CourseConfig {
  title: string;
  firstLearned: string;
  lastReview: string;
  mastery: string;
  examMastery: string;
  assessRubric: string;
}

interface QuestionUI {
  qid: string;
  course: string;
  stem: string;
  pointMax: number;
}

interface ScoredResult {
  perQuestion: Array<{
    qid: string;
    pointGot: number;
    correct: boolean;
    aiComment: string;
    /** 口语/听说题（背诵）附加字段 */
    question?: string;
    assessMethod?: "speech";
    questionType?: string;
    refText?: string;
    audioFileId?: string;
    speech?: SpeechAssessment;
  }>;
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

const FREQ_LABEL: Record<string, string> = { daily: "每天", weekly: "每周", monthly: "每月", halfyear: "每半年", yearly: "每年" };

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `📅 ${d.getMonth() + 1}月${d.getDate()}日（今天）`;
}

export default function ExamView({ childId, onExit }: Props) {
  const [stage, setStage] = useState<Stage>("pick");
  const [schedules, setSchedules] = useState<ScheduleItem[]>([]);
  const [error, setError] = useState("");
  const [examHtml, setExamHtml] = useState("");
  const [currentSchedule, setCurrentSchedule] = useState<ScheduleItem | null>(null);
  const [scoringPrompt, setScoringPrompt] = useState("");
  const [report, setReport] = useState<ScoredResult | null>(null);
  const [reportTitle, setReportTitle] = useState("");
  // 口语题报告回放：fileId → data URL（点击「听我的背诵」时按需拉取）
  const [speechAudio, setSpeechAudio] = useState<Record<string, string>>({});
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const busyRef = useRef(false);
  // 本场考核的候选课程（含 rubric，判分锚定用；startExam 时从 config 获取）
  const examCoursesRef = useRef<CourseConfig[]>([]);
  // 流式出题（ISSUE-049）：exam iframe 就绪后由 beginStreaming 逐门后台生成、按序增量送达。
  // runId 防重复进入/卸载后仍往已卸载 iframe 发送。
  const streamPlanRef = useRef<{ childId: string; topicName: string; childName: string; courses: CourseConfig[] } | null>(null);
  const streamRunRef = useRef(0);
  // 幂等：同一场考试只启动一次流式出题（iframe 因 srcDoc 变化重载会再次触发 onLoad）
  const streamStartedRef = useRef(false);
  // 准备阶段提示文案（选课/出题/判分共用「批改中」遮罩）
  const [prepText, setPrepText] = useState("");

  // 初始化：取考核排期列表（服务端懒生成固定排期）→ 只保留「今天」的考核
  const loadSchedules = useCallback(async () => {
    try {
      const r: any = await window.api.examSchedules(childId);
      if (!r?.success) throw new Error(r?.error || "获取考核排期失败");
      const all = r.data?.schedules || [];
      // 排期 scheduledAt 为 UTC ISO；按本地时区取「今天」的年月日做过滤
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
      const todays = all.filter((s: any) => {
        const d = new Date(s.scheduledAt);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        return key === todayKey;
      });
      setSchedules(todays);
    } catch (e: any) {
      setError(String(e?.message || e));
      setStage("error");
    }
  }, [childId]);

  useEffect(() => {
    loadSchedules();
  }, [loadSchedules]);

  // 开始一次考核：排期 → 取选课数据 →（固定排期）客户端 LLM 选课 → 取 rubric → 客户端逐课出卷 → 渲染考试页面
  const startExam = useCallback(
    async (sch: ScheduleItem) => {
      setCurrentSchedule(sch);
      setStage("scoring");
      setPrepText("正在获取考核数据…");
      try {
        // 标记开始；失败不阻断（started 状态的排期允许重新开始，避免出卷失败后卡死）
        await window.api.examScheduleStart(sch.id).catch(() => undefined);
        // v3 §14.9 两段式：第一段取选课数据（固定排期 = selectionPrompt + candidates；自定义排期 scope = courses）
        const cfg: any = await window.api.examConfig(childId, sch.id);
        if (!cfg?.success) throw new Error(cfg?.error || "获取考核内容失败");
        const data = cfg.data;
        let courses: CourseConfig[] = data.courses || [];
        let scoring = data.scoringPrompt || "";
        if (!courses.length && data.selectionPrompt) {
          // 固定排期 → 客户端 LLM 按服务端下发的选课 prompt（家长可编辑）从候选课程中挑课
          setPrepText("正在挑选本次要考核的课程…");
          const sel: any = await window.api.examSelectCourses(childId, data.selectionPrompt);
          if (!sel?.success) throw new Error(sel?.error || "选课失败");
          const titles: string[] = sel.data || [];
          // 固定档（每天/每周）候选来自家长学习计划（无计划则不考）；自定义档仍是学习/复习痕迹口径
          const isPlanFreq = data.schedule?.freq === "daily" || data.schedule?.freq === "weekly";
          if (!titles.length) throw new Error(
            isPlanFreq
              ? `这次考核没有选出要考的课程——${data.schedule?.freq === "daily" ? "今天" : "近 7 天"}的学习计划里还没有安排课程（有计划的课程无论是否完成都会考核）。可以先请爸爸妈妈在学习计划里排上内容，或调整考核选课规则后再试。`
              : "这次考核没有选出要考的课程——这个周期可能还没有学习或复习过的课程。可以先学一学再来，或请爸爸妈妈在「学习考核」里调整选课规则。"
          );
          // 第二段：按选中课程拉 rubric + 判分 prompt
          setPrepText("正在准备课程考核内容…");
          const cfg2: any = await window.api.examConfig(childId, sch.id, titles.join(","));
          if (!cfg2?.success) throw new Error(cfg2?.error || "获取课程考核内容失败");
          courses = cfg2.data?.courses || [];
          scoring = cfg2.data?.scoringPrompt || "";
        }
        if (!courses.length) throw new Error("这次考核暂时没有可考核的内容（可以先学一学再来，或请爸爸妈妈在「设置 → 学习考核」里调整选课规则）");
        examCoursesRef.current = courses;
        setScoringPrompt(scoring);
        // 流式出题（ISSUE-049）：不再等全部课程出完才显示。先渲染「空考试壳」（提示总课程数），
        // iframe 加载就绪后 beginStreaming 逐门并发出题，每出好一门就 postMessage 把题目追加进答题流。
        const topicName = data.schedule?.title || sch.title;
        streamPlanRef.current = { childId, topicName, childName: String((data as any).childName || ""), courses };
        streamRunRef.current++; // 使上一场（若有）的生成循环失效
        streamStartedRef.current = false; // 新一场重新允许 onLoad 启动
        setExamHtml(buildExamHtml([], topicName, `${topicName} · 学习考核`, courses.length));
        setStage("exam");
      } catch (e: any) {
        setError(`开始考核失败：${String(e?.message || e)}`);
        setStage("error");
      }
    },
    [childId]
  );

  // ===== 流式出题：iframe 就绪后逐门生成（并发 3），按课程顺序 flush 送达 =====
  async function beginStreaming(plan: { childId: string; topicName: string; courses: CourseConfig[] }) {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    const runId = ++streamRunRef.current;
    const total = plan.courses.length;
    const ready: (any[] | null)[] = new Array(total).fill(null);
    let delivered = 0;
    let okAny = false;
    const post = (questions: any[], remaining: number) => {
      try {
        win.postMessage({ type: "exam:addQuestions", questions, remaining }, "*");
      } catch {
        /* iframe 已卸载则忽略 */
      }
    };
    const flush = () => {
      while (delivered < total && ready[delivered]) {
        post(ready[delivered]!, total - delivered - 1);
        delivered++;
      }
    };
    let next = 0;
    const worker = async () => {
      while (runId === streamRunRef.current && next < total) {
        const i = next++;
        const course = plan.courses[i];
        try {
          const g: any = await window.api.examGenerateCourse(plan.childId, plan.topicName, course, plan.childName);
          if (runId !== streamRunRef.current) return; // 已切场/退出
          if (g?.success && Array.isArray(g.data)) {
            ready[i] = g.data;
            okAny = true;
          } else {
            ready[i] = [];
            console.warn(`[exam] 出题失败（已跳过该门课）：${course.title}`, g?.error || "");
          }
        } catch (e) {
          ready[i] = [];
          console.error(`[exam] 出题失败（已跳过该门课）：${course.title}`, e);
        }
        flush();
      }
    };
    // 并发上限 3（与 generateExamQuestions 一致，避免同时太多本地 LLM 调用）
    await Promise.all(Array.from({ length: Math.min(3, total) }, () => worker()));
    flush(); // 收尾（含最后一门）
    if (!okAny && runId === streamRunRef.current) {
      setError("这次出卷失败了，请返回重新进入考核再试一次。");
      setStage("error");
    }
  }

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
  }, [childId, scoringPrompt, currentSchedule]);

  async function handleSubmit(payload: {
    title?: string;
    subject?: string;
    submittedAt?: string;
    perQuestion: Array<{
      qid: string;
      course: string;
      stem: string;
      pointMax: number;
      /** 多次按住说话的多段录音（dataURL base64）——宿主合并为单段后上传 */
      audioB64s?: string[];
      asr: string;
      durationMs: number | null;
      /** 口语/听说题（背诵等）：提交时走 SSECP 而非 LLM 判分 */
      assessMethod?: "speech";
      questionType?: string;
      refText?: string;
    }>;
  }) {
    if (!currentSchedule) return;
    setStage("scoring");
    setPrepText("老师正在批改你的回答…");
    try {
      const isSpeech = (q: (typeof payload.perQuestion)[number]) => !!q.questionType;
      const speechQs = payload.perQuestion.filter(isSpeech);
      const textQs = payload.perQuestion.filter((q) => !isSpeech(q));

      // 复用：dataURL → 纯 base64 / ArrayBuffer（voiceMerge 需要纯 base64 多段）
      const plainB64 = (s: string) => {
        const i = s.indexOf(",");
        return i >= 0 ? s.slice(i + 1) : s;
      };
      const b64ToBuf = (s: string) =>
        Uint8Array.from(atob(plainB64(s)), (c) => c.charCodeAt(0)).buffer;

      // 1) 口述题（文字/知识类）：客户端 LLM 判分（独立内存 session，rubric 作判分锚定）
      let scored: ScoredResult | null = null;
      if (textQs.length) {
        const courses = examCoursesRef.current;
        const rubricByCourse = new Map(courses.map((c) => [c.title, c.assessRubric || ""]));
        const answers = textQs.map((q) => ({
          qid: q.qid,
          course: q.course,
          stem: q.stem,
          pointMax: Number(q.pointMax) || 10,
          rubric: rubricByCourse.get(q.course) || "",
          asrText: q.asr || "",
          durationMs: q.durationMs ?? null,
        }));
        const r: any = await window.api.examScore(childId, scoringPrompt, answers);
        if (!r?.success) throw new Error(r?.error || "判分失败");
        scored = r.data as ScoredResult;
      }

      // 2) 口语/听说题（背诵等）：提交时「批量评」——多段录音拼成 16k wav → 上传 → SSECP 发音评测。
      //    并行评测避免阻塞（用户要求：考核结束一次性提交，不逐题实时评）。
      const speechResult = await Promise.all(
        speechQs.map(async (q) => {
          const segs: string[] = Array.isArray(q.audioB64s) ? q.audioB64s : [];
          // 无录音的口语题：记 0 分，不调评测
          if (!segs.length) {
            return {
              qid: q.qid,
              pointGot: 0,
              pointMax: Number(q.pointMax) || 10,
              correct: false,
              aiComment: "未检测到背诵录音",
              audioFileId: undefined as string | undefined,
              speech: undefined as SpeechAssessment | undefined,
            };
          }
          // 多段录音（多次按住说话）拼成单段 WAV（voiceMerge 已是 16k 单声道 wav，SSECP 直吃）
          let buf: ArrayBuffer;
          if (segs.length === 1) {
            buf = b64ToBuf(segs[0]);
          } else {
            const m: any = await window.api.voiceMerge(childId, segs.map(plainB64));
            if (!m?.success || !m.data) throw new Error(`合并语音失败：${m?.error || ""}`);
            buf = b64ToBuf(m.data);
          }
          const a: any = await window.api.examAssessSpeech(
            childId,
            `recite-${q.qid}.wav`,
            buf,
            q.questionType!,
            q.refText || "",
            { isExam: true }
          );
          if (!a?.success) throw new Error(a?.error || "发音评测失败");
          const sp: SpeechAssessment = a.data.result;
          const pointGot = Math.round((sp.pron / 100) * (Number(q.pointMax) || 10));
          return {
            qid: q.qid,
            pointGot,
            pointMax: Number(q.pointMax) || 10,
            correct: (sp.pron ?? 0) >= 60,
            aiComment: `发音 ${Math.round(sp.pron ?? 0)} 分（完整度 ${Math.round(sp.integrity ?? 0)} / 准确 ${Math.round(sp.accuracy ?? 0)} / 流利 ${Math.round(sp.fluency?.overall ?? 0)}）`,
            audioFileId: a.data.audioFileId,
            speech: sp,
          };
        })
      );

      // 3) 组装每题（合并 LLM 文字题 + SSECP 口语题），本地算总分
      const textGotByQid = new Map((scored?.perQuestion ?? []).map((x) => [x.qid, x]));
      const speechGotByQid = new Map(speechResult.map((x) => [x.qid, x]));
      let score = 0;
      const perQuestion: ScoredResult["perQuestion"] = payload.perQuestion.map((q) => {
        if (isSpeech(q)) {
          const g = speechGotByQid.get(q.qid)!;
          score += g.pointGot;
          return {
            qid: q.qid,
            pointGot: g.pointGot,
            correct: g.correct,
            aiComment: g.aiComment,
            question: q.stem,
            asrText: "",
            assessMethod: "speech" as const,
            questionType: q.questionType!,
            refText: q.refText || "",
            audioFileId: g.audioFileId,
            speech: g.speech,
          };
        }
        const g = textGotByQid.get(q.qid);
        score += g?.pointGot ?? 0;
        return {
          qid: q.qid,
          pointGot: g?.pointGot ?? 0,
          correct: !!g?.correct,
          aiComment: g?.aiComment || "",
          question: q.stem,
          asrText: q.asr || "",
          audioFileId: undefined,
          speech: undefined,
        };
      });
      const wrongQuestions = perQuestion.filter((x) => !x.correct).map((x) => x.qid);

      // 4) 上报服务端：仅文字题语音走 files 通道（口语题语音已由 examAssessSpeech 上传拿到 audioFileId）
      const voices: Array<{ qid: string; buffer: ArrayBuffer; name: string }> = [];
      for (const q of textQs) {
        const segs: string[] = Array.isArray(q.audioB64s) ? q.audioB64s : [];
        if (!segs.length) continue;
        if (segs.length === 1) {
          voices.push({ qid: q.qid, buffer: b64ToBuf(segs[0]), name: `voice-${q.qid}.webm` });
        } else {
          const m: any = await window.api.voiceMerge(childId, segs.map(plainB64));
          if (!m?.success || !m.data) throw new Error(`合并语音失败：${m?.error || ""}`);
          voices.push({ qid: q.qid, buffer: b64ToBuf(m.data), name: `voice-${q.qid}.wav` });
        }
      }
      const attempt = {
        childId,
        topic: currentSchedule.kind === "custom" ? String(currentSchedule.scope?.note || "") : currentSchedule.freq,
        title: `${currentSchedule.title} · ${new Date().toLocaleDateString("zh-CN")}`,
        startedAt: new Date(currentSchedule.scheduledAt || Date.now()).toISOString(),
        submittedAt: payload.submittedAt || new Date().toISOString(),
        score,
        perQuestion,
        courseMastery: scored?.courseMastery || {},
        reinforcePlan: scored?.reinforcePlan || {},
        wrongQuestions,
        scheduleId: currentSchedule.id,
      };
      const sub: any = await window.api.examSubmit(attempt, voices);
      if (!sub?.success) throw new Error(sub?.error || "提交失败");
      const attemptId = sub.data?.id || "";
      await window.api.examScheduleComplete(currentSchedule.id, attemptId).catch(() => undefined);

      setReport({
        perQuestion,
        courseMastery: scored?.courseMastery || {},
        reinforcePlan: scored?.reinforcePlan || {},
        score,
        overall: scored?.overall || "",
      });
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
        {/* 常驻返回：pick/error/report 都可退出；exam（锁定）与 scoring（处理中）不显示 */}
        {stage !== "exam" && stage !== "scoring" && (
          <button
            onClick={onExit}
            style={{
              background: "#f0f2f5",
              border: "none",
              borderRadius: 8,
              padding: "6px 14px",
              fontSize: 13,
              fontWeight: 600,
              color: "#333",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            ← 返回
          </button>
        )}
        <span style={{ fontWeight: 700, fontSize: 16 }}>🎯 学习考核</span>
        {currentSchedule && stage !== "pick" && (
          <span
            style={{
              color: "#fff",
              background: "#3b6ef5",
              borderRadius: 999,
              padding: "2px 12px",
              fontSize: 12,
            }}
          >
            {currentSchedule.title}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {stage === "exam" && (
          <span style={{ color: "#b9770a", fontSize: 13 }}>🔒 考核进行中，不可退出</span>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {stage === "pick" && (
          <div style={{ padding: 24, maxWidth: 720, margin: "0 auto" }}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>考核安排</div>
            <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
              到达考核日期就可以开始，全天可随时考。点「开始这次考核」进入锁定考核，中途不能退出。
            </p>
            {schedules.length === 0 && (
              <p style={{ color: "#888", fontSize: 13 }}>
                今天没有考核安排。固定考核会在设定的考核日期自动出现；如果想让爸爸妈妈临时安排一次，可以请他们在家长助手里说「周五考论语的乡党篇」。
              </p>
            )}
            {schedules.map((sch) => {
              // pending（已到日期）或 started（上次开始后中断/出卷失败）都可重新开始
              const overdue = sch.pending || sch.status === "started";
              return (
                <div
                  key={sch.id}
                  style={{
                    background: "#fff",
                    border: overdue ? "2px solid #f2994a" : "1px solid #e6eaf0",
                    borderRadius: 12,
                    padding: "14px 16px",
                    marginBottom: 10,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                  }}
                >
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      {sch.title}
                      {sch.kind === "custom" && (
                        <span
                          style={{
                            marginLeft: 8,
                            fontSize: 11,
                            background: "#eef2ff",
                            color: "#3b4cca",
                            borderRadius: 999,
                            padding: "1px 8px",
                          }}
                        >
                          自定义
                        </span>
                      )}
                    </div>
                    <div style={{ color: "#6b7686", fontSize: 12, marginTop: 2 }}>
                      {fmtTime(sch.scheduledAt)}
                      {sch.freq ? ` · ${FREQ_LABEL[sch.freq] || sch.freq}考核` : ""}
                      {sch.status === "done" && " · 已完成"}
                      {overdue && (
                        <span style={{ color: "#b9770a", fontWeight: 600 }}>
                          {sch.status === "started" ? " · 可继续" : " · 可开始"}
                        </span>
                      )}
                    </div>
                    {sch.scope?.note && (
                      <div style={{ color: "#888", fontSize: 12, marginTop: 2 }}>内容：{String(sch.scope.note)}</div>
                    )}
                  </div>
                  {overdue ? (
                    <button style={{ ...btn, background: "#f2994a", color: "#fff", padding: "8px 18px" }} onClick={() => startExam(sch)}>
                      开始这次考核
                    </button>
                  ) : sch.status === "done" ? (
                    <span style={{ color: "#27ae60", fontSize: 13, fontWeight: 600 }}>✓ 已完成</span>
                  ) : (
                    <span style={{ color: "#aaa", fontSize: 12 }}>未到时间</span>
                  )}
                </div>
              );
            })}
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
            // allow-same-origin 必须有：srcDoc iframe 无它将是不透明源（非安全上下文），
            // navigator.mediaDevices.getUserMedia 抛 "invalid security origin"，语音无法用
            sandbox="allow-scripts allow-modals allow-forms allow-same-origin"
            allow="microphone"
            style={{ width: "100%", height: "100%", border: "none", background: "#fff" }}
            title="学习考核"
            onLoad={() => {
              // iframe 脚本就绪后开始流式出题（首门课题目送达即开始作答，其余后台逐门追加）
              if (streamStartedRef.current) return;
              const plan = streamPlanRef.current;
              if (!plan) return;
              streamStartedRef.current = true;
              beginStreaming(plan).catch((e) => {
                console.error("[exam] 流式出题启动失败", e);
              });
            }}
          />
        )}

        {stage === "scoring" && (
          <div style={{ display: "flex", height: "100%", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12 }}>
            <div style={{ fontSize: 40 }}>⏳</div>
            <div style={{ fontSize: 16, fontWeight: 600 }}>{prepText || "老师正在批改你的回答…"}</div>
            <div style={{ color: "#6b7686", fontSize: 13 }}>{stage === "exam" ? "" : "请稍等，不要关闭窗口"}</div>
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
                  {q.assessMethod === "speech" && q.audioFileId && (
                    <div style={{ marginTop: 6 }}>
                      <button
                        onClick={async () => {
                          if (!speechAudio[q.audioFileId!]) {
                            try {
                              const r: any = await window.api.examAudio(q.audioFileId!);
                              if (r?.success && r.data) {
                                setSpeechAudio((p) => ({ ...p, [q.audioFileId!]: r.data }));
                              }
                            } catch {
                              /* 静默 */
                            }
                          }
                        }}
                        style={{ ...btn, padding: "4px 12px", fontSize: 13, background: "#eef2ff", color: "#3b6ef5" }}
                      >
                        🔊 听我的背诵
                      </button>
                      {speechAudio[q.audioFileId] && (
                        <audio
                          key={q.audioFileId}
                          src={speechAudio[q.audioFileId]}
                          controls
                          autoPlay
                          style={{ height: 32, marginTop: 6, width: "100%", maxWidth: 320 }}
                        />
                      )}
                    </div>
                  )}
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
            <button style={{ ...btn, background: "#3b6ef5", color: "#fff" }} onClick={() => { setStage("pick"); loadSchedules(); }}>
              返回
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

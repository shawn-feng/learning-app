/**
 * 家长端 · 学习考核记录（EXAM-REQUIREMENTS.md §8/§9）：
 * - 每课程考核记录表：最近考核时间 / 掌握情况（正确率）/ 错题难点 / 亮点 / 计划复习时间 / 计划复习重点；
 * - 最近考核明细：逐题得分 + AI 评语 + ASR 转写 + ▶ 听原音（原始录音，家长可核对判分）。
 */
import { useEffect, useState } from "react";

interface CourseRecord {
  course: string;
  attempts: number;
  lastAssessAt: string;
  correct: number;
  total: number;
  rate: number;
  difficulties: string[];
  highlights: string[];
  planReviewAt: string;
  focus: string[];
}

interface AttemptPerQuestion {
  qid: string;
  course: string;
  question: string;
  audioFileId?: string;
  asrText: string;
  durationMs?: number;
  pointGot: number;
  pointMax: number;
  correct: boolean;
  aiComment: string;
}

interface Attempt {
  id: string;
  topic: string;
  title: string;
  submittedAt: string;
  score: number;
  perQuestion: AttemptPerQuestion[];
  courseMastery: Record<string, { correct: number; total: number; rate: number }>;
  reinforcePlan: Record<string, { planReviewAt: string; focus: string[]; aiSuggestion?: string }>;
}

export default function ExamRecords({ childId }: { childId: string }) {
  const [records, setRecords] = useState<CourseRecord[]>([]);
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [msg, setMsg] = useState("");
  const [audioSrc, setAudioSrc] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [r, a] = await Promise.all([
          (window.api.examCourseRecords(childId) as Promise<any>).catch(() => ({ success: false })),
          (window.api.examAttempts(childId) as Promise<any>).catch(() => ({ success: false })),
        ]);
        if (!alive) return;
        if (r?.success) setRecords(r.data || []);
        if (a?.success) setAttempts(a.data || []);
        if ((!r?.success || !a?.success)) {
          const e = r?.error || a?.error;
          if (e) setMsg(`加载失败：${e}`);
        }
        if (!r?.success && !a?.success) setMsg("暂无考核记录（孩子还没参加过考核）");
      } catch (e: any) {
        if (alive) setMsg(String(e?.message || e));
      }
    })();
    return () => { alive = false; };
  }, [childId]);

  async function playAudio(fileId: string, qid: string) {
    if (playing === qid) { setPlaying(null); return; }
    try {
      const r: any = await window.api.examAudio(fileId);
      if (r?.success) {
        setAudioSrc((prev) => ({ ...prev, [qid]: r.data }));
        setPlaying(qid);
      } else {
        setMsg(`语音加载失败：${r?.error || ""}`);
      }
    } catch (e: any) {
      setMsg(`语音加载失败：${String(e?.message || e)}`);
    }
  }

  const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }).slice(0, 16) : "—");
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>🎯 学习考核记录</div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
        每课程掌握情况来自历次考核逐题聚合；语音为原始录音（ASR 可能出错，可听原音核对判分）。数据在服务端，跨设备可见。
      </p>
      {msg && <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>{msg}</div>}

      {/* 每课程考核记录表 */}
      <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16, marginBottom: 16, overflowX: "auto" }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>📋 每课程考核记录表</div>
        {records.length === 0 ? (
          <div style={{ color: "#aaa", fontSize: 13 }}>暂无数据</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, minWidth: 760 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#888" }}>
                <th style={{ padding: "6px 8px" }}>课程</th>
                <th style={{ padding: "6px 8px" }}>最近考核</th>
                <th style={{ padding: "6px 8px" }}>掌握情况</th>
                <th style={{ padding: "6px 8px" }}>错题难点</th>
                <th style={{ padding: "6px 8px" }}>亮点</th>
                <th style={{ padding: "6px 8px" }}>计划复习时间</th>
                <th style={{ padding: "6px 8px" }}>计划复习重点</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.course} style={{ borderTop: "1px solid #f0f0f0", verticalAlign: "top" }}>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{r.course}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{fmtDate(r.lastAssessAt)}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>
                    <span style={{ color: r.rate >= 0.6 ? "#2f8a52" : "#c0392b", fontWeight: 700 }}>{pct(r.rate)}</span>
                    <span style={{ color: "#999" }}>（{r.correct}/{r.total}）</span>
                  </td>
                  <td style={{ padding: "6px 8px", color: "#b03a2e", maxWidth: 220 }}>{r.difficulties.join("；") || "—"}</td>
                  <td style={{ padding: "6px 8px", color: "#2f8a52", maxWidth: 220 }}>{r.highlights.join("；") || "—"}</td>
                  <td style={{ padding: "6px 8px", whiteSpace: "nowrap" }}>{r.planReviewAt || "—"}</td>
                  <td style={{ padding: "6px 8px", maxWidth: 240 }}>{r.focus.join("；") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 最近考核明细 */}
      <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>🕐 最近考核明细</div>
        {attempts.length === 0 ? (
          <div style={{ color: "#aaa", fontSize: 13 }}>暂无数据</div>
        ) : (
          attempts.map((at) => (
            <div key={at.id} style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: 12, marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{at.title}</span>
                <span style={{ fontSize: 14, fontWeight: 800, color: at.score >= 60 ? "#2f8a52" : "#c0392b" }}>{at.score} 分</span>
                <span style={{ fontSize: 11, color: "#999" }}>{fmtDate(at.submittedAt)}</span>
              </div>
              {at.perQuestion.map((q, i) => (
                <div key={q.qid} style={{ padding: "6px 0", borderTop: "1px solid #f6f6f6", fontSize: 12 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>
                      第 {i + 1} 题 · {q.course}
                    </span>
                    <span style={{ color: q.correct ? "#2f8a52" : "#c0392b", fontWeight: 700 }}>
                      {q.correct ? "✓" : "✗"} {q.pointGot}/{q.pointMax}
                    </span>
                    {q.audioFileId && (
                      <button
                        onClick={() => playAudio(q.audioFileId!, q.qid)}
                        style={{
                          border: "1px solid #ddd",
                          background: playing === q.qid ? "#eef0ff" : "#fff",
                          borderRadius: 6,
                          padding: "2px 10px",
                          fontSize: 12,
                          cursor: "pointer",
                          color: "#5a67d8",
                        }}
                      >
                        {playing === q.qid ? "⏹ 停止" : "▶ 听原音"}
                      </button>
                    )}
                    {q.durationMs != null && (
                      <span style={{ color: "#aaa", fontSize: 11 }}>用时 {Math.round(q.durationMs / 1000)}s</span>
                    )}
                  </div>
                  {q.question && <div style={{ color: "#666", marginTop: 2 }}>问：{q.question}</div>}
                  {q.asrText && (
                    <div style={{ color: "#555", marginTop: 2 }}>
                      答：<span style={{ background: "#f4f7ff", padding: "1px 6px", borderRadius: 4 }}>{q.asrText}</span>
                    </div>
                  )}
                  {q.aiComment && <div style={{ color: "#888", marginTop: 2 }}>评语：{q.aiComment}</div>}
                  {audioSrc[q.qid] && playing === q.qid && (
                    <audio controls autoPlay src={audioSrc[q.qid]} style={{ width: "100%", marginTop: 6 }} />
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

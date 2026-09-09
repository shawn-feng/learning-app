/**
 * 家长端 · 孩子考核记录（2026-09-09 改版）：
 * 左右布局——左侧为该孩子**已完成考核**列表（不含未进行的计划，计划请看「学习考核」页）；
 * 点击某一次考核，右侧显示该次详情（总分 / 时间 / 逐题得分与评语 / ASR / 原音回放 / 口语维度分）。
 */
import { useEffect, useState } from "react";
import type { SpeechAssessment } from "../../electron/lib/exam";

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
  assessMethod?: "speech";
  questionType?: string;
  refText?: string;
  speech?: SpeechAssessment;
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

function speechColor(s: number): string {
  return s >= 80 ? "#2f8a52" : s >= 60 ? "#b9770a" : "#c0392b";
}

/** 口语/听说题评测明细：维度分 + 逐字/逐词高亮（绿=好，红=需改进）。 */
function SpeechDetail({ speech, questionType, refText }: { speech: SpeechAssessment; questionType?: string; refText?: string }) {
  const dims: Array<[string, number | undefined]> = [
    ["发音", speech.pron],
    ["完整度", speech.integrity],
    ["准确度", speech.accuracy],
    ["流利度", speech.fluency?.overall],
    ["韵律", speech.prosody?.overall],
  ];
  const isCn = (questionType || "").startsWith("cn");
  return (
    <div style={{ marginTop: 6, background: "#f7f9ff", border: "1px solid #e6ecff", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#3b4cca", marginBottom: 6 }}>🎤 发音评测维度</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        {dims
          .filter(([, v]) => v != null)
          .map(([label, v]) => (
            <div key={label} style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#888" }}>{label}</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: speechColor(v!) }}>{Math.round(v!)}</span>
            </div>
          ))}
      </div>
      {speech.cnSyllables?.length ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>逐字评分（绿=好，红=需改进）</div>
          <div style={{ lineHeight: 1.9, fontSize: 18, letterSpacing: 2 }}>
            {speech.cnSyllables.map((sy, k) => (
              <span key={k} title={`${sy.char} ${Math.round(sy.score)}分`} style={{ color: speechColor(sy.score), fontWeight: 600 }}>
                {sy.char}
              </span>
            ))}
          </div>
        </div>
      ) : speech.words?.length ? (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#888", marginBottom: 4 }}>逐词评分</div>
          <div style={{ lineHeight: 1.9, fontSize: 14 }}>
            {speech.words.map((w, k) => (
              <span key={k} title={`${w.word} ${Math.round(w.score)}分`} style={{ color: speechColor(w.score), marginRight: 8 }}>
                {w.word}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {isCn && refText ? <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>原文：{refText}</div> : null}
    </div>
  );
}

const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }).slice(0, 16) : "—");

export default function ExamRecords({ childId }: { childId: string }) {
  const [attempts, setAttempts] = useState<Attempt[]>([]);
  const [selId, setSelId] = useState<string>("");
  const [msg, setMsg] = useState("");
  const [audioSrc, setAudioSrc] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const a: any = await (window.api.examAttempts(childId) as Promise<any>).catch(() => ({ success: false }));
        if (!alive) return;
        if (a?.success && Array.isArray(a.data) && a.data.length) {
          setAttempts(a.data);
          setSelId((p) => p || String(a.data[0].id || ""));
        } else {
          setMsg("还没有完成的考核记录。");
        }
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
      setMsg(`语音加载失败：${String((e as Error)?.message || e)}`);
    }
  }

  const cur = attempts.find((x) => x.id === selId) || null;
  const maxScore = cur?.perQuestion.reduce((s, q) => s + (Number(q.pointMax) || 0), 0) || cur?.score || 0;

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>🎯 考核记录（已完成）</div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
        左侧为历次已完成的考核；点击查看该次得分与逐题详情。进行中的考核计划请到「学习考核」页查看。
      </p>
      {msg && <div style={{ fontSize: 12, color: "#888", marginBottom: 10 }}>{msg}</div>}

      <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
        {/* 左：已完成考核列表 */}
        <div style={{ width: 300, flexShrink: 0, background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 12, maxHeight: 560, overflowY: "auto" }}>
          {attempts.length === 0 ? (
            <div style={{ color: "#aaa", fontSize: 13 }}>暂无数据</div>
          ) : (
            attempts.map((at) => {
              const active = at.id === selId;
              return (
                <button
                  key={at.id}
                  onClick={() => { setSelId(at.id); setPlaying(null); }}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    background: active ? "#eef2ff" : "#fff",
                    border: active ? "2px solid #667eea" : "1px solid #e6eaf0",
                    borderRadius: 10,
                    padding: "10px 12px",
                    marginBottom: 8,
                    cursor: "pointer",
                    fontFamily: "inherit",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>{at.title}</div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 2, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 15, fontWeight: 800, color: at.score >= 60 ? "#2f8a52" : "#c0392b" }}>{at.score} 分</span>
                    <span style={{ fontSize: 11, color: "#999" }}>{fmtDate(at.submittedAt)}</span>
                  </div>
                  {at.perQuestion?.length ? (
                    <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 2 }}>
                      {at.perQuestion.length} 题 · 对 {at.perQuestion.filter((q) => q.correct).length}
                    </div>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {/* 右：选中考核详情 */}
        <div style={{ flex: 1, minWidth: 0, background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
          {!cur ? (
            <div style={{ color: "#aaa", fontSize: 13 }}>选择左侧一次考核查看详情</div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap", marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{cur.title}</span>
                <span style={{ fontSize: 22, fontWeight: 800, color: cur.score >= 60 ? "#2f8a52" : "#c0392b" }}>
                  {cur.score} / {maxScore || "—"} 分
                </span>
                <span style={{ fontSize: 12, color: "#999" }}>提交于 {fmtDate(cur.submittedAt)}</span>
              </div>
              {Object.keys(cur.courseMastery || {}).length > 0 && (
                <div style={{ margin: "6px 0 12px", display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {Object.entries(cur.courseMastery).map(([course, cm]) => (
                    <span key={course} style={{ fontSize: 12, background: "#fff", border: "1px solid #e6eaf0", borderRadius: 999, padding: "2px 10px" }}>
                      {course}：对 {cm.correct}/{cm.total}（{Math.round((cm.rate || 0) * 100)}%）
                    </span>
                  ))}
                </div>
              )}
              {cur.perQuestion.map((q, i) => (
                <div key={q.qid} style={{ padding: "8px 0", borderTop: "1px solid #eee", fontSize: 12.5 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 600 }}>第 {i + 1} 题 · {q.course}</span>
                    <span style={{ color: q.correct ? "#2f8a52" : "#c0392b", fontWeight: 700 }}>
                      {q.correct ? "✓" : "✗"} {q.pointGot}/{q.pointMax}
                    </span>
                    {q.assessMethod === "speech" && (
                      <span style={{ fontSize: 11, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 8px" }}>背诵/口语</span>
                    )}
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
                    {q.durationMs != null && <span style={{ color: "#aaa", fontSize: 11 }}>用时 {Math.round(q.durationMs / 1000)}s</span>}
                  </div>
                  {q.question && <div style={{ color: "#666", marginTop: 3 }}>问：{q.question}</div>}
                  {q.asrText && (
                    <div style={{ color: "#555", marginTop: 3 }}>
                      答：<span style={{ background: "#f4f7ff", padding: "1px 6px", borderRadius: 4 }}>{q.asrText}</span>
                    </div>
                  )}
                  {q.aiComment && <div style={{ color: "#888", marginTop: 3 }}>评语：{q.aiComment}</div>}
                  {q.assessMethod === "speech" && q.speech && (
                    <SpeechDetail speech={q.speech} questionType={q.questionType} refText={q.refText} />
                  )}
                  {audioSrc[q.qid] && playing === q.qid && (
                    <audio controls autoPlay src={audioSrc[q.qid]} style={{ width: "100%", marginTop: 6 }} />
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

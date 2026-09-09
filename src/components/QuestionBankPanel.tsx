import { useState, useEffect } from "react";

/**
 * 家长「题库」：全部考核题目。左=题目列表（可关键字过滤），右=题目详情 + 各孩子最近一次考核记录。
 */
const BEHAVIOR_LABEL: Record<string, string> = {
  speech_recite: "背诵评测",
  speech_read: "朗读跟读",
  generic: "口述主观题",
};

function fmtScoreLines(scoring: string | null): string[] {
  if (!scoring) return [];
  try {
    const j = JSON.parse(scoring);
    const out: string[] = [];
    if (Array.isArray(j?.dims)) {
      for (const d of j.dims) {
        out.push(`- ${d?.dim || ""}（${d?.score ?? "?"}分）：${d?.points || ""}${d?.note ? `（${d.note}）` : ""}`);
      }
    }
    if (Array.isArray(j?.special) && j.special.length) out.push(`⚠ ${j.special.join("；")}`);
    return out;
  } catch {
    return [scoring];
  }
}
function fmtDT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Row {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null;
  pointMax: number;
  behavior: string;
  note: string;
  knowledgeSummary: string;
  contexts: Array<{ topic: string; course: string; category: string }>;
}
interface RecRow {
  childId: string;
  childName: string;
  attemptId: string | null;
  submittedAt: string | null;
  pointGot: number | null;
  pointMax: number | null;
  correct: boolean;
  aiComment: string;
  neverAssessed?: boolean;
}

export default function QuestionBankPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [qId, setQId] = useState<string | null>(null);
  const [records, setRecords] = useState<RecRow[] | null>(null);
  const [recLoading, setRecLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r: any = await window.api.assessQuestionList();
        if (r?.success && Array.isArray(r.data)) setRows(r.data);
      } catch {
        /* 忽略 */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function pick(q: Row) {
    setQId(q.id);
    setRecords(null);
    setRecLoading(true);
    try {
      const r: any = await window.api.assessQuestionRecords(q.id);
      if (r?.success) setRecords(r.data || []);
    } catch {
      setRecords([]);
    } finally {
      setRecLoading(false);
    }
  }

  const kw = filter.trim().toLowerCase();
  const shown = kw
    ? rows.filter(
        (r) =>
          r.stem.toLowerCase().includes(kw) ||
          r.answer.toLowerCase().includes(kw) ||
          r.behavior.includes(kw) ||
          (r.note || "").toLowerCase().includes(kw) ||
          r.contexts.some((c) => c.category.includes(kw) || c.course.toLowerCase().includes(kw) || c.topic.toLowerCase().includes(kw))
      )
    : rows;
  const sel = rows.find((r) => r.id === qId) || null;

  return (
    <div>
      <h3 style={{ marginBottom: 4 }}>📖 题库</h3>
      <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
        共 {rows.length} 道题（含各课挂载与复用的题目）· 点左侧题目看详情与各孩子最近一次考核记录
      </p>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="搜索题干 / 答案 / 类别 / 课程…"
        style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: "1px solid #ddd", fontSize: 13, marginBottom: 10, boxSizing: "border-box" }}
      />
      {loading ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载题库…</p>
      ) : shown.length === 0 ? (
        <p style={{ color: "#aaa", fontSize: 13 }}>暂无题目（或没有匹配的题目）</p>
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
          <div style={{ width: "42%", minWidth: 280, border: "1px solid #eee", borderRadius: 8, padding: 6, maxHeight: 560, overflow: "auto", boxSizing: "border-box" }}>
            {shown.map((q, i) => (
              <div
                key={q.id}
                onClick={() => pick(q)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: qId === q.id ? "1px solid #667eea" : "1px solid transparent",
                  background: qId === q.id ? "#f0f4ff" : "transparent",
                  fontSize: 12.5,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ color: "#333" }}>
                  <b>{i + 1}.</b> {String(q.stem).slice(0, 66)}
                  {String(q.stem).length > 66 ? "…" : ""}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 11, color: "#9aa3b2", flexWrap: "wrap" }}>
                  <span style={{ color: q.behavior === "generic" ? "#556" : "#3b4cca" }}>{BEHAVIOR_LABEL[q.behavior] || q.behavior}</span>
                  <span>{q.pointMax || 10} 分</span>
                  {q.contexts[0] && <span>{q.contexts[0].course}</span>}
                  {q.contexts.length > 1 && <span>等 {q.contexts.length} 处</span>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {!sel ? (
              <p style={{ color: "#999", fontSize: 12, paddingTop: 8 }}>← 选择左侧题目查看详情与该题考核记录</p>
            ) : (
              <div>
                <div style={{ fontSize: 14, lineHeight: 1.5, color: "#222", fontWeight: 600, marginBottom: 6 }}>{sel.stem}</div>
                <div style={{ fontSize: 11, color: "#667eea", marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <span>{BEHAVIOR_LABEL[sel.behavior] || sel.behavior}</span>
                  <span>{sel.pointMax || 10} 分</span>
                  {sel.contexts.map((c, ci) => (
                    <span key={ci}>
                      {c.course}（{c.category}）
                    </span>
                  ))}
                </div>
                {sel.answer ? (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: "#6b7686" }}>参考答案：</div>
                    <div style={{ fontSize: 13, color: "#2f8a52", background: "#f4faf6", padding: "6px 10px", borderRadius: 6, whiteSpace: "pre-wrap" }}>{sel.answer}</div>
                  </div>
                ) : null}
                {fmtScoreLines(sel.scoring).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: "#6b7686" }}>评分标准：</div>
                    <div style={{ fontSize: 12, background: "#faf8f4", padding: "6px 10px", borderRadius: 6, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                      {fmtScoreLines(sel.scoring).join("\n")}
                    </div>
                  </div>
                )}
                {sel.note ? (
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <b style={{ color: "#6b7686" }}>备注：</b>
                    <span style={{ color: "#556" }}>{sel.note}</span>
                  </div>
                ) : null}
                {sel.knowledgeSummary ? (
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <b style={{ color: "#6b7686" }}>知识点概要：</b>
                    <span style={{ color: "#556" }}>{sel.knowledgeSummary}</span>
                  </div>
                ) : null}

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>各孩子考核记录（最近一次）</div>
                  {recLoading ? (
                    <span style={{ color: "#999", fontSize: 12 }}>加载中…</span>
                  ) : records === null ? null : (
                    <div style={{ borderTop: "1px solid #f0f0f0" }}>
                      {records.length === 0 ? (
                        <span style={{ color: "#aaa", fontSize: 12 }}>暂无记录（这道题还没被考过）</span>
                      ) : (
                        records.map((r: RecRow) => (
                          <div key={r.childId} style={{ padding: "8px 2px", borderBottom: "1px solid #f3f3f3", fontSize: 12, lineHeight: 1.55 }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                              <b>{r.childName || "孩子"}</b>
                              {r.neverAssessed ? (
                                <span style={{ color: "#aaa", fontSize: 11 }}>还没考过</span>
                              ) : (
                                <>
                                  <span style={{ color: "#9aa3b2", fontSize: 11 }}>{fmtDT(r.submittedAt)}</span>
                                  <span style={{ fontWeight: 700, color: r.correct ? "#2f8a52" : "#b33" }}>
                                    {r.pointGot != null ? `${r.pointGot}/${r.pointMax ?? "?"}` : "—"} {r.correct ? "✓ 对" : "✗ 错"}
                                  </span>
                                </>
                              )}
                            </div>
                            {!r.neverAssessed && r.aiComment ? <div style={{ color: "#556", marginTop: 2 }}>{r.aiComment}</div> : null}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

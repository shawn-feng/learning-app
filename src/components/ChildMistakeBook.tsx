/**
 * 家长端·孩子错题本 tab（ISSUE-114）：孩子管理里直接查看孩子的错题/生字/薄弱点档案。
 * 与孩子端 MistakeBookModal 的差异：家长视角只读为主——不提供「会了」（掌握要孩子自己验证），
 * 仅可「不算了」（dismiss，记错/重复）与「重新打开」；顶部给概览统计（open 数/本周新增）。
 */
import { useCallback, useEffect, useState } from "react";

interface MistakeItem {
  id: string;
  kind: "wrong_question" | "unknown_word" | "weak_point";
  content: string;
  detail: string;
  source: string;
  course_ref: string;
  knowledge_point_name: string;
  count: number;
  status: "open" | "mastered" | "dismissed";
  first_seen: string;
  last_seen: string;
}

const KIND_META: Record<string, { label: string; icon: string }> = {
  wrong_question: { label: "错题", icon: "✗" },
  unknown_word: { label: "生字词", icon: "字" },
  weak_point: { label: "薄弱点", icon: "⚡" },
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e6eaf0",
  borderRadius: 10,
  padding: "10px 14px",
  marginBottom: 8,
};
const btn: React.CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "5px 12px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const fmtDay = (iso: string) => String(iso ?? "").slice(0, 10);

/** 本周新增：first_seen 在最近 7 天内 */
function isNewThisWeek(firstSeen: string): boolean {
  const t = Date.parse(String(firstSeen ?? ""));
  if (!Number.isFinite(t)) return false;
  return Date.now() - t < 7 * 24 * 3600 * 1000;
}

export default function ChildMistakeBook({ childId }: { childId: string }) {
  const [items, setItems] = useState<MistakeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    setError("");
    const r = await window.api.mistakesList({ childId, limit: 200 });
    if (r?.success) {
      setItems((r.data?.mistakes as MistakeItem[]) || []);
    } else {
      setError(String(r?.error || (r?.data as any)?.error || "读取失败"));
    }
    setLoading(false);
  }, [childId]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (id: string, action: "dismiss" | "reopen") => {
    setBusy(id);
    setNotice("");
    try {
      const r = await window.api.mistakeAction({ childId, id, action });
      if (r?.success && (r.data as any)?.ok) {
        setNotice(action === "dismiss" ? "已标记忽略，不再出现在复习里。" : "已重新打开。");
        await load();
      } else {
        setNotice(String((r?.data as any)?.error || r?.error || "操作失败"));
      }
    } catch (e: any) {
      setNotice(String(e?.message || e));
    } finally {
      setBusy(null);
    }
  };

  const open = items.filter((m) => m.status === "open");
  const closed = items.filter((m) => m.status !== "open");
  const mastered = items.filter((m) => m.status === "mastered").length;
  const newThisWeek = items.filter((m) => isNewThisWeek(m.first_seen)).length;
  const groups: Array<[string, MistakeItem[]]> = [
    ["wrong_question", open.filter((m) => m.kind === "wrong_question")],
    ["unknown_word", open.filter((m) => m.kind === "unknown_word")],
    ["weak_point", open.filter((m) => m.kind === "weak_point")],
  ];

  const stat: React.CSSProperties = {
    flex: 1,
    background: "#fff",
    border: "1px solid #e6eaf0",
    borderRadius: 10,
    padding: "8px 12px",
    textAlign: "center",
  };

  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>错题本</div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
        孩子学习中的漏洞档案：对话里说的错题、查过的生字词、考核错题会自动记到这里，AI 老师会在教学中带他复习。
        「已掌握」由孩子自己验证关闭，家长只能把记错/重复的条目标记忽略。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <div style={stat}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#b33" }}>{open.length}</div>
          <div style={{ fontSize: 11, color: "#8a94a6" }}>待掌握</div>
        </div>
        <div style={stat}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#c07f00" }}>{newThisWeek}</div>
          <div style={{ fontSize: 11, color: "#8a94a6" }}>本周新增</div>
        </div>
        <div style={stat}>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#1d7a3d" }}>{mastered}</div>
          <div style={{ fontSize: 11, color: "#8a94a6" }}>已掌握</div>
        </div>
      </div>

      {notice && (
        <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 8, background: "#eefaf0", color: "#1d7a3d", fontSize: 13 }}>
          {notice}
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 8, background: "#fdf0f0", color: "#b33", fontSize: 13 }}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={{ textAlign: "center", color: "#8a94a6", padding: "20px 0" }}>读取中…</p>
      ) : !items.length ? (
        <p style={{ textAlign: "center", color: "#8a94a6", padding: "24px 0" }}>
          还没有记录。孩子学习中有做错的题、不认识的字时，AI 老师会帮他记到这里。
        </p>
      ) : (
        <>
          {groups.map(([kind, list]) =>
            list.length ? (
              <div key={kind}>
                <h4 style={{ margin: "10px 0 8px", fontSize: 13, color: "#4a5265" }}>
                  {KIND_META[kind].label}（{list.length}）
                </h4>
                {list.map((m) => (
                  <div key={m.id} style={card}>
                    <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                      <span
                        style={{
                          flexShrink: 0,
                          width: 32,
                          height: 32,
                          borderRadius: 10,
                          background: "#eef2ff",
                          color: "#3b4cca",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: m.kind === "unknown_word" ? 18 : 14,
                          fontWeight: 700,
                          fontFamily: m.kind === "unknown_word" ? "inherit" : "monospace",
                        }}
                      >
                        {KIND_META[m.kind]?.icon ?? "•"}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{m.content}</div>
                        {m.detail && (
                          <div style={{ fontSize: 12, color: "#5a6478", marginTop: 3, lineHeight: 1.5 }}>{m.detail}</div>
                        )}
                        <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                          <span>
                            {KIND_META[m.kind]?.label ?? m.kind}
                            {m.count > 1 ? ` · 出现 ${m.count} 次` : ""} · 首记 {fmtDay(m.first_seen)} · 最近 {fmtDay(m.last_seen)}
                            {m.source === "exam" ? " · 来自考核" : m.source === "lookup" ? " · 来自查词" : m.source === "conversation" ? " · 对话记录" : ""}
                          </span>
                          {m.course_ref && <span style={{ background: "#f0f2f7", borderRadius: 6, padding: "1px 6px" }}>{m.course_ref}</span>}
                          {m.knowledge_point_name && (
                            <span style={{ background: "#f0f7ff", color: "#2b6cb0", borderRadius: 6, padding: "1px 6px" }}>{m.knowledge_point_name}</span>
                          )}
                        </div>
                      </div>
                      <button
                        style={{ ...btn, flexShrink: 0, background: "#f0f2f7", color: "#5a6478" }}
                        disabled={busy === m.id}
                        onClick={() => act(m.id, "dismiss")}
                      >
                        不算了
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : null
          )}
          {!open.length && (
            <p style={{ textAlign: "center", color: "#1d7a3d", padding: "12px 0", fontSize: 13 }}>
              🎉 当前没有待掌握的条目
            </p>
          )}
          {closed.length > 0 && (
            <>
              <h4
                style={{ margin: "14px 0 8px", fontSize: 13, color: "#8a94a6", cursor: "pointer" }}
                onClick={() => setShowClosed((v) => !v)}
              >
                已关闭（{closed.length}）{showClosed ? "▲" : "▼"}
              </h4>
              {showClosed &&
                closed.map((m) => (
                  <div key={m.id} style={{ ...card, opacity: 0.7, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{m.content}</span>
                    <span style={{ fontSize: 11, color: "#8a94a6" }}>
                      {KIND_META[m.kind]?.label ?? m.kind} · {m.status === "mastered" ? "已掌握" : "已忽略"} · 最近 {fmtDay(m.last_seen)}
                    </span>
                    <button
                      style={{ ...btn, marginLeft: "auto", flexShrink: 0, background: "#eefaf0", color: "#1d7a3d" }}
                      disabled={busy === m.id}
                      onClick={() => act(m.id, "reopen")}
                    >
                      重新打开
                    </button>
                  </div>
                ))}
            </>
          )}
        </>
      )}
    </div>
  );
}

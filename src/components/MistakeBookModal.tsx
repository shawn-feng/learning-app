/**
 * 错题/生字本弹框（设置侧栏入口，ISSUE-114 P1）：按种类分组展示 open 条目（次数/最近时间），
 * 「会了」（小题验证后标掌握）/「不算」（dismiss）。mastered/dismiss 的条目收进底部折叠区。
 */
import { useCallback, useEffect, useState } from "react";
import { Volume2 } from "lucide-react";

interface MistakeItem {
  id: string;
  kind: "wrong_question" | "unknown_word" | "weak_point";
  content: string;
  detail: string;
  source: string;
  count: number;
  status: "open" | "mastered" | "dismissed";
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
  borderRadius: 12,
  padding: "12px 14px",
  marginBottom: 10,
};
const btn: React.CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "6px 14px",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};
const fmtDay = (iso: string) => String(iso ?? "").slice(0, 10);

function MistakeCard({
  m,
  busy,
  onMaster,
  onDismiss,
  onSpeak,
}: {
  m: MistakeItem;
  busy: boolean;
  onMaster: () => void;
  onDismiss: () => void;
  onSpeak: () => void;
}) {
  const meta = KIND_META[m.kind] ?? { label: m.kind, icon: "•" };
  return (
    <div style={card}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <span
          style={{
            flexShrink: 0,
            width: 34,
            height: 34,
            borderRadius: 10,
            background: "#eef2ff",
            color: "#3b4cca",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: m.kind === "unknown_word" ? 20 : 15,
            fontWeight: 700,
            fontFamily: m.kind === "unknown_word" ? "inherit" : "monospace",
          }}
        >
          {meta.icon}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{m.content}</div>
          {m.detail && (
            <div style={{ fontSize: 12, color: "#5a6478", marginTop: 3, lineHeight: 1.5 }}>{m.detail}</div>
          )}
          <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
            {meta.label}
            {m.count > 1 ? ` · ${m.count} 次` : ""} · 最近 {fmtDay(m.last_seen)}
            {m.source === "exam" ? " · 来自考核" : m.source === "lookup" ? " · 来自查词" : ""}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button style={{ ...btn, background: "#2f7d4f", color: "#fff" }} disabled={busy} onClick={onMaster}>
            会了 ✅
          </button>
          <button style={{ ...btn, background: "#f0f2f7", color: "#5a6478" }} disabled={busy} onClick={onDismiss}>
            不算
          </button>
        </div>
      </div>
    </div>
  );
}

export default function MistakeBookModal({ childId, onClose }: { childId: string; onClose: () => void }) {
  const [items, setItems] = useState<MistakeItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [speakWord, setSpeakWord] = useState("");

  const load = useCallback(async () => {
    const r = await window.api.mistakesList({ childId, status: "open", limit: 100 });
    if (r?.success) setItems(r.data?.mistakes || []);
  }, [childId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 生字点击朗读（复用语音合成，与查词浮层同款 TTS 链路）
  useEffect(() => {
    if (!speakWord) return;
    try {
      const u = new SpeechSynthesisUtterance(speakWord);
      u.lang = "zh-CN";
      window.speechSynthesis.speak(u);
    } catch {
      /* 无 TTS 环境忽略 */
    }
    setSpeakWord("");
  }, [speakWord]);

  const act = async (key: string, action: "mastered" | "dismiss") => {
    setBusy(key);
    setNotice("");
    try {
      const r = await window.api.mistakeAction({ childId, id: key, action });
      if (r?.success && (r.data as any)?.ok) {
        setNotice(action === "mastered" ? "太棒了，已标为掌握！" : "已标记忽略。");
        await load();
      } else {
        setNotice((r?.data as any)?.error || r?.error || "操作失败");
      }
    } catch (e: any) {
      setNotice({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const open = items.filter((m) => m.status === "open");
  const done = items.filter((m) => m.status !== "open");
  const groups: Array<[string, MistakeItem[]]> = [
    ["wrong_question", open.filter((m) => m.kind === "wrong_question")],
    ["unknown_word", open.filter((m) => m.kind === "unknown_word")],
    ["weak_point", open.filter((m) => m.kind === "weak_point")],
  ];

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#f6f8fb",
          borderRadius: 16,
          width: "min(680px, 92vw)",
          maxHeight: "82vh",
          display: "flex",
          flexDirection: "column",
          padding: "18px 20px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
          <h3 style={{ margin: 0 }}>📕 我的错题本</h3>
          <span style={{ fontSize: 12, color: "#8a94a6", marginLeft: 10 }}>
            会话里记下的漏洞都在这里；说「会了」并答对小验证就会关闭
          </span>
          <button
            style={{ marginLeft: "auto", border: "none", background: "none", fontSize: 18, cursor: "pointer" }}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {notice && (
          <div style={{ marginBottom: 10, padding: "6px 10px", borderRadius: 8, background: "#eefaf0", color: "#1d7a3d", fontSize: 13 }}>
            {notice}
          </div>
        )}

        <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
          {!open.length && !done.length && (
            <p style={{ textAlign: "center", color: "#8a94a6", padding: "30px 0" }}>
              还没有记录。学习中有做错的题、不认识的字，AI 老师会帮你记到这里。
            </p>
          )}
          {groups.map(([kind, list]) =>
            list.length ? (
              <div key={kind}>
                <h4 style={{ margin: "10px 0 8px", fontSize: 13, color: "#4a5265" }}>
                  {KIND_META[kind].label}（{list.length}）
                </h4>
                {list.map((m) => (
                  <MistakeCard
                    key={m.id}
                    m={m}
                    busy={busy === m.id}
                    onMaster={() => act(m.id, "mastered")}
                    onDismiss={() => act(m.id, "dismiss")}
                    onSpeak={() => setSpeakWord(m.content)}
                  />
                ))}
              </div>
            ) : null
          )}
          {done.length > 0 && (
            <>
              <h4
                style={{ margin: "14px 0 8px", fontSize: 13, color: "#8a94a6", cursor: "pointer" }}
                onClick={() => setShowDone((v) => !v)}
              >
                已关闭（{done.length}）{showDone ? "▲" : "▼"}
              </h4>
              {showDone &&
                done.map((m) => (
                  <div key={m.id} style={{ ...card, opacity: 0.65, display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ fontSize: 14, fontWeight: 600 }}>{m.content}</span>
                    <span style={{ fontSize: 11, color: "#8a94a6" }}>
                      {KIND_META[m.kind]?.label ?? m.kind} · {m.status === "mastered" ? "已掌握" : "已忽略"}
                    </span>
                    <button
                      style={{ ...btn, marginLeft: "auto", background: "#eefaf0", color: "#1d7a3d" }}
                      disabled={busy === m.id}
                      onClick={() => act(m.id, "reopen")}
                    >
                      重新打开
                    </button>
                  </div>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

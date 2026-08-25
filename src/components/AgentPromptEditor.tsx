import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { History, RotateCcw, Undo2 } from "lucide-react";

interface Props {
  scope: string;
  /** 引用键（孩子=childId；家长="main" 统一家长工作台提示词）。命名 refKey 避免与 React 保留字冲突 */
  refKey: string;
  title: string;
  onClose: () => void;
}

// ISSUE-037 续：家长提示词已统一（不再分「工作台助手 / 教学内容生成」两个场景），只保留 main 一个入口；
// 历史保存过的 ref=content 用户版本会在 buildParentPrompt 里作为 main 的兜底兼容读取，编辑器统一展示 main。
const PARENT_REFS = [{ ref: "main", label: "家长工作台助手（统一）" }];

/**
 * AGENTS / 系统提示词「用户可编辑版本」编辑器（ISSUE-033）。
 * - 整体替换代码默认：保存后即成为该 scope/ref 的唯一权威，开会话时直接生效；
 * - 支持「恢复默认」（删除自定义版本，回退到源码提示词）；
 * - 每次保存沉淀历史版本，可一键回退。
 */
export default function AgentPromptEditor({ scope, refKey, title, onClose }: Props) {
  const [ref, setRef] = useState(refKey);
  const [content, setContent] = useState("");
  const [customized, setCustomized] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [history, setHistory] = useState<Array<{ content: string; updated: string }>>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, ref]);

  async function load() {
    const r = await window.api.agentsGet(scope, ref);
    setContent(r?.content || "");
    setCustomized(!!r?.customized);
    const h = await window.api.agentsHistory(scope, ref);
    setHistory(h?.success ? h.data || [] : []);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await window.api.agentsSave(scope, ref, content);
      if (r?.success) {
        setMsg({ ok: true, text: "已保存（整体替换默认提示词）" });
        setCustomized(true);
        await load();
      } else {
        setMsg({ ok: false, text: r?.error || "保存失败" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function reset() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await window.api.agentsSave(scope, ref, "");
      if (r?.success) {
        setMsg({ ok: true, text: "已恢复默认（删除自定义版本）" });
        setCustomized(false);
        await load();
      } else {
        setMsg({ ok: false, text: r?.error || "操作失败" });
      }
    } finally {
      setBusy(false);
    }
  }

  async function restore(updated: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await window.api.agentsRestore(scope, ref, updated);
      if (r?.success && r.data) {
        setMsg({ ok: true, text: "已回退到该历史版本" });
        await load();
      } else {
        setMsg({ ok: false, text: "回退失败或版本不存在" });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <h2 style={{ marginBottom: 4 }}>{title}</h2>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
          {customized
            ? "当前为自定义版本（整体替换默认提示词）"
            : "当前为系统默认提示词，保存后即整体替换为你的版本"}
        </p>

        {scope === "parent" && (
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {PARENT_REFS.map((p) => (
              <button
                key={p.ref}
                onClick={() => setRef(p.ref)}
                style={{
                  padding: "6px 12px",
                  borderRadius: 6,
                  border: "1px solid #ddd",
                  background: ref === p.ref ? "#667eea" : "#fff",
                  color: ref === p.ref ? "#fff" : "#333",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        {msg && (
          <div
            style={{
              fontSize: 12,
              padding: "6px 10px",
              borderRadius: 6,
              marginBottom: 8,
              background: msg.ok ? "#e8f7ee" : "#fdecec",
              color: msg.ok ? "#2f8a52" : "#b33",
            }}
          >
            {msg.text}
          </div>
        )}

        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            width: "100%",
            minHeight: 420,
            padding: 12,
            border: "1px solid #ddd",
            borderRadius: 8,
            fontSize: 14,
            fontFamily: "monospace",
            resize: "vertical",
          }}
          placeholder="在此编辑 AI 提示词（整体替换默认）…"
        />

        <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
          <button
            className="confirm"
            onClick={save}
            disabled={busy}
            style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer" }}
          >
            保存
          </button>
          <IconButton
            icon={RotateCcw}
            title="恢复默认"
            onClick={reset}
            disabled={busy || !customized}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 13, cursor: "pointer" }}
          />
          <IconButton
            icon={History}
            title="历史版本"
            onClick={() => setShowHistory((v) => !v)}
            style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 13, cursor: "pointer" }}
          />
          <button className="cancel" onClick={onClose} style={{ marginLeft: "auto" }}>
            关闭
          </button>
        </div>

        {showHistory && (
          <div style={{ marginTop: 12, borderTop: "1px solid #eee", paddingTop: 12 }}>
            {history.length === 0 ? (
              <p style={{ color: "#888", fontSize: 12 }}>暂无历史版本（保存后会自动记录）。</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 200, overflowY: "auto" }}>
                {history.map((h) => (
                  <div key={h.updated} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
                    <span style={{ color: "#666", flex: 1 }}>{new Date(h.updated).toLocaleString()}</span>
                  <IconButton
                    icon={Undo2}
                    title="回退到此版本"
                    onClick={() => restore(h.updated)}
                    disabled={busy}
                    style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 12, cursor: "pointer" }}
                  />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

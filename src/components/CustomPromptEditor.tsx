/**
 * ISSUE-175：agent「自定义提示词层」通用编辑器——预设基底不可见不可改，UI 只查/编追加层。
 *
 * 存哪：服务端 agents.sqlite（scope="parent"/"child"，ref=对应 id，每份独立，留 50 版历史）。
 * 怎么生效：内容以固定小节标题整段**追加**在对应 agent 的 system prompt 末尾
 * （孩子=「## 家长设定的额外规范」server/src/agent/prompt.ts；家长=「## 家长补充说明」
 * server/src/agent/parent-registry.ts）——建会话时读一次，改完要重开会话才生效。
 * 边界（ISSUE-083 延续）：纯追加层、非全文编辑器——无自定义时编辑框为空，不预填任何基底。
 * 使用方：孩子详情页「自定义规范」（ChildCustomRules 包装）、设置页「自定义说明」（scope=parent）。
 */
import { useCallback, useEffect, useState } from "react";

interface HistoryRow {
  content: string;
  updated: string;
}

const hhmm = (iso: string): string => {
  const t = String(iso).replace("T", " ").slice(0, 16);
  return t || String(iso);
};

export interface CustomPromptEditorProps {
  scope: "parent" | "child";
  /** scope=child 时为孩子 id；scope=parent 时 IPC 层强制当前家长 id（传空串即可） */
  refId: string;
  /** 面板标题（如「自定义规范」「自定义说明」） */
  title: string;
  /** 用途说明（追加目标、影响范围等） */
  description: React.ReactNode;
  /** 编辑框 placeholder 示例行 */
  placeholder?: string;
  /** 保存/生效提示里的会话主体称呼（如「孩子」「家长助手」） */
  entityLabel?: string;
}

export default function CustomPromptEditor({
  scope,
  refId,
  title,
  description,
  placeholder,
  entityLabel = "AI",
}: CustomPromptEditorProps) {
  const [stored, setStored] = useState<string | null>(null); // null = 未自定义
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [staleNetwork, setStaleNetwork] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const load = useCallback(async () => {
    const r: any = await window.api.agentsGet(scope, refId);
    if (!r || typeof r.content !== "string") {
      setStatus({ kind: "err", text: "读取自定义内容失败，请稍后再试" });
      return;
    }
    setStaleNetwork(!!r.network);
    setStored(r.customized ? r.content : null);
    setDraft(r.customized ? r.content : "");
    const h: any = await window.api.agentsHistory(scope, refId);
    setHistory(h?.success ? h.data || [] : []);
  }, [scope, refId]);

  useEffect(() => {
    setStatus(null);
    void load();
  }, [load]);

  const customized = stored !== null;
  const dirty = draft !== (stored ?? "");

  async function handleSave(text: string, okText: string) {
    setBusy(true);
    setStatus(null);
    const r: any = await window.api.agentsSave(scope, refId, text);
    setBusy(false);
    if (!r?.success) {
      setStatus({ kind: "err", text: r?.error || "保存失败" });
      return;
    }
    setStatus({ kind: "ok", text: okText });
    await load();
  }

  return (
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <h3>{title}</h3>
      <p className="desc">
        {description}
        <br />
        ⚠️ 自定义内容在**建会话时读取一次**：保存后让{entityLabel}**退出重进 / 重置会话**（或等跨天自动新会话）才生效。
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button
          disabled={busy || !dirty}
          onClick={() => handleSave(draft, "已保存（重开会话后生效）")}
          style={{
            padding: "6px 16px",
            background: busy || !dirty ? "#ddd" : "#667eea",
            color: busy || !dirty ? "#666" : "white",
            border: "none",
            borderRadius: 6,
            fontSize: 13,
            cursor: busy || !dirty ? "default" : "pointer",
          }}
        >
          保存
        </button>
        <button
          disabled={busy || !customized}
          onClick={() => handleSave("", "已清空自定义（回到系统默认规范，重开会话后生效）")}
          style={{
            padding: "6px 12px",
            background: "white",
            border: "1px solid #ddd",
            borderRadius: 6,
            fontSize: 13,
            cursor: busy || !customized ? "default" : "pointer",
          }}
        >
          清空自定义
        </button>
        <span style={{ fontSize: 12, color: customized ? "#b26a00" : "#999" }}>
          {customized ? "已自定义" : "未自定义"}
        </span>
        {dirty && <span style={{ fontSize: 12, color: "#b26a00" }}>有未保存的改动</span>}
      </div>

      {staleNetwork && (
        <p style={{ fontSize: 12, color: "#b26a00", margin: "0 0 8px" }}>
          服务端暂不可达，以下显示的是本机缓存（可能不是最新），保存也可能失败。
        </p>
      )}
      {status && (
        <p style={{ fontSize: 13, margin: "0 0 8px", color: status.kind === "err" ? "#c0392b" : "#2f7a2f" }}>
          {status.text}
        </p>
      )}

      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        placeholder={placeholder}
        style={{
          flex: 1,
          minHeight: 220,
          fontFamily: "monospace",
          fontSize: 13,
          lineHeight: 1.6,
          border: "1px solid #ddd",
          borderRadius: 8,
          padding: 12,
          resize: "vertical",
        }}
      />

      {history.length > 0 && (
        <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 8, maxHeight: 150, overflowY: "auto" }}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
            历史版本（最多 50 版，点「回退」把那一版变成当前）
          </div>
          {history.map((h) => (
            <div key={h.updated} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "2px 0" }}>
              <span style={{ color: "#666", width: 130 }}>{hhmm(h.updated)}</span>
              <span style={{ color: "#aaa", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.content.replace(/\s+/g, " ").slice(0, 60) || "（空＝清空自定义）"}
              </span>
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  const r: any = await window.api.agentsRestore(scope, refId, h.updated);
                  setBusy(false);
                  if (!r?.success) {
                    setStatus({ kind: "err", text: r?.error || "回退失败" });
                    return;
                  }
                  setStatus({ kind: "ok", text: `已回退到 ${hhmm(h.updated)} 那一版（重开会话后生效）` });
                  await load();
                }}
                style={{ padding: "2px 10px", background: "white", border: "1px solid #ddd", borderRadius: 4 }}
              >
                回退
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

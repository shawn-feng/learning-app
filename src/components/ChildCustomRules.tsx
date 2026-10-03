/**
 * ISSUE-136 待拍板 #7（2026-09-28 拍板落地）：孩子 agent「家长自定义层」编辑入口恢复。
 *
 * 存哪：服务端 agents.sqlite（scope='child'、ref=childId，每孩子一份，留 50 版历史）。
 * 怎么生效：内容作为「## 家长设定的额外规范」整段**追加**在孩子 agent system prompt 末尾
 * （server/src/agent/prompt.ts；session-registry 建会话时读一次）——改完要重开会话才生效。
 * 边界（ISSUE-083 延续）：基底提示词在代码里、不对用户暴露，这里是纯追加层，不是全文编辑器——
 * 无自定义时编辑框为空（不再像旧 AgentPromptEditor 那样预填代码默认稿）。
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

export default function ChildCustomRules({ childId }: { childId: string }) {
  const [stored, setStored] = useState<string | null>(null); // null = 未自定义
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [staleNetwork, setStaleNetwork] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const load = useCallback(async () => {
    const r: any = await window.api.agentsGet("child", childId);
    if (!r || typeof r.content !== "string") {
      setStatus({ kind: "err", text: "读取自定义规范失败，请稍后再试" });
      return;
    }
    setStaleNetwork(!!r.network);
    setStored(r.customized ? r.content : null);
    setDraft(r.customized ? r.content : "");
    const h: any = await window.api.agentsHistory("child", childId);
    setHistory(h?.success ? h.data || [] : []);
  }, [childId]);

  useEffect(() => {
    setStatus(null);
    void load();
  }, [load]);

  const customized = stored !== null;
  const dirty = draft !== (stored ?? "");

  async function handleSave(text: string, okText: string) {
    setBusy(true);
    setStatus(null);
    const r: any = await window.api.agentsSave("child", childId, text);
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
      <h3>自定义规范</h3>
      <p className="desc">
        给孩子的 AI 伙伴追加的额外规范（例如：「讲题先给提示，别直接报答案」「每轮结束夸一句具体的进步」）。
        内容会整段**追加**在 AI 行为规范的最末尾，只影响这一个孩子；基础规范由系统维护，这里改不到。
        <br />
        ⚠️ 规范在**建会话时读取一次**：保存后让孩子**退出重进 / 重置会话**（或等跨天自动新会话）才生效。
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
        placeholder={"在这里写给 AI 伙伴的额外规范，一行一条即可，例如：\n· 讲题先给提示，别直接报答案\n· 20 点以后不再安排新任务，只鼓励休息"}
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
                  const r: any = await window.api.agentsRestore("child", childId, h.updated);
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

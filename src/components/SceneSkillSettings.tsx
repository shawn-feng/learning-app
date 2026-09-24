/**
 * ISSUE-144 P5：家长「场景口径」编辑器（设置 → 场景口径）。
 *
 * 家长能改的东西只有**一件事**：某个场景里助手"怎么说、先做什么"。
 * - 存哪：服务端 `agents.sqlite`（`scope='parent'`，库内键 `skill:<家长id>:<技能名>`）——覆盖优先、清空回落内置；
 * - 怎么生效：技能正文是**按需加载**的（助手在这个会话里读过一次就固定了），所以改完要**开个新会话/重置会话**才看得到；
 * - 改不掉什么：铁律、工具白名单、参数语义、不可逆动作的确认流程——一律来自代码；
 *   覆盖版生效时服务端会在正文后**自动追加**「不可覆盖条款」，与铁律冲突时以铁律为准；
 * - 存的时候服务端会做红线关键词校验，被拒会在这里显示原因。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

interface SkillRow {
  name: string;
  title: string;
  triggers: string;
  summary: string;
  tools: string[];
  ref: string;
  builtin: string;
  override: string | null;
  updated: string | null;
}

interface HistoryRow {
  content: string;
  updated: string;
}

const hhmm = (iso: string | null): string => {
  if (!iso) return "";
  const s = String(iso);
  const t = s.replace("T", " ").slice(0, 16);
  return t || s;
};

export default function SceneSkillSettings() {
  const [rows, setRows] = useState<SkillRow[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ kind: "ok" | "err" | "info"; text: string } | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const load = useCallback(async (keep?: string) => {
    const r: any = await window.api.agentsSkillList();
    if (!r?.success) {
      setStatus({ kind: "err", text: `读取场景清单失败：${r?.error || "未知错误"}` });
      return;
    }
    const list: SkillRow[] = r.data || [];
    setRows(list);
    const name = keep && list.some((x) => x.name === keep) ? keep : list[0]?.name || "";
    setSelected(name);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const current = useMemo(() => rows.find((r) => r.name === selected), [rows, selected]);

  // 选中场景变化 → 草稿＝当前生效正文（家长自定义优先，否则内置稿）
  useEffect(() => {
    if (!current) {
      setDraft("");
      return;
    }
    setDraft(current.override ?? current.builtin);
    setStatus(null);
    void (async () => {
      const r: any = await window.api.agentsHistory("parent", current.ref);
      setHistory(r?.success ? r.data || [] : []);
    })();
  }, [current]);

  const customized = !!current?.override;
  const dirty = !!current && draft !== (current.override ?? current.builtin);

  async function handleSave(text: string, okText: string) {
    if (!current) return;
    setBusy(true);
    setStatus(null);
    const r: any = await window.api.agentsSave("parent", current.ref, text);
    setBusy(false);
    if (!r?.success) {
      // 服务端红线校验被拒也走这里：原文照显，便于家长改说法
      setStatus({ kind: "err", text: r?.error || "保存失败" });
      return;
    }
    setStatus({ kind: "ok", text: `${okText}（新会话里生效——已开着的会话里技能正文已经读过了）` });
    await load(current.name);
  }

  return (
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <h3>场景口径</h3>
      <p className="desc">
        助手按「场景」办事。这里可以改某个场景里**助手怎么讲**（例如：看学习情况时别提分数、只说掌握情况）。
        改动只影响**说话方式与先后顺序**；安全红线、能用的工具、参数规则来自程序，改不掉。
        <br />
        ⚠️ 技能正文在会话里**读过一次就固定了**：改完请**重置会话 / 开新会话**再看效果。
      </p>

      <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 16 }}>
        {/* 左侧：场景清单 */}
        <div style={{ width: 220, borderRight: "1px solid #eee", overflowY: "auto", flexShrink: 0 }}>
          {rows.map((r) => (
            <div
              key={r.name}
              onClick={() => setSelected(r.name)}
              style={{
                padding: "10px 12px",
                cursor: "pointer",
                background: selected === r.name ? "#f0f4ff" : "transparent",
                borderRadius: 8,
                marginBottom: 4,
              }}
            >
              <div style={{ fontSize: 14, fontWeight: selected === r.name ? 600 : 400 }}>{r.title}</div>
              <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>
                {r.override ? `已自定义（${hhmm(r.updated)}）` : "官方口径"}
              </div>
            </div>
          ))}
          {rows.length === 0 && <p style={{ color: "#888", fontSize: 12, padding: 12 }}>暂无场景</p>}
        </div>

        {/* 右侧：编辑区 */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {current ? (
            <>
              <div style={{ marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <strong style={{ fontSize: 15 }}>{current.title}</strong>
                  <span style={{ fontSize: 12, color: "#999" }}>{current.name}</span>
                  <span
                    style={{
                      fontSize: 12,
                      padding: "2px 8px",
                      borderRadius: 10,
                      background: customized ? "#fff4e5" : "#eef7ee",
                      color: customized ? "#b26a00" : "#2f7a2f",
                    }}
                  >
                    {customized ? "已自定义" : "官方口径"}
                  </span>
                </div>
                <p style={{ fontSize: 12, color: "#888", margin: "6px 0 0" }}>
                  家长通常这么说：{current.triggers}
                </p>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  disabled={busy || !dirty}
                  onClick={() => handleSave(draft, "已保存")}
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
                  disabled={busy}
                  onClick={() => {
                    setDraft(current.builtin);
                    setStatus({ kind: "info", text: "已载入官方口径，点「保存」才生效（也可以直接用下面的「恢复官方口径」）。" });
                  }}
                  style={{ padding: "6px 12px", background: "white", border: "1px solid #ddd", borderRadius: 6, fontSize: 13 }}
                >
                  载入官方口径到编辑框
                </button>
                <button
                  disabled={busy || !customized}
                  onClick={() => handleSave("", "已恢复官方口径")}
                  style={{
                    padding: "6px 12px",
                    background: "white",
                    border: "1px solid #ddd",
                    borderRadius: 6,
                    fontSize: 13,
                    cursor: busy || !customized ? "default" : "pointer",
                  }}
                >
                  恢复官方口径
                </button>
                {dirty && <span style={{ fontSize: 12, color: "#b26a00" }}>有未保存的改动</span>}
              </div>

              {status && (
                <p
                  style={{
                    fontSize: 13,
                    margin: "0 0 8px",
                    color: status.kind === "err" ? "#c0392b" : status.kind === "ok" ? "#2f7a2f" : "#667eea",
                  }}
                >
                  {status.text}
                </p>
              )}

              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                style={{
                  flex: 1,
                  minHeight: 260,
                  fontFamily: "monospace",
                  fontSize: 13,
                  lineHeight: 1.6,
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 12,
                  resize: "vertical",
                }}
              />

              <p style={{ fontSize: 12, color: "#999", marginTop: 6 }}>
                可用的工具（本场景）：{current.tools.length ? current.tools.join("、") : "（无专用工具）"}
              </p>

              {history.length > 0 && (
                <div style={{ marginTop: 10, borderTop: "1px solid #eee", paddingTop: 8, maxHeight: 150, overflowY: "auto" }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>
                    历史版本（最多 50 版，点「回退」把那一版变成当前）
                  </div>
                  {history.map((h) => (
                    <div key={h.updated} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "2px 0" }}>
                      <span style={{ color: "#666", width: 130 }}>{hhmm(h.updated)}</span>
                      <span style={{ color: "#aaa", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {h.content.replace(/\s+/g, " ").slice(0, 60)}
                      </span>
                      <button
                        disabled={busy}
                        onClick={async () => {
                          setBusy(true);
                          const r: any = await window.api.agentsRestore("parent", current.ref, h.updated);
                          setBusy(false);
                          if (!r?.success) {
                            setStatus({ kind: "err", text: r?.error || "回退失败" });
                            return;
                          }
                          setStatus({ kind: "ok", text: `已回退到 ${hhmm(h.updated)} 那一版（新会话里生效）` });
                          await load(current.name);
                        }}
                        style={{ padding: "2px 10px", background: "white", border: "1px solid #ddd", borderRadius: 4 }}
                      >
                        回退
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div style={{ color: "#888", fontSize: 13, textAlign: "center", marginTop: 40 }}>选择左侧场景开始编辑</div>
          )}
        </div>
      </div>
    </div>
  );
}

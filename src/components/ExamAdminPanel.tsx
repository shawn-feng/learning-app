/**
 * 家长端「学习考核」面板（家长中心左侧边栏）。
 * 标签组织（点击标签只显示该标签内容）：
 *   - 每天：启用开关 + 考核时间 + 选课 prompt + 保存
 *   - 每周：启用开关 + 周几 + 考核时间 + 选课 prompt + 保存
 *   - 自定义考核：**左侧考核列表 + 右侧编辑表单**；新建时右侧空白，家长填好
 *     （时间点 + prompt + 内容说明 + 分配孩子）保存即创建；点列表项可在右侧修改并保存
 *     （已完成的孩子锁定为历史，不受影响）。
 * 月度/半年/年度不再作为固定档（由自定义考核灵活安排）。
 */
import { useCallback, useEffect, useState } from "react";

const WEEKDAYS: Array<{ v: number; label: string }> = [
  { v: 1, label: "周一" },
  { v: 2, label: "周二" },
  { v: 3, label: "周三" },
  { v: 4, label: "周四" },
  { v: 5, label: "周五" },
  { v: 6, label: "周六" },
  { v: 7, label: "周日" },
];

const DEFAULT_HINTS: Record<string, string> = {
  daily: "默认：考今天学习计划里安排的所有课程（无论是否完成）",
  weekly: "默认：考近 7 天学习计划里安排的所有课程（无论是否完成）",
};

interface ScheduleRow {
  id: string;
  childId: string;
  kind: string;
  freq: string;
  scheduledAt: string;
  status: string;
  title: string;
  scope: Record<string, unknown>;
  pending: boolean;
}

interface CustomGroup {
  key: string;
  scheduledAt: string;
  note: string;
  prompt: string;
  rows: ScheduleRow[];
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 时间 → datetime-local 输入框值（本地时区） */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ExamAdminPanel({ children }: { children: any[] }) {
  // 标签：每天 / 每周 / 自定义考核
  const [tab, setTab] = useState<"daily" | "weekly" | "custom">("daily");
  // 每天
  const [enabledDaily, setEnabledDaily] = useState(true);
  const [dailyTime, setDailyTime] = useState("20:00");
  // 每周
  const [enabledWeekly, setEnabledWeekly] = useState(true);
  const [weeklyWeekday, setWeeklyWeekday] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState("20:00");
  // 各档 prompt
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  // 自定义考核（所有孩子的排期，按考核聚合）
  const [customs, setCustoms] = useState<ScheduleRow[]>([]);
  // 编辑表单（新建/编辑共用）：selKey=null 时右侧为空白新建表单，否则为对应考核组的详情
  const [selKey, setSelKey] = useState<string | null>(null);
  const [formAt, setFormAt] = useState("");
  const [formPrompt, setFormPrompt] = useState("");
  const [formNote, setFormNote] = useState("");
  const [formAssigned, setFormAssigned] = useState<string[]>([]); // 分配的孩子（默认全选）
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // 默认分配：全选所有孩子（孩子可共用考核）
  useEffect(() => {
    if (children?.length && formAssigned.length === 0) setFormAssigned(children.map((c) => c.childId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [children]);

  // 加载固定配置（家长级）
  useEffect(() => {
    window.api.examFixedConfig().then((r: any) => {
      if (r?.success && r.data?.config) {
        const c = r.data.config;
        const freqs = Array.isArray(c.frequencies) ? c.frequencies : [];
        setEnabledDaily(freqs.includes("daily"));
        setEnabledWeekly(freqs.includes("weekly"));
        if (c.time) setDailyTime(c.time);
        if (c.weekly) {
          if (c.weekly.weekday >= 1 && c.weekly.weekday <= 7) setWeeklyWeekday(c.weekly.weekday);
          if (c.weekly.time) setWeeklyTime(c.weekly.time);
        }
        if (c.selectionPrompts && typeof c.selectionPrompts === "object") setPrompts(c.selectionPrompts);
      }
    });
  }, []);

  // 加载所有孩子的自定义排期（childId 从查询上下文补入，供按考核聚合）
  const loadCustoms = useCallback(async () => {
    const kids = children || [];
    const all: ScheduleRow[] = [];
    await Promise.all(
      kids.map(async (c) => {
        try {
          const r: any = await window.api.examSchedules(c.childId);
          if (!r?.success) return;
          const rows = (r.data?.schedules || []).filter((s: any) => s.kind === "custom");
          for (const s of rows) all.push({ ...s, childId: c.childId });
        } catch {
          /* 静默 */
        }
      })
    );
    setCustoms(all);
  }, [children]);
  useEffect(() => {
    loadCustoms();
  }, [loadCustoms]);

  // 按「时间点 + prompt」聚合为考核组（多孩子共用同一考核 → 一组多行）
  const groups: CustomGroup[] = (() => {
    const map = new Map<string, CustomGroup>();
    for (const s of customs) {
      const key = s.scheduledAt + "|" + String(s.scope?.prompt || "");
      let g = map.get(key);
      if (!g) {
        g = { key, scheduledAt: s.scheduledAt, note: String(s.scope?.note || ""), prompt: String(s.scope?.prompt || ""), rows: [] };
        map.set(key, g);
      }
      g.rows.push(s);
    }
    return Array.from(map.values()).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
  })();

  const nameOf = (cid: string) => (children || []).find((c) => c.childId === cid)?.name || cid.slice(0, 8);

  async function saveFixed() {
    setSaving(true);
    try {
      const frequencies: string[] = [];
      if (enabledDaily) frequencies.push("daily");
      if (enabledWeekly) frequencies.push("weekly");
      const r: any = await window.api.examFixedConfigSave({
        frequencies,
        time: dailyTime,
        weekly: { weekday: weeklyWeekday, time: weeklyTime },
        selectionPrompts: { daily: prompts.daily ?? "", weekly: prompts.weekly ?? "" },
      });
      if (r?.success) {
        setMsg({ ok: true, text: frequencies.length ? "✓ 固定考核配置已保存（选课规则即时生效）" : "✓ 已保存（固定考核全部关闭，孩子只会有自定义考核）" });
        window.api.examFixedConfig().then((rr: any) => {
          if (rr?.success && rr.data?.config?.selectionPrompts) setPrompts(rr.data.config.selectionPrompts);
        });
      } else setMsg({ ok: false, text: r?.error || "保存失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  /** 左侧「新建考核」：右侧切到空白表单。 */
  function startCreate() {
    setSelKey(null);
    setFormAt("");
    setFormPrompt("");
    setFormNote("");
    setMsg(null);
  }

  /** 点左侧列表项：右侧显示该考核详情（可编辑保存）。 */
  function openGroup(g: CustomGroup) {
    setSelKey(g.key);
    setFormAt(toLocalInput(g.scheduledAt));
    setFormPrompt(g.prompt);
    setFormNote(g.note);
    // 已完成的孩子锁定为历史，只勾选可编辑的行
    setFormAssigned(g.rows.filter((r) => r.status !== "done").map((r) => r.childId));
    setMsg(null);
  }

  /** 保存考核：新建=创建排期；编辑=按新内容/新分配重建未完成的行（已完成的行保留为历史）。 */
  async function saveCustom() {
    if (!formAt) {
      setMsg({ ok: false, text: "请选择考核时间点" });
      return;
    }
    if (!formPrompt.trim()) {
      setMsg({ ok: false, text: "请填写这次考核的 prompt（说明考哪些内容、怎么选课）" });
      return;
    }
    if (!formAssigned.length) {
      setMsg({ ok: false, text: "请至少选择一个要分配的孩子" });
      return;
    }
    setSaving(true);
    try {
      const iso = new Date(formAt).toISOString();
      const scope = { topics: [], note: formNote.trim() || "自定义考核", prompt: formPrompt.trim() };
      if (!selKey) {
        // —— 新建 ——
        let okCount = 0;
        for (const cid of formAssigned) {
          const r: any = await window.api.examScheduleCreate(cid, iso, scope);
          if (r?.success) okCount++;
        }
        if (okCount > 0) {
          setMsg({ ok: true, text: `✓ 已创建并分配给 ${okCount} 个孩子，到点可开始` });
          setFormAt("");
          setFormPrompt("");
          setFormNote("");
          loadCustoms();
        } else setMsg({ ok: false, text: "创建失败" });
      } else {
        // —— 编辑：重建未完成的行（done 行保留为历史） ——
        const g = groups.find((x) => x.key === selKey);
        if (!g) {
          setMsg({ ok: false, text: "该考核已不存在，列表已刷新" });
          loadCustoms();
          return;
        }
        const changed =
          iso !== g.scheduledAt || formPrompt.trim() !== g.prompt || (formNote.trim() || "自定义考核") !== (g.note || "自定义考核");
        let removed = 0;
        const keep: string[] = [];
        for (const row of g.rows) {
          if (row.status === "done") continue; // 历史记录不动
          if (changed || !formAssigned.includes(row.childId)) {
            const r: any = await window.api.examScheduleCancel(row.id);
            if (r?.success) removed++;
            else setMsg({ ok: false, text: `取消 ${nameOf(row.childId)} 的旧排期失败` });
          } else keep.push(row.childId);
        }
        let added = 0;
        for (const cid of formAssigned) {
          if (keep.includes(cid)) continue;
          const r: any = await window.api.examScheduleCreate(cid, iso, scope);
          if (r?.success) added++;
        }
        setMsg({
          ok: true,
          text: changed
            ? `✓ 已更新考核内容（重建 ${added} 条、移除 ${removed} 条，已完成的不受影响）`
            : `✓ 已更新分配（新增 ${added}、移除 ${removed}）`,
        });
        await loadCustoms();
        setSelKey(iso + "|" + formPrompt.trim());
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  // 右侧编辑表单对应的考核组（selKey=null 时为新建模式）
  const editingGroup: CustomGroup | null = selKey ? groups.find((g) => g.key === selKey) ?? null : null;

  const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const box: React.CSSProperties = { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 };
  // 输入框样式参照课程管理（TopicDetail 编辑器）：大高度 + monospace + 13px 字号
  const ta: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minHeight: "40vh",
    padding: 10,
    borderRadius: 8,
    border: "1px solid #ddd",
    fontSize: 13,
    lineHeight: 1.7,
    fontFamily: "monospace",
    resize: "vertical",
    color: "#333",
  };
  const inputStyle: React.CSSProperties = { padding: "8px 12px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13 };
  const saveBtn: React.CSSProperties = {
    padding: "8px 22px",
    borderRadius: 8,
    border: "none",
    background: "#667eea",
    color: "#fff",
    fontSize: 13,
    cursor: "pointer",
  };

  const TAB_LIST: Array<[string, string]> = [
    ["daily", "每天"],
    ["weekly", "每周"],
    ["custom", "自定义考核"],
  ];

  return (
    <div style={{ maxWidth: 880 }}>
      <h3 style={{ marginBottom: 4 }}>🎯 学习考核</h3>
      <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
        固定考核按「每天 / 每周」标签管理；月度、半年、年度等由「自定义考核」灵活安排（先设置考核，再分配给孩子，多孩子可共用）。
      </p>

      {/* 标签栏 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        {TAB_LIST.map(([id, l]) => (
          <button
            key={id}
            onClick={() => setTab(id as "daily" | "weekly" | "custom")}
            style={{
              padding: "8px 18px",
              borderRadius: 8,
              border: tab === id ? "2px solid #667eea" : "1px solid #ddd",
              background: tab === id ? "#f0f4ff" : "white",
              color: tab === id ? "#3b4cca" : "#555",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {l}
          </button>
        ))}
      </div>

      {/* ===== 每天 ===== */}
      {tab === "daily" && (
        <div style={box}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={enabledDaily} onChange={(e) => setEnabledDaily(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>启用每日考核</span>
            {!enabledDaily && <span style={{ fontSize: 12, color: "#999" }}>（关闭后不会自动生成每日考核）</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 13 }}>考核时间：</span>
            <input type="time" value={dailyTime} onChange={(e) => setDailyTime(e.target.value || "20:00")} style={inputStyle} />
          </div>
          <div style={label}>选课规则 prompt（AI 按规则从今天学习计划安排的课程中挑选）</div>
          <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>{DEFAULT_HINTS.daily}。清空保存 = 恢复系统默认。</p>
          <textarea
            value={prompts.daily ?? ""}
            placeholder={`（未设置，使用默认规则：${DEFAULT_HINTS.daily}）`}
            onChange={(e) => setPrompts((p) => ({ ...p, daily: e.target.value }))}
            style={ta}
          />
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => setPrompts((p) => ({ ...p, daily: "" }))} style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#6b7686", cursor: "pointer", marginRight: 8 }}>
              恢复默认
            </button>
            <button onClick={saveFixed} disabled={saving} style={saveBtn}>
              {saving ? "保存中…" : "保存固定配置"}
            </button>
            {msg && <span style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33" }}>{msg.text}</span>}
          </div>
        </div>
      )}

      {/* ===== 每周 ===== */}
      {tab === "weekly" && (
        <div style={box}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <input type="checkbox" checked={enabledWeekly} onChange={(e) => setEnabledWeekly(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>启用每周考核</span>
            {!enabledWeekly && <span style={{ fontSize: 12, color: "#999" }}>（关闭后不会自动生成每周考核）</span>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13 }}>考核时间：</span>
            <select value={weeklyWeekday} onChange={(e) => setWeeklyWeekday(Number(e.target.value))} style={inputStyle}>
              {WEEKDAYS.map((w) => (
                <option key={w.v} value={w.v}>
                  {w.label}
                </option>
              ))}
            </select>
            <input type="time" value={weeklyTime} onChange={(e) => setWeeklyTime(e.target.value || "20:00")} style={inputStyle} />
          </div>
          <div style={label}>选课规则 prompt（AI 按规则从近 7 天学习计划安排的课程中挑选）</div>
          <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>{DEFAULT_HINTS.weekly}。清空保存 = 恢复系统默认。</p>
          <textarea
            value={prompts.weekly ?? ""}
            placeholder={`（未设置，使用默认规则：${DEFAULT_HINTS.weekly}）`}
            onChange={(e) => setPrompts((p) => ({ ...p, weekly: e.target.value }))}
            style={ta}
          />
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button onClick={() => setPrompts((p) => ({ ...p, weekly: "" }))} style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#6b7686", cursor: "pointer", marginRight: 8 }}>
              恢复默认
            </button>
            <button onClick={saveFixed} disabled={saving} style={saveBtn}>
              {saving ? "保存中…" : "保存固定配置"}
            </button>
            {msg && <span style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33" }}>{msg.text}</span>}
          </div>
        </div>
      )}

      {/* ===== 自定义考核（左列表 + 右编辑表单） ===== */}
      {tab === "custom" && (
        <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
          {/* 左列：考核列表 */}
          <div style={{ width: 236, flexShrink: 0 }}>
            <button
              onClick={startCreate}
              style={{
                width: "100%",
                padding: "9px 0",
                borderRadius: 8,
                border: "none",
                background: "#f2994a",
                color: "#fff",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
                marginBottom: 10,
              }}
            >
              ＋ 新建考核
            </button>
            <div style={{ ...label, marginBottom: 8 }}>考核列表（{groups.length}）</div>
            {groups.length === 0 ? (
              <p style={{ color: "#888", fontSize: 12, margin: 0 }}>
                还没有自定义考核。点上方「新建考核」设置，或对家长助手说「周五晚上考论语的乡党篇」。
              </p>
            ) : (
              groups.map((g) => {
                const doneCount = g.rows.filter((r) => r.status === "done").length;
                const sel = selKey === g.key;
                return (
                  <div
                    key={g.key}
                    onClick={() => openGroup(g)}
                    style={{
                      border: sel ? "2px solid #667eea" : "1px solid #e6eaf0",
                      borderRadius: 10,
                      padding: "10px 12px",
                      marginBottom: 8,
                      background: sel ? "#f0f4ff" : "#fff",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontSize: 13, fontWeight: 700 }}>{fmtTime(g.scheduledAt)}</div>
                    {g.note && (
                      <div style={{ fontSize: 12, color: "#6b7686", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.note}
                      </div>
                    )}
                    <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                      分配给 {g.rows.length} 个孩子{doneCount ? ` · ${doneCount} 已完成` : ""}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 右列：详情/编辑表单（新建时空白，家长设置好后保存） */}
          <div style={{ flex: 1, minWidth: 0 }}>
            {selKey && !editingGroup ? (
              <div style={box}>
                <p style={{ color: "#888", fontSize: 12, margin: 0 }}>该考核已更新或不存在，列表刷新中…</p>
              </div>
            ) : (
              <div style={box}>
                <div style={{ ...label, marginBottom: 10 }}>{selKey ? "📝 考核详情（修改后点保存生效）" : "📝 新建考核"}</div>
                {selKey && editingGroup && editingGroup.rows.length > 0 && editingGroup.rows.every((r) => r.status === "done") ? (
                  <p style={{ color: "#b9770a", fontSize: 12, margin: 0 }}>该考核已全部完成，属于历史记录，不可再修改。</p>
                ) : (
                  <>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                      <span style={{ fontSize: 13 }}>考核时间：</span>
                      <input type="datetime-local" value={formAt} onChange={(e) => setFormAt(e.target.value)} style={inputStyle} />
                    </div>
                    <input
                      type="text"
                      value={formNote}
                      onChange={(e) => setFormNote(e.target.value)}
                      placeholder="内容说明（可选，给孩子端展示，如：考论语的乡党篇）"
                      style={{ width: "100%", boxSizing: "border-box", ...inputStyle, marginBottom: 10 }}
                    />
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>考核 prompt（说明这次考哪些内容、怎么选课）</div>
                    <textarea
                      value={formPrompt}
                      onChange={(e) => setFormPrompt(e.target.value)}
                      placeholder="例如「考论语乡党篇最近学的 5 课，每课考完整」"
                      style={{ ...ta, minHeight: 240 }}
                    />
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>分配给的孩子（多孩子可共用这次考核）</div>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                      {(children || []).map((c) => {
                        const locked = !!editingGroup && editingGroup.rows.some((r) => r.childId === c.childId && r.status === "done");
                        return (
                          <label
                            key={c.childId}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, cursor: locked ? "not-allowed" : "pointer", opacity: locked ? 0.75 : 1 }}
                          >
                            <input
                              type="checkbox"
                              checked={formAssigned.includes(c.childId) || locked}
                              disabled={locked}
                              onChange={(e) =>
                                setFormAssigned((p) => (e.target.checked ? (p.includes(c.childId) ? p : [...p, c.childId]) : p.filter((x) => x !== c.childId)))
                              }
                            />
                            {c.name}
                            {locked && <span style={{ fontSize: 11, color: "#8a94a6" }}>（已完成）</span>}
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <button onClick={saveCustom} disabled={saving} style={saveBtn}>
                        {saving ? "保存中…" : selKey ? "保存修改" : "创建考核"}
                      </button>
                      {msg && <span style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33" }}>{msg.text}</span>}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

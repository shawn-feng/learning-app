/**
 * 家长端「学习考核」面板（家长中心左侧边栏）。
 * 标签组织（点击标签只显示该标签内容）：
 *   - 每天：启用开关 + 选课 prompt + 保存（每天可考核一次，到当天 0 点即全天可考）
 *   - 每周：启用开关 + 周几 + 选课 prompt + 保存（到该周几 0 点即全天可考）
 *   - 自定义考核：**左侧考核列表 + 右侧编辑表单**；新建时右侧空白，家长填好
 *     （时间点 + prompt + 内容说明 + 分配孩子）保存即创建；点列表项可在右侧修改并保存
 *     （已完成的孩子锁定为历史，不受影响）。
 *   - 考核记录：按孩子查看历次考核成绩 / 逐题评估 / 原音回放（复用 ExamRecords）。
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

/** ISO 时间 → 日期（YYYY-MM-DD，本地），考核只按日期粒度（2026-09-04）。 */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** ISO 时间 → date 输入框值（YYYY-MM-DD，本地） */
function toLocalDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** date 输入值（YYYY-MM-DD）→ 该日本地 0 点的 ISO 字符串 */
function dateToIso(dateStr: string): string {
  const [y, m, day] = dateStr.split("-").map(Number);
  const d = new Date(y, (m || 1) - 1, day || 1, 0, 0, 0, 0); // 本地时区 0 点
  return d.toISOString();
}

export default function ExamAdminPanel({ children }: { children: any[] }) {
  // 标签：每天 / 每周 / 自定义考核（结果记录已移到「孩子管理 → 某孩子 → 考核记录」）
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
  // 自定义考核列表中选中的组（右侧详情）
  const [selCustomKey, setSelCustomKey] = useState("");
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

  // 默认选中第一组（无选中时右侧展示最新安排）
  useEffect(() => {
    if (!selCustomKey && groups.length) setSelCustomKey(groups[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups.length]);

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
        // 2026-09-09：固定档不再使用选课规则 prompt（内置：计划周期内必学课全考）——清空历史值防旧模板残留
        selectionPrompts: { daily: "", weekly: "" },
      });
      if (r?.success) {
        setMsg({ ok: true, text: frequencies.length ? "✓ 固定考核配置已保存（每天/每周自动考学习计划里的必学课程）" : "✓ 已保存（固定考核全部关闭，孩子只会有自定义考核）" });
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
    setFormAt(toLocalDate(g.scheduledAt));
    setFormPrompt(g.prompt);
    setFormNote(g.note);
    // 已完成的孩子锁定为历史，只勾选可编辑的行
    setFormAssigned(g.rows.filter((r) => r.status !== "done").map((r) => r.childId));
    setMsg(null);
  }

  /** 保存考核：新建=创建排期；编辑=按新内容/新分配重建未完成的行（已完成的行保留为历史）。 */
  async function saveCustom() {
    if (!formAt) {
      setMsg({ ok: false, text: "请选择考核日期" });
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
      const iso = dateToIso(formAt);
      const scope = { topics: [], note: formNote.trim() || "自定义考核", prompt: formPrompt.trim() };
      if (!selKey) {
        // —— 新建 ——
        let okCount = 0;
        for (const cid of formAssigned) {
          const r: any = await window.api.examScheduleCreate(cid, iso, scope);
          if (r?.success) okCount++;
        }
        if (okCount > 0) {
          setMsg({ ok: true, text: `✓ 已创建并分配给 ${okCount} 个孩子，当天可开始` });
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
        这里管理考核**计划**：每天 / 每周固定考核与自定义考核都由家长助手按对话安排。历次考核**结果记录**请到「孩子管理 → 某孩子 → 考核记录」查看。
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
          <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>
            📅 每天考核一次：到达当天（0 点起）孩子就可在「学习考核」里参加，不限具体时刻。
          </p>
          <div style={label}>考核范围（固定规则）</div>
          <p style={{ color: "#6b7686", fontSize: 12, margin: 0, lineHeight: 1.7 }}>
            每天自动考核当天学习计划里的<strong>「必学」课程</strong>（全部考核）；明确标注「选学」的课程不纳入。
            固定档的考核规则不可更改——想调整范围、或考核选学/指定内容，请改用「自定义考核」，直接对家长助手说（例如
            "周三给珊珊安排一次考核，考论语的乡党篇最近学的 3 课"）。
          </p>
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
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
            <span style={{ fontSize: 13 }}>考核日期：</span>
            <select value={weeklyWeekday} onChange={(e) => setWeeklyWeekday(Number(e.target.value))} style={inputStyle}>
              {WEEKDAYS.map((w) => (
                <option key={w.v} value={w.v}>
                  {w.label}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: "#6b7686" }}>（到达该日 0 点起，孩子当天即可考核，不限时刻）</span>
          </div>
          <div style={label}>考核范围（固定规则）</div>
          <p style={{ color: "#6b7686", fontSize: 12, margin: 0, lineHeight: 1.7 }}>
            每周自动考核近 7 天学习计划里的<strong>「必学」课程</strong>（全部考核）；明确标注「选学」的课程不纳入。
            固定档的考核规则不可更改——想调整范围、或考核选学/指定内容，请改用「自定义考核」，直接对家长助手说。
          </p>
          <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <button onClick={saveFixed} disabled={saving} style={saveBtn}>
              {saving ? "保存中…" : "保存固定配置"}
            </button>
            {msg && <span style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33" }}>{msg.text}</span>}
          </div>
        </div>
      )}

      {/* ===== 自定义考核（由家长助手按对话安排，此处只读展示） ===== */}
      {tab === "custom" && (
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>📝 自定义考核（由家长助手安排）</div>
          <p style={{ color: "#6b7686", fontSize: 12, margin: "2px 0 10px", lineHeight: 1.7 }}>
            自定义考核<strong>通过和家长助手对话创建</strong>：说清「哪个孩子、哪天、考哪些内容」，助手会确定要考的课程并生成计划
            （例如“周五给珊珊安排一次考核，考论语的乡党篇最近学的 3 课”）。左侧选择一次安排，右侧查看它的内容与分配的孩子。
          </p>
          {groups.length === 0 ? (
            <p style={{ color: "#888", fontSize: 13 }}>
              还没有自定义考核。对家长助手说「周五考论语的乡党篇」等，助手创建后就会出现在这里。
            </p>
          ) : (
            <div style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
              {/* 左：自定义考核列表 */}
              <div style={{ width: 320, flexShrink: 0, background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 12, maxHeight: 560, overflowY: "auto" }}>
                {groups.map((g) => {
                  const doneCount = g.rows.filter((r) => r.status === "done").length;
                  const active = g.key === selCustomKey;
                  return (
                    <button
                      key={g.key}
                      onClick={() => setSelCustomKey(g.key)}
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
                      <div style={{ fontSize: 13, fontWeight: 700, color: "#333" }}>📅 {fmtDay(g.scheduledAt)}</div>
                      {g.note && <div style={{ fontSize: 12, color: "#6b7686", marginTop: 2 }}>{g.note}</div>}
                      <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 4 }}>
                        分配给 {g.rows.length} 个孩子{doneCount > 0 ? " · " + doneCount + " 已完成" : ""}
                      </div>
                    </button>
                  );
                })}
              </div>
              {/* 右：选中安排的详情 */}
              <div style={{ flex: 1, minWidth: 0, background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
                {(() => {
                  const g = groups.find((x) => x.key === selCustomKey) || groups[0];
                  if (!g) return <div style={{ color: "#aaa", fontSize: 13 }}>暂无数据</div>;
                  const sc = (g.rows[0]?.scope || {}) as { note?: string; topics?: string[]; courses?: string[]; prompt?: string };
                  const topics = Array.isArray(sc.topics) ? sc.topics : [];
                  const courses = Array.isArray(sc.courses) ? sc.courses : [];
                  const statusLabel = (st: string) => (st === "done" ? "✅ 已完成" : st === "started" ? "🔄 进行中（可继续/补考）" : "⏳ 待考核");
                  return (
                    <div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", marginBottom: 6 }}>
                        <span style={{ fontWeight: 800, fontSize: 16 }}>📅 {fmtDay(g.scheduledAt)}</span>
                        <span style={{ fontSize: 12, color: "#8a94a6" }}>自定义考核 · 共 {g.rows.length} 个孩子</span>
                      </div>
                      {g.note ? <div style={{ fontSize: 13, color: "#555", marginBottom: 8 }}>说明：{g.note}</div> : null}
                      {topics.length > 0 && (
                        <div style={{ marginBottom: 8 }}>
                          <span style={{ fontSize: 12, fontWeight: 700, color: "#3b4cca" }}>主题：</span>
                          {topics.map((t, i) => (<span key={t} style={{ fontSize: 12 }}>{t}{i < topics.length - 1 ? "、" : ""}</span>))}
                        </div>
                      )}
                      <div style={{ fontSize: 13, fontWeight: 700, margin: "10px 0 6px" }}>📚 要考核的课程</div>
                      {courses.length === 0 ? (
                        <p style={{ color: "#b9770a", fontSize: 12, margin: 0 }}>（这次安排没有列出具体课程，请在家长助手那边重新确认课程后生成）</p>
                      ) : (
                        <div style={{ background: "#fff", border: "1px solid #e6eaf0", borderRadius: 8, padding: "6px 10px" }}>
                          {courses.map((c, i) => (<div key={c} style={{ fontSize: 13, padding: "4px 0", borderBottom: i < courses.length - 1 ? "1px solid #f4f4f4" : "none" }}>{i + 1}. {c}</div>))}
                        </div>
                      )}
                      <div style={{ fontSize: 13, fontWeight: 700, margin: "12px 0 6px" }}>👧 分配的孩子</div>
                      <div style={{ background: "#fff", border: "1px solid #e6eaf0", borderRadius: 8, padding: "6px 10px" }}>
                        {g.rows.map((r) => (
                          <div key={r.childId} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13 }}>
                            <span style={{ fontWeight: 600 }}>{nameOf(r.childId)}</span>
                            <span style={{ fontSize: 12 }}>{statusLabel(String(r.status || ""))}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

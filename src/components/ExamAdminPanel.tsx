/**
 * 家长端「学习考核」面板（家长中心左侧边栏）。
 * 标签组织（点击标签只显示该标签内容）：
 *   - 每天：启用开关 + 考核时间 + 选课 prompt + 保存
 *   - 每周：启用开关 + 周几 + 考核时间 + 选课 prompt + 保存
 *   - 自定义考核：**先设置考核（时间点 + prompt + 内容说明），再分配给孩子**（多孩子可共用一个考核）；
 *     列表按考核聚合，显示分配给哪些孩子、各孩子状态，可单独取消分配/补分配。
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
  daily: "默认：考今天学习/复习过的所有课程",
  weekly: "默认：考本周学习/复习过的所有课程",
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

function statusText(s: ScheduleRow): string {
  if (s.status === "done") return "✓ 已完成";
  if (s.status === "started") return "· 进行中";
  if (s.status === "pending") return s.pending ? "· 可开始" : "· 待考核";
  return "· 已取消";
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
  const [newAt, setNewAt] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newNote, setNewNote] = useState("");
  const [assigned, setAssigned] = useState<string[]>([]); // 创建时分配的孩子（默认全选）
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // 默认分配：全选所有孩子（孩子可共用考核）
  useEffect(() => {
    if (children?.length && assigned.length === 0) setAssigned(children.map((c) => c.childId));
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

  /** 创建一个考核并分配给选中的孩子（每个孩子一条排期，内容相同）。 */
  async function createCustom() {
    if (!newAt) {
      setMsg({ ok: false, text: "请选择考核时间点" });
      return;
    }
    if (!newPrompt.trim()) {
      setMsg({ ok: false, text: "请填写这次考核的 prompt（说明考哪些内容、怎么选课）" });
      return;
    }
    if (!assigned.length) {
      setMsg({ ok: false, text: "请至少选择一个要分配的孩子" });
      return;
    }
    setSaving(true);
    try {
      const iso = new Date(newAt).toISOString();
      const scope = { topics: [], note: newNote.trim() || "自定义考核", prompt: newPrompt.trim() };
      let okCount = 0;
      for (const cid of assigned) {
        const r: any = await window.api.examScheduleCreate(cid, iso, scope);
        if (r?.success) okCount++;
      }
      if (okCount > 0) {
        setMsg({ ok: true, text: `✓ 已创建并分配给 ${okCount} 个孩子，到点可开始` });
        setNewAt("");
        setNewPrompt("");
        setNewNote("");
        loadCustoms();
      } else setMsg({ ok: false, text: "创建失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  /** 把已存在的考核补分配给一个孩子。 */
  async function assignTo(g: CustomGroup, cid: string) {
    setSaving(true);
    try {
      const scope = { topics: [], note: g.note || "自定义考核", prompt: g.prompt };
      const r: any = await window.api.examScheduleCreate(cid, g.scheduledAt, scope);
      if (r?.success) {
        setMsg({ ok: true, text: `✓ 已分配给 ${nameOf(cid)}` });
        loadCustoms();
      } else setMsg({ ok: false, text: r?.error || "分配失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  /** 取消某个孩子的分配（删除该孩子这条排期）。 */
  async function unassign(row: ScheduleRow) {
    if (!window.confirm(`取消分配给 ${nameOf(row.childId)} 吗？`)) return;
    try {
      const r: any = await window.api.examScheduleCancel(row.id);
      if (r?.success) {
        setMsg({ ok: true, text: "✓ 已取消分配" });
        loadCustoms();
      } else setMsg({ ok: false, text: r?.error || "操作失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    }
  }

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
    <div style={{ maxWidth: 720 }}>
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
          <div style={label}>选课规则 prompt（AI 按规则从今天学习/复习过的课程中挑选）</div>
          <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>{DEFAULT_HINTS.daily}。清空保存 = 恢复系统默认。</p>
          <textarea
            value={prompts.daily ?? ""}
            placeholder={`（未设置，使用默认规则：${DEFAULT_HINTS.daily}）`}
            onChange={(e) => setPrompts((p) => ({ ...p, daily: e.target.value }))}
            style={ta}
          />
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setPrompts((p) => ({ ...p, daily: "" }))} style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#6b7686", cursor: "pointer", marginRight: 8 }}>
              恢复默认
            </button>
            <button onClick={saveFixed} disabled={saving} style={saveBtn}>
              {saving ? "保存中…" : "保存固定配置"}
            </button>
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
          <div style={label}>选课规则 prompt（AI 按规则从本周学习/复习过的课程中挑选）</div>
          <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>{DEFAULT_HINTS.weekly}。清空保存 = 恢复系统默认。</p>
          <textarea
            value={prompts.weekly ?? ""}
            placeholder={`（未设置，使用默认规则：${DEFAULT_HINTS.weekly}）`}
            onChange={(e) => setPrompts((p) => ({ ...p, weekly: e.target.value }))}
            style={ta}
          />
          <div style={{ marginTop: 14 }}>
            <button onClick={() => setPrompts((p) => ({ ...p, weekly: "" }))} style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#6b7686", cursor: "pointer", marginRight: 8 }}>
              恢复默认
            </button>
            <button onClick={saveFixed} disabled={saving} style={saveBtn}>
              {saving ? "保存中…" : "保存固定配置"}
            </button>
          </div>
        </div>
      )}

      {/* ===== 自定义考核（先设置考核，再分配给孩子） ===== */}
      {tab === "custom" && (
        <div style={box}>
          <div style={label}>📝 自定义考核（先设置考核，再分配给孩子；多孩子可共用）</div>

          {/* 创建表单：先考核内容，再分配 */}
          <div style={{ background: "#f8fafc", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>① 设置考核</div>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <span style={{ fontSize: 13 }}>考核时间：</span>
              <input type="datetime-local" value={newAt} onChange={(e) => setNewAt(e.target.value)} style={inputStyle} />
            </div>
            <textarea
              value={newPrompt}
              onChange={(e) => setNewPrompt(e.target.value)}
              placeholder="考核 prompt（必填）：说明这次考哪些内容、怎么选课。例如「考论语乡党篇最近学的 5 课，每课考完整」"
              style={{ ...ta, minHeight: 160, marginBottom: 8 }}
            />
            <input
              type="text"
              value={newNote}
              onChange={(e) => setNewNote(e.target.value)}
              placeholder="内容说明（可选，给孩子端展示，如：考论语的乡党篇）"
              style={{ width: "100%", boxSizing: "border-box", ...inputStyle, marginBottom: 4 }}
            />

            <div style={{ fontSize: 13, fontWeight: 600, marginTop: 12, marginBottom: 6 }}>② 分配给孩子</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 10 }}>
              {(children || []).map((c) => (
                <label key={c.childId} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={assigned.includes(c.childId)}
                    onChange={(e) =>
                      setAssigned((p) => (e.target.checked ? (p.includes(c.childId) ? p : [...p, c.childId]) : p.filter((x) => x !== c.childId)))
                    }
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <button
              onClick={createCustom}
              disabled={saving}
              style={{ padding: "7px 18px", borderRadius: 8, border: "none", background: "#f2994a", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
            >
              {saving ? "创建中…" : "＋ 创建并分配"}
            </button>
          </div>

          {/* 已安排的考核（按考核聚合，显示分配的孩子） */}
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>已安排的考核（{groups.length}）</div>
          {groups.length === 0 ? (
            <p style={{ color: "#888", fontSize: 12, margin: 0 }}>
              还没有自定义考核。可以在上面设置考核并分配给孩子，或对家长助手说「周五晚上考论语的乡党篇」。
            </p>
          ) : (
            groups.map((g) => {
              const assignedIds = g.rows.map((r) => r.childId);
              const unassignedKids = (children || []).filter((c) => !assignedIds.includes(c.childId));
              return (
                <div key={g.key} style={{ border: "1px solid #eef0f4", borderRadius: 8, padding: "10px 12px", marginBottom: 8, background: "#fcfcfd" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{fmtTime(g.scheduledAt)}</span>
                    {g.note && <span style={{ fontSize: 12, color: "#6b7686" }}>内容：{g.note}</span>}
                  </div>
                  {g.prompt && <div style={{ fontSize: 11, color: "#8a94a6", marginTop: 2 }}>prompt：{g.prompt.slice(0, 60)}…</div>}
                  <div style={{ marginTop: 8 }}>
                    <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>分配给：</div>
                    {g.rows.map((r) => (
                      <div key={r.id} style={{ display: "inline-flex", alignItems: "center", gap: 6, border: "1px solid #e4e8ef", borderRadius: 99, padding: "2px 10px", marginRight: 6, marginBottom: 4, background: "#fff" }}>
                        <span style={{ fontSize: 12 }}>{nameOf(r.childId)}</span>
                        <span style={{ fontSize: 11, color: r.status === "done" ? "#27ae60" : r.status === "pending" ? "#b9770a" : "#999" }}>{statusText(r)}</span>
                        <button
                          onClick={() => unassign(r)}
                          title={`取消分配给 ${nameOf(r.childId)}`}
                          style={{ border: "none", background: "none", color: "#b33", cursor: "pointer", fontSize: 13, padding: 0 }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    {unassignedKids.map((c) => (
                      <button
                        key={c.childId}
                        onClick={() => assignTo(g, c.childId)}
                        disabled={saving}
                        title={`把这次考核也分配给 ${c.name}`}
                        style={{ fontSize: 12, padding: "2px 10px", borderRadius: 99, border: "1px dashed #b7c3d8", background: "#fff", color: "#5a6f9e", cursor: "pointer", marginRight: 6, marginBottom: 4 }}
                      >
                        ＋{c.name}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {msg && (
        <div style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33", marginBottom: 10 }}>{msg.text}</div>
      )}
    </div>
  );
}

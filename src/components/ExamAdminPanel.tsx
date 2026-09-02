/**
 * 家长端「学习考核」面板（家长中心左侧边栏，从「设置 → 学习考核」迁出）。
 * - 标签管理：每天 / 每周——每档含「是否启用 + 选课 prompt（可编辑，清空保存=恢复默认）+ 考核时间」；
 *   每周可设「周几的几点」。
 * - 月度/半年/年度不再作为固定档（由自定义考核灵活安排）。
 * - 自定义考核（孩子级，可创建多个）：每个有自己的「考核 prompt + 考核时间点（日期时间）」，
 *   到点由 LLM 按该次考核的 prompt 选课出题；也可让家长助手动对话创建。
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
  kind: string;
  freq: string;
  scheduledAt: string;
  status: string;
  title: string;
  scope: Record<string, unknown>;
  pending: boolean;
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ExamAdminPanel({ children }: { children: any[] }) {
  const [childId, setChildId] = useState<string>("");
  // 标签
  const [tab, setTab] = useState<"daily" | "weekly">("daily");
  // 每天
  const [enabledDaily, setEnabledDaily] = useState(true);
  const [dailyTime, setDailyTime] = useState("20:00");
  // 每周
  const [enabledWeekly, setEnabledWeekly] = useState(true);
  const [weeklyWeekday, setWeeklyWeekday] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState("20:00");
  // 各档 prompt
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  // 自定义排期
  const [customs, setCustoms] = useState<ScheduleRow[]>([]);
  const [newAt, setNewAt] = useState("");
  const [newPrompt, setNewPrompt] = useState("");
  const [newNote, setNewNote] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // 默认选第一个孩子
  useEffect(() => {
    if (!childId && children?.length) setChildId(children[0].childId);
  }, [children, childId]);

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

  // 加载选中孩子的自定义排期
  const loadCustoms = useCallback(async (cid: string) => {
    if (!cid) return;
    try {
      const r: any = await window.api.examSchedules(cid);
      if (!r?.success) return;
      const all = r.data?.schedules || [];
      setCustoms(all.filter((s: any) => s.kind === "custom"));
    } catch {
      /* 静默 */
    }
  }, []);
  useEffect(() => {
    loadCustoms(childId);
  }, [childId, loadCustoms]);

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

  async function createCustom() {
    if (!childId) {
      setMsg({ ok: false, text: "请先选择孩子" });
      return;
    }
    if (!newAt) {
      setMsg({ ok: false, text: "请选择考核时间点" });
      return;
    }
    if (!newPrompt.trim()) {
      setMsg({ ok: false, text: "请填写这次考核的 prompt（说明考哪些课、怎么选）" });
      return;
    }
    setSaving(true);
    try {
      const iso = new Date(newAt).toISOString();
      const scope = { topics: [], note: newNote.trim() || "自定义考核", prompt: newPrompt.trim() };
      const r: any = await window.api.examScheduleCreate(childId, iso, scope);
      if (r?.success) {
        setMsg({ ok: true, text: "✓ 已创建自定义考核，孩子端到点可开始" });
        setNewAt("");
        setNewPrompt("");
        setNewNote("");
        loadCustoms(childId);
      } else setMsg({ ok: false, text: r?.error || "创建失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setSaving(false);
    }
  }

  async function cancelCustom(id: string) {
    if (!window.confirm("确定取消这次考核吗？")) return;
    try {
      const r: any = await window.api.examScheduleCancel(id);
      if (r?.success) {
        setMsg({ ok: true, text: "✓ 已取消" });
        loadCustoms(childId);
      } else setMsg({ ok: false, text: r?.error || "取消失败" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    }
  }

  const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const box: React.CSSProperties = { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 };
  const ta: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 72,
    resize: "vertical",
    borderRadius: 8,
    border: "1px solid #ddd",
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.6,
    fontFamily: "inherit",
    color: "#333",
  };
  const inputStyle: React.CSSProperties = { padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13 };

  const currentEnabled = tab === "daily" ? enabledDaily : enabledWeekly;
  const toggleEnabled = (v: boolean) => (tab === "daily" ? setEnabledDaily(v) : setEnabledWeekly(v));

  return (
    <div style={{ maxWidth: 720 }}>
      <h3 style={{ marginBottom: 4 }}>🎯 学习考核</h3>
      <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
        固定考核按「每天 / 每周」标签分别管理；月度、半年、年度考核由下方自定义考核灵活安排（每次一个 prompt + 时间点）。
      </p>

      {/* ===== 固定考核（标签管理：每天 / 每周） ===== */}
      <div style={box}>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {(
            [
              ["daily", "每天"],
              ["weekly", "每周"],
            ] as Array<[string, string]>
          ).map(([k, l]) => (
            <button
              key={k}
              onClick={() => setTab(k as "daily" | "weekly")}
              style={{
                padding: "7px 20px",
                borderRadius: 8,
                border: tab === k ? "2px solid #667eea" : "1px solid #e0e4ea",
                background: tab === k ? "#eef1ff" : "#fff",
                color: tab === k ? "#3b4cca" : "#555",
                fontSize: 13,
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              {l}
            </button>
          ))}
        </div>

        {/* 启用 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <input type="checkbox" checked={currentEnabled} onChange={(e) => toggleEnabled(e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>启用{tab === "daily" ? "每日" : "每周"}考核</span>
          {!currentEnabled && <span style={{ fontSize: 12, color: "#999" }}>（关闭后不会自动生成{tab === "daily" ? "每日" : "每周"}考核）</span>}
        </div>

        {/* 考核时间 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>考核时间：</span>
          {tab === "weekly" && (
            <>
              <select value={weeklyWeekday} onChange={(e) => setWeeklyWeekday(Number(e.target.value))} style={inputStyle}>
                {WEEKDAYS.map((w) => (
                  <option key={w.v} value={w.v}>
                    {w.label}
                  </option>
                ))}
              </select>
              <span style={{ color: "#888", fontSize: 12 }}>（每周{weeklyWeekday === 7 ? "日" : WEEKDAYS.find((w) => w.v === weeklyWeekday)?.label}）</span>
            </>
          )}
          <input
            type="time"
            value={tab === "daily" ? dailyTime : weeklyTime}
            onChange={(e) => (tab === "daily" ? setDailyTime(e.target.value || "20:00") : setWeeklyTime(e.target.value || "20:00"))}
            style={inputStyle}
          />
        </div>

        {/* 选课 prompt */}
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
          选课规则 prompt（AI 按规则从本周期学习/复习过的课程中挑选）
        </div>
        <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0, marginBottom: 6 }}>
          {DEFAULT_HINTS[tab]}。清空保存 = 恢复系统默认。
        </p>
        <textarea
          value={prompts[tab] ?? ""}
          placeholder={`（未设置，使用默认规则：${DEFAULT_HINTS[tab]}）`}
          onChange={(e) => setPrompts((p) => ({ ...p, [tab]: e.target.value }))}
          style={ta}
        />
        <button
          onClick={() => setPrompts((p) => ({ ...p, [tab]: "" }))}
          style={{ fontSize: 11, padding: "3px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#6b7686", cursor: "pointer", marginTop: 4 }}
        >
          恢复默认
        </button>

        <div style={{ marginTop: 14 }}>
          <button
            onClick={saveFixed}
            disabled={saving}
            style={{ padding: "8px 22px", borderRadius: 8, border: "none", background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer" }}
          >
            {saving ? "保存中…" : "保存固定配置"}
          </button>
        </div>
      </div>

      {/* ===== 自定义考核（可创建多个，每个有自己的 prompt + 时间点） ===== */}
      <div style={box}>
        <div style={label}>📝 自定义考核（月度/半年/年度等灵活安排，可建多个）</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13 }}>孩子：</span>
          <select value={childId} onChange={(e) => setChildId(e.target.value)} style={inputStyle}>
            {(children || []).map((c) => (
              <option key={c.childId} value={c.childId}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* 创建表单 */}
        <div style={{ background: "#f8fafc", borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>设置考核时间点 + prompt</div>
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
            <input type="datetime-local" value={newAt} onChange={(e) => setNewAt(e.target.value)} style={inputStyle} />
            <button
              onClick={createCustom}
              disabled={saving}
              style={{ padding: "7px 18px", borderRadius: 8, border: "none", background: "#f2994a", color: "#fff", fontSize: 13, cursor: "pointer", fontWeight: 600 }}
            >
              {saving ? "创建中…" : "＋ 创建考核"}
            </button>
          </div>
          <textarea
            value={newPrompt}
            onChange={(e) => setNewPrompt(e.target.value)}
            placeholder="考核 prompt（必填）：说明这次考哪些内容、怎么选课。例如「考论语乡党篇最近学的 5 课，每课考完整」"
            style={{ ...ta, minHeight: 56, marginBottom: 8 }}
          />
          <input
            type="text"
            value={newNote}
            onChange={(e) => setNewNote(e.target.value)}
            placeholder="内容说明（可选，给孩子端展示，如：考论语的乡党篇）"
            style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 12 }}
          />
        </div>

        {/* 自定义排期列表 */}
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>已安排的自定义考核（{customs.length}）</div>
        {customs.length === 0 ? (
          <p style={{ color: "#888", fontSize: 12, margin: 0 }}>
            还没有自定义考核。可以在上面设置时间点创建，或对家长助手说「周五晚上考论语的乡党篇」。
          </p>
        ) : (
          customs
            .slice()
            .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
            .map((s) => (
              <div
                key={s.id}
                style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", border: "1px solid #eef0f4", borderRadius: 8, marginBottom: 6, background: "#fcfcfd" }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {fmtTime(s.scheduledAt)}
                    <span style={{ fontWeight: 400, color: s.status === "done" ? "#27ae60" : s.status === "pending" ? "#b9770a" : "#999", marginLeft: 8 }}>
                      {s.status === "done" ? "✓ 已完成" : s.status === "pending" ? (s.pending ? "· 可开始" : "· 待考核") : s.status === "started" ? "· 进行中" : "· 已取消"}
                    </span>
                  </div>
                  {String(s.scope?.note || "") && <div style={{ fontSize: 12, color: "#6b7686" }}>内容：{String(s.scope.note)}</div>}
                  {String(s.scope?.prompt || "") && (
                    <div style={{ fontSize: 11, color: "#8a94a6" }}>prompt：{String(s.scope.prompt).slice(0, 60)}…</div>
                  )}
                </div>
                {s.status === "pending" && (
                  <button
                    onClick={() => cancelCustom(s.id)}
                    style={{ fontSize: 12, padding: "4px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", color: "#b33", cursor: "pointer" }}
                  >
                    取消
                  </button>
                )}
              </div>
            ))
        )}
      </div>

      {msg && (
        <div style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33", marginBottom: 10 }}>{msg.text}</div>
      )}
    </div>
  );
}

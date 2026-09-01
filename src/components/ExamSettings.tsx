/**
 * 家长端「设置 → 学习考核」：固定考核频率配置 + 各周期选课规则编辑（EXAM-REQUIREMENTS §14.1/14.2/14.9）。
 * - 频率档多选（每天/每周/每月/每半年/每年）：系统按档位滚动生成排期，同一时间点多档重叠只考周期最长档；
 * - 各周期「选课规则」：到考核时间点，AI 按该周期的选课规则（家长可编辑，缺省有默认模板）
 *   从「本周期学习/复习过的课程」清单里挑选要考的课程，每门课完整考核；清空某档保存 = 恢复默认；
 * - 自定义考核请直接对家长助手说（如「周五晚上考论语的乡党篇」），会生成一次性排期。
 */
import { useEffect, useState } from "react";

const FREQS: Array<{ id: string; label: string }> = [
  { id: "daily", label: "每天" },
  { id: "weekly", label: "每周" },
  { id: "monthly", label: "每月" },
  { id: "halfyear", label: "每半年" },
  { id: "yearly", label: "每年" },
];

const FREQ_HINTS: Record<string, string> = {
  daily: "默认：考今天学习/复习过的所有课程",
  weekly: "默认：考本周学习/复习过的所有课程",
  monthly: "默认：每主题考本月课程的 50%，再从本月前课程按 25% 挑选",
  halfyear: "默认：每主题按 40% 比例抽取",
  yearly: "默认：每主题按 60% 比例抽取",
};

export default function ExamSettings() {
  const [freqs, setFreqs] = useState<string[]>(["weekly"]);
  const [time, setTime] = useState("20:00");
  const [prompts, setPrompts] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.api.examFixedConfig().then((r: any) => {
      if (r?.success && r.data?.config) {
        const c = r.data.config;
        if (Array.isArray(c.frequencies)) setFreqs(c.frequencies);
        if (c.time) setTime(c.time);
        if (c.selectionPrompts && typeof c.selectionPrompts === "object") setPrompts(c.selectionPrompts);
      }
    });
  }, []);

  async function save() {
    if (!freqs.length) {
      setMsg({ ok: false, text: "至少勾选一个考核频率" });
      return;
    }
    setSaving(true);
    try {
      // 传全部 5 档选课规则；空字符串 = 恢复该档默认
      const r: any = await window.api.examFixedConfigSave({ frequencies: freqs, time, selectionPrompts: prompts });
      if (r?.success) {
        setMsg({ ok: true, text: "✓ 已保存（排期按新频率自动生成；选课规则即时生效）" });
        // 刷新：清空档位回显服务端默认模板
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

  const label: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 6 };
  const box: React.CSSProperties = { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14 };
  const ta: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    minHeight: 64,
    resize: "vertical",
    borderRadius: 8,
    border: "1px solid #ddd",
    padding: "8px 10px",
    fontSize: 12,
    lineHeight: 1.6,
    fontFamily: "inherit",
    color: "#333",
  };

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>📋 固定考核（自动按周期安排）</div>
      <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
        到考核时间点，系统会把该周期内学习/复习过的课程清单交给 AI，AI 按每个周期各自的「选课规则」
        （下方可编辑）挑选要考的课程，每门课完整考核。孩子端会显示考核时间点列表，到点可点击开始。
      </p>

      <div style={box}>
        <div style={label}>考核频率（可多选；同一天多档重叠时只考周期最长的一档）</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {FREQS.map((f) => (
            <label key={f.id} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={freqs.includes(f.id)}
                onChange={(e) => {
                  if (e.target.checked) setFreqs((p) => (p.includes(f.id) ? p : [...p, f.id]));
                  else setFreqs((p) => p.filter((x) => x !== f.id));
                }}
              />
              {f.label}
            </label>
          ))}
        </div>
      </div>

      <div style={box}>
        <div style={label}>考核时间点（每天/每周等排期落在该时刻）</div>
        <input
          type="time"
          value={time}
          onChange={(e) => setTime(e.target.value || "20:00")}
          style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13 }}
        />
      </div>

      <div style={box}>
        <div style={label}>🎯 各周期选课规则（AI 按规则从本周期学习/复习过的课程中挑选）</div>
        <p style={{ color: "#6b7686", fontSize: 12, marginTop: 0 }}>
          每个考核周期都有自己的选课规则，决定「考哪些课、考多少」。规则里包含：
          如何获取本周期课程（按首次学习/最近复习日期）、选择原则、如何考核。
          点「恢复默认」清空该档，保存后恢复系统默认规则。
        </p>
        {FREQS.map((f) => (
          <div key={f.id} style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
              <span style={{ fontSize: 13, fontWeight: 700, minWidth: 52 }}>{f.label}</span>
              <span style={{ fontSize: 11, color: "#8a94a6" }}>{FREQ_HINTS[f.id]}</span>
              <span style={{ flex: 1 }} />
              <button
                onClick={() => setPrompts((p) => ({ ...p, [f.id]: "" }))}
                style={{
                  fontSize: 11,
                  padding: "2px 10px",
                  borderRadius: 6,
                  border: "1px solid #ddd",
                  background: "#fff",
                  color: "#6b7686",
                  cursor: "pointer",
                }}
              >
                恢复默认
              </button>
            </div>
            <textarea
              value={prompts[f.id] ?? ""}
              placeholder={`（未设置，使用默认规则：${FREQ_HINTS[f.id]}）`}
              onChange={(e) => setPrompts((p) => ({ ...p, [f.id]: e.target.value }))}
              style={ta}
            />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{ padding: "8px 22px", borderRadius: 8, border: "none", background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer" }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        {msg && (
          <span style={{ fontSize: 12, color: msg.ok ? "#2f8a52" : "#b33" }}>{msg.text}</span>
        )}
      </div>

      <div style={{ ...box, marginTop: 16, background: "#f8fafc" }}>
        <div style={label}>📝 自定义考核</div>
        <p style={{ color: "#6b7686", fontSize: 13, margin: 0 }}>
          想单独安排一次考核？直接在家长助手对话里说，例如「<b>周五晚上考一下论语的乡党篇</b>」——
          会生成一次性排期（时间 + 内容范围），孩子端到点即可开始。
        </p>
      </div>
    </div>
  );
}

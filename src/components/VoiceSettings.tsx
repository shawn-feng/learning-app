/**
 * 语音配置（渠道跟随，2026-10-10 用户拍板）：语音通道跟随「AI模型」开关——
 * - 开启内置 AI 模型（builtin）：语音输入走 TokenHub（wand-asr-v1，与文本同配额池，需语音后付费）；
 *   语音合成用 Edge TTS（免费；TokenHub TTS 引擎待计费开通后加入）。
 * - 启用自定义模型（custom）：语音输入走自配通道（下方 Key 优先，留空复用「自定义模型」同厂商 Key）；
 *   语音合成可选千问 / MiMo 引擎。
 * - 关闭（off）：语音输入不可用。
 */
import { useEffect, useState } from "react";

const ASR_CHANNELS = [
  { id: "qwen", label: "千问（按量付费）", hint: "qwen-audio-3.0-asr-flash · DashScope 按量" },
  { id: "qwen-tokenplan", label: "千问（token-plan 套餐）", hint: "与按量不同的套餐 Key" },
  { id: "mimo", label: "小米 MiMo（按量付费）", hint: "mimo-v2.5-asr · 按量" },
  { id: "mimo-tokenplan", label: "小米 MiMo（token-plan 套餐）", hint: "tp- 开头的套餐 Key" },
] as const;

const TTS_ENGINES = [
  { id: "edge-tts", label: "Edge TTS（默认 · 免费 · 不消耗配额）", needKey: false },
  { id: "qwen", label: "千问 TTS · qwen3-tts-flash（按量）", needKey: true, provider: "qwen" },
  { id: "qwen-tokenplan", label: "千问 TTS（token-plan 套餐）", needKey: true, provider: "qwen-tokenplan" },
  { id: "mimo", label: "MiMo TTS · mimo-v2.5-tts（按量）", needKey: true, provider: "mimo" },
  { id: "mimo-tokenplan", label: "MiMo TTS（token-plan 套餐）", needKey: true, provider: "mimo-tokenplan" },
] as const;

export default function VoiceSettings() {
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  // 渠道跟随：builtin=内置 TokenHub / custom=自定义 / off=停用（与「AI模型」页开关同一状态）
  const [channel, setChannel] = useState<"builtin" | "custom" | "off">("builtin");
  // 自配通道 Key：输入值（空 = 不修改）；keyMasked = 已存打码回显
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [keyMasked, setKeyMasked] = useState<Record<string, string>>({});
  // TTS 引擎
  const [ttsProvider, setTtsProvider] = useState("edge-tts");
  const [providerHasKey, setProviderHasKey] = useState<Record<string, boolean>>({});

  useEffect(() => {
    window.api.voiceConfigGet().then((r: any) => {
      if (!r?.success) return;
      setEnabled(!!r.config?.enabled);
      const m: Record<string, string> = {};
      for (const [p, c] of Object.entries(r.config?.providers || {})) {
        const k = (c as any)?.apiKey || "";
        if (k) m[p] = k;
      }
      setKeyMasked(m);
    }).catch(() => {});
    window.api.piGetModelChannel?.().then((r: any) => {
      if (r?.success && (r.channel === "custom" || r.channel === "off")) setChannel(r.channel);
    }).catch(() => {});
    window.api.piGetTtsConfig().then((r: any) => {
      if (r?.success && r.config?.provider) setTtsProvider(r.config.provider);
    }).catch(() => {});
    // 可用性标注：自定义模型里哪些 provider 已配 Key（TTS/ASR 留空时自动复用）
    window.api.piGetSettings?.().then((r: any) => {
      if (r?.success && Array.isArray(r.providers)) {
        const m: Record<string, boolean> = {};
        for (const p of r.providers) m[p.provider] = !!p.hasKey;
        setProviderHasKey(m);
      }
    }).catch(() => {});
  }, []);

  async function toggleEnabled() {
    const next = !enabled;
    setSaving(true);
    setStatus("");
    try {
      const r = await window.api.voiceConfigSet({ enabled: next, provider: "qwen", providers: {} });
      if (r?.success) {
        setEnabled(next);
        setStatus(next ? "已开启语音输入" : "已关闭语音输入");
      } else {
        setStatus(`保存失败: ${r?.error || ""}`);
      }
    } catch (e: any) {
      setStatus(`保存失败: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveKeys() {
    setSaving(true);
    setStatus("");
    try {
      const providers: Record<string, { apiKey?: string }> = {};
      for (const ch of ASR_CHANNELS) {
        const v = (keys[ch.id] || "").trim();
        if (v) providers[ch.id] = { apiKey: v };
      }
      const r = await window.api.voiceConfigSet({ enabled, provider: "qwen", providers });
      if (r?.success) {
        setKeys({});
        // 重新拉打码回显
        const g = await window.api.voiceConfigGet();
        if (g?.success) {
          const m: Record<string, string> = {};
          for (const [p, c] of Object.entries(g.config?.providers || {})) {
            const k = (c as any)?.apiKey || "";
            if (k) m[p] = k;
          }
          setKeyMasked(m);
        }
        setStatus("语音识别 Key 已保存");
      } else {
        setStatus(`保存失败: ${r?.error || ""}`);
      }
    } catch (e: any) {
      setStatus(`保存失败: ${e.message}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveTtsEngine(provider: string) {
    if (channel !== "custom") return; // 未启用自定义模型时引擎锁定，无可选项
    setTtsProvider(provider);
    // 清掉该引擎已存的音色 → 统一用引擎默认音色（旧版本可能存过音色选择）
    const r = await window.api.piSetTtsConfig({ provider, providers: { [provider]: { voice: "" } } });
    const eng = TTS_ENGINES.find((e) => e.id === provider);
    setStatus(r?.success ? `朗读引擎已切换：${eng?.label || provider}（默认音色）` : `保存失败: ${r?.error || ""}`);
  }

  const customOn = channel === "custom";

  return (
    <div className="settings-section">
      <h3>语音配置</h3>

      {/* ===== 语音输入（识别）：本页只讲自定义语音通道，不涉及内置模型状态 ===== */}
      <h4 style={{ fontSize: 15, marginTop: 8, marginBottom: 4 }}>语音输入（识别）</h4>
      <div style={{
        display: "flex", alignItems: "center", gap: 12, padding: "14px 16px",
        background: customOn ? "#e9f9dc" : "#f8fafc",
        border: customOn ? "1px solid #d7ffb8" : "1px solid #e5e5e5",
        borderRadius: 10, marginBottom: 10,
      }}>
        <span style={{ fontSize: 20 }}>🎙️</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            自定义语音通道{customOn ? " · 使用中" : " · 未启用"}
            {enabled ? "（语音输入已开启）" : ""}
          </div>
          <div style={{ fontSize: 12, color: "#667", marginTop: 2 }}>
            {customOn
              ? "语音识别使用以下自配通道；Key 留空自动复用「自定义模型」里同厂商的 Key。"
              : "自定义模型未启用，当前没有生效的自定义语音通道；可先在下方填写 Key，启用「自定义模型」后即作为语音识别通道。"}
          </div>
        </div>
        <button
          onClick={toggleEnabled}
          disabled={saving}
          style={{
            padding: "6px 16px", borderRadius: 16, border: "none", cursor: "pointer",
            background: enabled ? "#58cc02" : "#e5e5e5", color: enabled ? "white" : "#777777",
          }}
        >
          {enabled ? "已开启" : "已关闭"}
        </button>
      </div>

      <p style={{ fontSize: 12, color: "#889", margin: "0 0 8px" }}>
        {customOn
          ? "Key 留空时自动复用「自定义模型」里同厂商的 Key（两者都不配则该通道不可用）。"
          : "以下配置在启用「自定义模型」后生效。"}
      </p>
      {ASR_CHANNELS.map((ch) => (
        <div key={ch.id} style={{ marginBottom: 10 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 3 }}>
            {ch.label}
            <span style={{ fontSize: 11, color: "#a0aec0", marginLeft: 8 }}>{ch.hint}</span>
          </label>
          <input
            type="password"
            value={keys[ch.id] || ""}
            onChange={(e) => setKeys({ ...keys, [ch.id]: e.target.value })}
            placeholder={keyMasked[ch.id] ? `已保存：${keyMasked[ch.id]}（留空不修改）` : "未单独配置（自动复用自定义模型同名 Key）"}
            style={{ width: "100%", maxWidth: 420, padding: "9px 12px", border: "1px solid #e5e5e5", borderRadius: 8 }}
          />
        </div>
      ))}
      <button
        onClick={saveKeys}
        disabled={saving}
        style={{
          padding: "8px 18px", background: "#58cc02", color: "white",
          border: "none", borderRadius: 8, fontSize: 13, cursor: "pointer",
        }}
      >
        保存识别通道 Key
      </button>

      {/* ===== 语音合成（朗读） ===== */}
      <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #e5e5e5" }}>
        <h4 style={{ fontSize: 15, marginBottom: 4 }}>语音合成（朗读）</h4>
        <p style={{ fontSize: 12, color: "#afafaf", marginBottom: 8 }}>
          选择合成引擎即可（使用各引擎默认音色）；千问 / MiMo 的 Key 自动复用「自定义模型」里同厂商的 Key。
          {customOn ? "" : "启用「自定义模型」后可选其他引擎，当前仅提供 Edge TTS（免费）。"}
        </p>
        <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>合成引擎</label>
        <select
          value={customOn ? ttsProvider : "edge-tts"}
          disabled={!customOn}
          onChange={(e) => saveTtsEngine(e.target.value)}
          style={{
            width: "100%", maxWidth: 420, padding: 10, border: "1px solid #e5e5e5", borderRadius: 8,
            background: customOn ? "white" : "#f1f5f9",
            color: customOn ? "inherit" : "#889",
          }}
        >
          {TTS_ENGINES.map((eng) => {
            const prov = (eng as any).provider as string | undefined;
            const ok = !eng.needKey || (prov ? !!providerHasKey[prov] : false);
            return (
              <option key={eng.id} value={eng.id}>
                {eng.label}{ok ? "" : " —— 需先在「自定义模型」配置同厂商 Key"}
              </option>
            );
          })}
        </select>
      </div>

      {status && (
        <p style={{
          fontSize: 13,
          color: /失败|无法|错误/.test(status) ? "#ff4b4b" : "#58cc02",
          marginTop: 16,
          whiteSpace: "pre-wrap",
        }}>
          {status}
        </p>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { Save } from "lucide-react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";

interface VoiceProviderDef {
  id: string;
  name: string;
  available: boolean;
  fields: { key: string; label: string; readonly?: boolean }[];
}

// 语音输入（ASR）供应商：只保留千问 + 小米 MiMo，各分按量/token-plan 套餐两通道。
// 各通道 apiKey 均可留空——留空时自动复用「模型配置」里同名 provider 的 key（auth.json）。
const VOICE_PROVIDERS: VoiceProviderDef[] = [
  {
    id: "qwen",
    name: "千问 (按量付费)",
    available: true,
    fields: [{ key: "apiKey", label: "API Key（留空自动复用模型配置里的千问按量 Key）" }],
  },
  {
    id: "qwen-tokenplan",
    name: "千问 (token-plan 套餐)",
    available: true,
    fields: [
      { key: "apiKey", label: "API Key（留空自动复用模型配置里的千问套餐 Key）" },
      {
        key: "endpoint",
        label: "ASR 端点（token-plan 套餐通道，固定不可改）",
        readonly: true,
      },
    ],
  },
  {
    id: "mimo",
    name: "小米 MiMo (按量付费)",
    available: true,
    fields: [{ key: "apiKey", label: "API Key（留空自动复用模型配置里的小米 MiMo 按量 Key）" }],
  },
  {
    id: "mimo-tokenplan",
    name: "小米 MiMo (token-plan 套餐)",
    available: true,
    fields: [
      { key: "apiKey", label: "API Key（留空自动复用模型配置里的小米 MiMo 套餐 Key）" },
      {
        key: "endpoint",
        label: "ASR 端点（token-plan 套餐通道，固定不可改）",
        readonly: true,
      },
    ],
  },
];

// 语音合成（TTS）供应商：edge-tts（免费）+ 千问/小米（各分按量与套餐）。
// 与语音输入一致：apiKey 留空自动复用「模型配置」同名 provider 的 key。
const TTS_PROVIDERS: { id: string; name: string; needsKey: boolean }[] = [
  { id: "edge-tts", name: "Edge TTS (免费)", needsKey: false },
  { id: "qwen", name: "千问 (按量付费)", needsKey: true },
  { id: "qwen-tokenplan", name: "千问 (token-plan 套餐)", needsKey: true },
  { id: "mimo", name: "小米 MiMo (按量付费)", needsKey: true },
  { id: "mimo-tokenplan", name: "小米 MiMo (token-plan 套餐)", needsKey: true },
];

export default function VoiceSettings() {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("qwen"); // 当前正在编辑的识别服务
  const [defaultProvider, setDefaultProvider] = useState("qwen"); // 默认识别服务（识别时优先）
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  // 语音合成（TTS）：当前编辑 provider / 默认 provider / 当前字段 / 全量音色清单
  const [ttsProvider, setTtsProvider] = useState("edge-tts");
  const [ttsDefaultProvider, setTtsDefaultProvider] = useState("edge-tts");
  const [ttsFields, setTtsFields] = useState<Record<string, string>>({});
  const [ttsConfigCache, setTtsConfigCache] = useState<any>(null); // 打码后的完整配置快照（切换 provider 时读字段）
  const [ttsVoices, setTtsVoices] = useState<{ provider: string; voiceId: string; name: string }[]>([]);
  const { recording, start, stop } = useAudioRecorder();

  useEffect(() => {
    window.api.voiceConfigGet().then((r: any) => {
      if (r?.success) {
        setEnabled(r.config.enabled);
        setProvider(r.config.provider);
        setDefaultProvider(r.config.provider);
        setFields(r.config.providers[r.config.provider] || {});
      }
    });
  }, []);

  // TTS 配置 + 可选音色清单
  useEffect(() => {
    window.api.piGetTtsConfig().then((r: any) => {
      if (r?.success) {
        setTtsConfigCache(r.config);
        setTtsDefaultProvider(r.config.provider || "edge-tts");
        setTtsProvider(r.config.provider || "edge-tts");
        setTtsFields(r.config.providers?.[r.config.provider || "edge-tts"] || {});
        if (Array.isArray(r.voices)) setTtsVoices(r.voices);
      }
    }).catch(() => {});
  }, []);

  async function switchProvider(id: string) {
    setProvider(id);
    setStatus("");
    const r = await window.api.voiceConfigGet();
    if (r?.success) {
      setFields(r.config.providers[id] || {});
    }
  }

  async function setDefault() {
    setDefaultProvider(provider);
    setStatus(`已将「${currentProvider.name}」设为默认语音输入服务`);
    // 立即持久化默认服务（不依赖点「保存」），避免退出设置页后丢失
    try {
      const r = await window.api.voiceConfigSet({ enabled, provider, providers: {} });
      if (!r.success) {
        setStatus(`默认服务保存失败: ${r.error}`);
      }
    } catch (e: any) {
      setStatus(`默认服务保存失败: ${e.message}`);
    }
  }

  const currentProvider = VOICE_PROVIDERS.find((p) => p.id === provider)!;

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setStatus("");
    if (!currentProvider.available) {
      setStatus("该供应商即将支持，暂不可用");
      return;
    }
    const providers: Record<string, Record<string, string>> = {};
    providers[provider] = fields;
    const result = await window.api.voiceConfigSet({
      enabled,
      provider: defaultProvider,
      providers,
    });
    if (result.success) {
      setStatus("已保存");
      setFields(result.config.providers[provider] || {});
    } else {
      setStatus(`保存失败: ${result.error}`);
    }
  }

  // ===== 语音合成（TTS）操作 =====
  const currentTts = TTS_PROVIDERS.find((p) => p.id === ttsProvider)!;

  function switchTtsProvider(id: string) {
    setTtsProvider(id);
    const cfg = ttsConfigCache;
    setTtsFields(cfg?.providers?.[id] || {});
  }

  function setTtsField(key: string, value: string) {
    setTtsFields((prev) => ({ ...prev, [key]: value }));
  }

  async function saveTts() {
    setStatus("");
    const providers: Record<string, any> = {};
    providers[ttsProvider] = ttsFields;
    const r = await window.api.piSetTtsConfig({ provider: ttsDefaultProvider, providers });
    if (r?.success) {
      setTtsConfigCache(r.config);
      setTtsFields(r.config.providers?.[ttsProvider] || {});
      setStatus(`朗读配置已保存（${currentTts.name}）`);
    } else {
      setStatus(`朗读配置保存失败: ${r?.error || ""}`);
    }
  }

  async function setTtsDefault() {
    setStatus("");
    const r = await window.api.piSetTtsConfig({ provider: ttsProvider });
    if (r?.success) {
      setTtsDefaultProvider(r.provider);
      setTtsConfigCache(r.config);
      setStatus(`已将「${currentTts.name}」设为默认朗读引擎`);
    } else {
      setStatus(`默认朗读引擎保存失败: ${r?.error || ""}`);
    }
  }

  async function handleTest() {
    setStatus("");
    if (!currentProvider.available) {
      setStatus("该供应商即将支持，暂不可用");
      return;
    }
    if (recording) {
      const blob = await stop();
      // 无活跃录音（已停止过/从未开始）：静默返回
      if (!blob) return;
      if (blob.size < 2000) {
        // 空/极短的 webm 容器（无音频帧，只有 EBML 头），ffmpeg 无法解析（Invalid data）
        setStatus("录音太短，请按住说完整的一句话再松手");
        return;
      }
      setTesting(true);
      try {
        const buf = await blob.arrayBuffer();
        // 测试当前编辑的服务（不做 fallback），方便确认凭证是否有效
        const r = await window.api.voiceTranscribe(buf, provider);
        if (r.success) {
          setStatus(`识别结果：${r.text}`);
        } else {
          setStatus(`识别失败: ${r.error}`);
        }
      } catch (e: any) {
        setStatus(`识别失败: ${e.message}`);
      } finally {
        setTesting(false);
      }
    } else {
      try {
        await start();
        setStatus("录音中… 说一句话，再点一次「测试识别」结束");
      } catch (e: any) {
        setStatus(`无法访问麦克风: ${e.message}`);
      }
    }
  }

  return (
    <div className="settings-section">
      <h3>语音配置</h3>

      {/* ===== 第一部分：语音输入（识别） ===== */}
      <h4 style={{ fontSize: 15, marginTop: 8, marginBottom: 4 }}>语音输入（识别）</h4>
      <p className="desc">
        配置语音识别服务（千问 / 小米 MiMo，各分按量与 token-plan 套餐）。API Key 留空时自动复用「模型配置」里对应 provider 的 Key。
        可配置多个服务，其中一个是默认服务——识别时优先用默认服务，若默认服务不可用（未配置凭证或识别失败），会自动切换到其他已配置的服务。
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 500 }}>启用语音输入</label>
        <button
          onClick={() => setEnabled((v) => !v)}
          style={{
            padding: "6px 16px",
            borderRadius: 16,
            border: "none",
            cursor: "pointer",
            background: enabled ? "#667eea" : "#ddd",
            color: enabled ? "white" : "#666",
          }}
        >
          {enabled ? "已开启" : "已关闭"}
        </button>
      </div>

      <div style={{ marginBottom: 8, fontSize: 13, color: "#888" }}>
        选择服务编辑凭证；点「设为默认」把它设为识别时的首选服务：
      </div>
      <div className="provider-list">
        {VOICE_PROVIDERS.map((p) => (
          <div
            key={p.id}
            className={`provider-chip ${provider === p.id ? "active" : ""}`}
            onClick={() => switchProvider(p.id)}
            style={{ opacity: p.available ? 1 : 0.5, position: "relative" }}
          >
            {p.name}
            {defaultProvider === p.id && (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  background: "#f6ad55",
                  color: "white",
                  fontSize: 10,
                  borderRadius: 8,
                  padding: "0 5px",
                  lineHeight: "16px",
                }}
              >
                默认
              </span>
            )}
            {!p.available ? "（即将支持）" : ""}
          </div>
        ))}
      </div>

      {currentProvider.fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>{f.label}</label>
          <input
            type={f.readonly ? "text" : "password"}
            value={fields[f.key] || ""}
            onChange={(e) => setField(f.key, e.target.value)}
            placeholder={f.label}
            disabled={f.readonly}
            style={{
              width: "100%",
              padding: 10,
              border: "1px solid #ddd",
              borderRadius: 8,
              background: f.readonly ? "#f5f5f5" : "white",
              color: f.readonly ? "#666" : "inherit",
            }}
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <IconButton
          icon={Save}
          title="保存"
          onClick={handleSave}
          style={{ padding: "10px 20px", background: "#667eea", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}
        />
        <button
          onClick={setDefault}
          style={{
            padding: "10px 20px",
            background: defaultProvider === provider ? "#edf2f7" : "#f0f4ff",
            color: defaultProvider === provider ? "#718096" : "#667eea",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {defaultProvider === provider ? "✓ 当前默认" : "设为默认"}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            padding: "10px 20px",
            background: recording ? "#e53e3e" : "#f0f4ff",
            color: recording ? "white" : "#667eea",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {testing ? "识别中…" : recording ? "停止并识别" : "测试识别 🎤"}
        </button>
      </div>

      {/* ===== 第二部分：语音合成（朗读） ===== */}
      <div style={{ marginTop: 32, paddingTop: 20, borderTop: "1px solid #eee" }}>
        <h4 style={{ fontSize: 15, marginBottom: 4 }}>语音合成（朗读）</h4>
        <p style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
          孩子朗读 / 语音播报用的合成引擎。可选 <strong>Edge TTS</strong>（免费无需 Key）、<strong>千问</strong>、
          <strong>小米 MiMo</strong>（各分按量与套餐）。各引擎 API Key 留空时自动复用「模型配置」里对应 provider 的 Key。
        </p>

        <div style={{ marginBottom: 8, fontSize: 13, color: "#888" }}>
          选择引擎编辑凭证与音色；点「设为默认」把它设为朗读时的首选引擎：
        </div>
        <div className="provider-list">
          {TTS_PROVIDERS.map((p) => (
            <div
              key={p.id}
              className={`provider-chip ${ttsProvider === p.id ? "active" : ""}`}
              onClick={() => switchTtsProvider(p.id)}
              style={{ position: "relative" }}
            >
              {p.name}
              {ttsDefaultProvider === p.id && (
                <span
                  style={{
                    position: "absolute",
                    top: -8,
                    right: -8,
                    background: "#f6ad55",
                    color: "white",
                    fontSize: 10,
                    borderRadius: 8,
                    padding: "0 5px",
                    lineHeight: "16px",
                  }}
                >
                  默认
                </span>
              )}
            </div>
          ))}
        </div>

        {currentTts.needsKey && (
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>
              API Key（留空自动复用模型配置里的同名 Key）
            </label>
            <input
              type="password"
              value={ttsFields.apiKey || ""}
              onChange={(e) => setTtsField("apiKey", e.target.value)}
              placeholder="API Key（留空 = 用模型配置里的 Key）"
              style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
            />
          </div>
        )}

        <div style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>朗读音色</label>
          <select
            value={ttsFields.voice || ""}
            onChange={(e) => setTtsField("voice", e.target.value)}
            style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
          >
            <option value="">{currentTts.id === "edge-tts" ? "自动（按语言选音色）" : "默认音色"}</option>
            {ttsVoices
              .filter((v) => v.provider === ttsProvider)
              .map((v) => (
                <option key={v.voiceId} value={v.voiceId}>
                  {v.name}
                </option>
              ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <IconButton
            icon={Save}
            title="保存朗读配置"
            onClick={saveTts}
            style={{ padding: "10px 20px", background: "#667eea", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}
          />
          <button
            onClick={setTtsDefault}
            style={{
              padding: "10px 20px",
              background: ttsDefaultProvider === ttsProvider ? "#edf2f7" : "#f0f4ff",
              color: ttsDefaultProvider === ttsProvider ? "#718096" : "#667eea",
              border: "none",
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            {ttsDefaultProvider === ttsProvider ? "✓ 当前默认" : "设为默认"}
          </button>
        </div>
      </div>

      {status && (
        <p
          style={{
            fontSize: 13,
            color: /失败|无法|错误/.test(status) ? "#e53e3e" : "#667eea",
            marginTop: 16,
            whiteSpace: "pre-wrap",
          }}
        >
          {status}
        </p>
      )}
    </div>
  );
}

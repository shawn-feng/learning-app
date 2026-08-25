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

const VOICE_PROVIDERS: VoiceProviderDef[] = [
  {
    id: "aliyun",
    name: "阿里云",
    available: true,
    fields: [
      { key: "appKey", label: "AppKey" },
      { key: "accessKeyId", label: "AccessKey ID" },
      { key: "accessKeySecret", label: "AccessKey Secret" },
    ],
  },
  {
    id: "tencent",
    name: "腾讯云",
    available: true,
    fields: [
      { key: "secretId", label: "SecretId" },
      { key: "secretKey", label: "SecretKey" },
    ],
  },
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
      { key: "apiKey", label: "API Key（token-plan 套餐专用 Key，与按量不同）" },
      {
        key: "endpoint",
        label: "ASR 端点（token-plan 套餐通道，固定不可改）",
        readonly: true,
      },
    ],
  },
  {
    id: "iflytek",
    name: "讯飞",
    available: false,
    fields: [
      { key: "appId", label: "AppId" },
      { key: "apiKey", label: "ApiKey" },
      { key: "apiSecret", label: "ApiSecret" },
    ],
  },
  {
    id: "baidu",
    name: "百度",
    available: false,
    fields: [
      { key: "appId", label: "AppId" },
      { key: "apiKey", label: "ApiKey" },
      { key: "secretKey", label: "SecretKey" },
    ],
  },
];

export default function VoiceSettings() {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("aliyun"); // 当前正在编辑的服务
  const [defaultProvider, setDefaultProvider] = useState("aliyun"); // 默认服务（识别时优先）
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
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
    setStatus(`已将「${currentProvider.name}」设为默认语音服务`);
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
      <p className="desc">
        配置云端语音识别服务（阿里云、千问、腾讯云等）。可配置多个服务，其中一个是默认服务——识别时优先用默认服务，若默认服务不可用（未配置凭证或识别失败），会自动切换到其他已配置的服务。凭证仅保存在本机。
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

import { useEffect, useState } from "react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";

interface VoiceProviderDef {
  id: string;
  name: string;
  available: boolean;
  fields: { key: string; label: string }[];
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
  const [provider, setProvider] = useState("aliyun");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const { recording, start, stop } = useAudioRecorder();

  useEffect(() => {
    window.api.voiceConfigGet().then((r: any) => {
      if (r?.success) {
        setEnabled(r.config.enabled);
        setProvider(r.config.provider);
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
    const result = await window.api.voiceConfigSet({ enabled, provider, providers });
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
      setTesting(true);
      try {
        const buf = await blob.arrayBuffer();
        const r = await window.api.voiceTranscribe(buf);
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
        配置云端语音识别服务（阿里云、腾讯云等）。启用后，孩子可在聊天界面按住麦克风说话，语音会自动转成文字。凭证仅保存在本机。
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

      <div className="provider-list">
        {VOICE_PROVIDERS.map((p) => (
          <div
            key={p.id}
            className={`provider-chip ${provider === p.id ? "active" : ""}`}
            onClick={() => switchProvider(p.id)}
            style={{ opacity: p.available ? 1 : 0.5 }}
          >
            {p.name}
            {!p.available ? "（即将支持）" : ""}
          </div>
        ))}
      </div>

      {currentProvider.fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>{f.label}</label>
          <input
            type="password"
            value={fields[f.key] || ""}
            onChange={(e) => setField(f.key, e.target.value)}
            placeholder={f.label}
            style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
          />
        </div>
      ))}

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <button
          onClick={handleSave}
          style={{ padding: "10px 20px", background: "#667eea", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}
        >
          保存
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

import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { Save } from "lucide-react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";

interface AssessmentProviderDef {
  id: string;
  name: string;
  desc: string;
  fields: { key: string; label: string; placeholder?: string }[];
}

// 发音评测供应商：腾讯云智聆口语评测（新版）+ 阿里云儿童单词评测。
// 智聆：AppID + SecretId + SecretKey（腾讯云 API 密钥 + AppID，控制台「智聆口语评测」开通）。
// 阿里：AppKey + AppSecret（阿里云「智能科教-口语评测」控制台获取），User ID 可选（默认 pi-child）。
const ASSESSMENT_PROVIDERS: AssessmentProviderDef[] = [
  {
    id: "tencent-soe",
    name: "腾讯云智聆",
    desc: "口语评测（新版）WebSocket 流式，音素级反馈，儿童苛刻度自动最低档",
    fields: [
      { key: "appId", label: "AppID", placeholder: "腾讯云 AppID（数字）" },
      { key: "secretId", label: "SecretId", placeholder: "腾讯云 API 密钥 SecretId" },
      { key: "secretKey", label: "SecretKey", placeholder: "腾讯云 API 密钥 SecretKey" },
    ],
  },
  {
    id: "aliyun-kid",
    name: "阿里云儿童单词",
    desc: "智能科教-口语评测（en.word_kid.score，12 岁以下儿童单词跟读评测）",
    fields: [
      { key: "appKey", label: "AppKey", placeholder: "阿里云口语评测 AppKey" },
      { key: "appSecret", label: "AppSecret", placeholder: "阿里云口语评测 AppSecret" },
      { key: "userId", label: "User ID（可选）", placeholder: "留空默认 pi-child" },
    ],
  },
];

export default function AssessmentSettings() {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("tencent-soe"); // 当前正在编辑的服务
  const [defaultProvider, setDefaultProvider] = useState("tencent-soe"); // 默认评测服务
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  const { recording, start, stop } = useAudioRecorder();

  useEffect(() => {
    window.api.assessmentConfigGet().then((r: any) => {
      if (r?.success) {
        setEnabled(r.config.enabled);
        setProvider(r.config.provider);
        setDefaultProvider(r.config.provider);
        setFields(r.config.providers[r.config.provider] || {});
      }
    });
  }, []);

  const currentProvider = ASSESSMENT_PROVIDERS.find((p) => p.id === provider)!;

  async function switchProvider(id: string) {
    setProvider(id);
    setStatus("");
    const r = await window.api.assessmentConfigGet();
    if (r?.success) setFields(r.config.providers[id] || {});
  }

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setStatus("");
    const providers: Record<string, Record<string, string>> = {};
    providers[provider] = fields;
    const r = await window.api.assessmentConfigSet({
      enabled,
      provider: defaultProvider,
      providers,
    });
    if (r?.success) {
      setStatus("已保存");
      setFields(r.config.providers[provider] || {});
    } else {
      setStatus(`保存失败: ${r?.error || ""}`);
    }
  }

  async function setDefault() {
    setStatus("");
    const r = await window.api.assessmentConfigSet({
      enabled,
      provider,
      providers: {},
    });
    if (r?.success) {
      setDefaultProvider(r.config.provider);
      setStatus(`已将「${currentProvider.name}」设为默认评测服务`);
    } else {
      setStatus(`保存失败: ${r?.error || ""}`);
    }
  }

  // 测试：录音 → 评测固定单词 "hello"，验证凭证与链路
  async function handleTest() {
    setStatus("");
    if (recording) {
      const blob = await stop();
      if (!blob) return;
      if (blob.size < 2000) {
        setStatus("录音太短，请按住说完整的一句话再松手");
        return;
      }
      setTesting(true);
      try {
        const buf = await blob.arrayBuffer();
        const r = await window.api.assessmentTest(buf, provider, "hello");
        if (r.success) {
          const res = r.result;
          setStatus(
            `评测成功：总分 ${res.score} 分` +
              (res.accuracy !== undefined ? `，准确度 ${res.accuracy}` : "") +
              (res.fluency !== undefined ? `，流利度 ${res.fluency}` : "") +
              (res.completeness !== undefined ? `，完整度 ${res.completeness}` : "") +
              `（${res.words.length} 个词）`
          );
        } else {
          setStatus(`评测失败: ${r.error}`);
        }
      } catch (e: any) {
        setStatus(`评测失败: ${e.message}`);
      } finally {
        setTesting(false);
      }
    } else {
      try {
        await start();
        setStatus("录音中… 说「hello」，再点一次「测试评测」结束");
      } catch (e: any) {
        setStatus(`无法访问麦克风: ${e.message}`);
      }
    }
  }

  return (
    <div className="settings-section">
      <h3>发音评测</h3>
      <p className="desc">
        英语口语发音评测服务（英语角模式下，孩子每条语音自动评测发音并指出问题）。
        可配置多个服务，其中一个是默认服务——评测时优先用默认服务，未配置或失败时自动切换到其他已配置服务。
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 500 }}>启用发音评测</label>
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
        选择服务编辑凭证；点「设为默认」把它设为评测时的首选服务：
      </div>
      <div className="provider-list">
        {ASSESSMENT_PROVIDERS.map((p) => (
          <div
            key={p.id}
            className={`provider-chip ${provider === p.id ? "active" : ""}`}
            onClick={() => switchProvider(p.id)}
            style={{ position: "relative" }}
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
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#999", margin: "8px 0 12px" }}>{currentProvider.desc}</p>

      {currentProvider.fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>{f.label}</label>
          <input
            type="password"
            value={fields[f.key] || ""}
            onChange={(e) => setField(f.key, e.target.value)}
            placeholder={f.placeholder}
            style={{ width: "100%", padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
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
          {testing ? "评测中…" : recording ? "停止并评测" : "测试评测 🎤"}
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

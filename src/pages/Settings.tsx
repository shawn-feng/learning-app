import { useState, useEffect } from "react";
import SkillImport from "../components/SkillImport";
import SkillEditor from "./SkillEditor";
import VoiceSettings from "../components/VoiceSettings";
import SchedulerSettings from "../components/SchedulerSettings";
import GeneralSettings from "../components/GeneralSettings";
import TopicEditor from "../components/TopicEditor";

const PROVIDERS = [
  { id: "deepseek", name: "DeepSeek", keyHint: "sk-..." },
  { id: "qwen", name: "通义千问", keyHint: "sk-..." },
  { id: "anthropic", name: "Anthropic Claude", keyHint: "sk-ant-..." },
  { id: "openai", name: "OpenAI", keyHint: "sk-..." },
  { id: "google", name: "Google Gemini", keyHint: "AIza..." },
  { id: "openrouter", name: "OpenRouter", keyHint: "sk-or-..." },
  { id: "groq", name: "Groq", keyHint: "gsk_..." },
];

export default function Settings() {
  const [tab, setTab] = useState<"models" | "skills" | "editor" | "voice" | "scheduler" | "general" | "topics">("models");
  const [selectedProvider, setSelectedProvider] = useState("deepseek");
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem("defaultModel") || "");

  // 初始值以主进程存储（app-settings.json）为准，与 ModelSelector / 会话建链同源；
  // 若主进程尚无记录但有旧的 localStorage 值，则迁移过去。
  useEffect(() => {
    window.api.piGetDefaultModel().then((r: any) => {
      if (r?.success && r.key) {
        setDefaultModel(r.key);
      } else {
        const ls = localStorage.getItem("defaultModel") || "";
        if (ls) {
          setDefaultModel(ls);
          window.api.piSetDefaultModel(ls);
        } else {
          setDefaultModel("");
        }
      }
    }).catch(() => {});
  }, []);

  async function handleSetDefault(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    setDefaultModel(key);
    localStorage.setItem("defaultModel", key);
    // 写入主进程：成为 getDefaultModel()（会话建链）/ scheduler 定时任务 / ModelSelector 的唯一种源
    const r = await window.api.piSetDefaultModel(key);
    setKeyStatus(r?.success ? `已将 ${modelId} 设为默认模型` : `默认模型保存失败: ${r?.error || ""}`);
  }

  async function handleSaveKey() {
    setKeyStatus("");
    if (!apiKey.trim()) {
      setKeyStatus("请输入 API key");
      return;
    }
    const result = await window.api.piSetApiKey(selectedProvider, apiKey.trim());
    if (result.success) {
      setKeyStatus("已保存。正在获取可用模型...");
      setApiKey("");
      const models = await window.api.piGetModels();
      if (Array.isArray(models)) setAvailableModels(models);
      setKeyStatus("API key 已保存");
    } else {
      setKeyStatus(`保存失败: ${result.error}`);
    }
  }

  async function handleRefreshModels() {
    const models = await window.api.piGetModels();
    if (Array.isArray(models)) setAvailableModels(models);
  }

  return (
    <div>
      <h3 style={{ marginBottom: 16 }}>设置</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 24 }}>
        {(
          [
            ["models", "模型配置"],
            ["skills", "技能管理"],
            ["editor", "技能编辑器"],
            ["topics", "教学内容"],
            ["voice", "语音配置"],
            ["scheduler", "定时任务"],
            ["general", "通用设置"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: tab === id ? "2px solid #667eea" : "1px solid #ddd",
              background: tab === id ? "#f0f4ff" : "white",
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "models" && (
        <div className="settings-section">
          <h3>模型配置</h3>
          <p className="desc">
            配置一个或多个模型提供商。所有孩子共用这些模型。配置后可在孩子学习时选择使用。
          </p>

          <div className="provider-list">
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className={`provider-chip ${selectedProvider === p.id ? "active" : ""}`}
                onClick={() => setSelectedProvider(p.id)}
              >
                {p.name}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
            <input
              type="password"
              placeholder={`API key (${PROVIDERS.find((p) => p.id === selectedProvider)?.keyHint})`}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              style={{ flex: 1, padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
            />
            <button
              onClick={handleSaveKey}
              style={{
                padding: "10px 20px",
                background: "#667eea",
                color: "white",
                border: "none",
                borderRadius: 8,
              }}
            >
              保存
            </button>
          </div>

          {keyStatus && <p style={{ fontSize: 13, color: keyStatus.startsWith("保存失败") ? "red" : "#667eea", marginBottom: 16 }}>{keyStatus}</p>}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ fontSize: 15 }}>当前可用模型</h4>
            <button
              onClick={handleRefreshModels}
              style={{
                padding: "6px 12px",
                background: "#f0f4ff",
                color: "#667eea",
                border: "none",
                borderRadius: 6,
                fontSize: 13,
              }}
            >
              刷新
            </button>
          </div>

          {availableModels.length === 0 ? (
            <p style={{ color: "#888", fontSize: 13 }}>还没有可用的模型，先保存一个 API key。</p>
          ) : (
            availableModels.map((m) => {
              const modelKey = `${m.provider}/${m.id}`;
              const isDefault = defaultModel === modelKey;
              return (
                <div key={modelKey} className="model-item">
                  <div>
                    <div className="model-name">{m.name}</div>
                    <div style={{ fontSize: 12, color: "#999" }}>
                      {m.provider}/{m.id}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    {isDefault && (
                      <span style={{ fontSize: 12, color: "#667eea", background: "#f0f4ff", padding: "4px 8px", borderRadius: 4 }}>
                        默认
                      </span>
                    )}
                    <button
                      onClick={() => handleSetDefault(m.provider, m.id)}
                      style={{
                        padding: "4px 10px",
                        background: isDefault ? "#ddd" : "#667eea",
                        color: isDefault ? "#666" : "white",
                        border: "none",
                        borderRadius: 4,
                        fontSize: 12,
                        cursor: isDefault ? "default" : "pointer",
                      }}
                      disabled={isDefault}
                    >
                      {isDefault ? "已设为默认" : "设为默认"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === "skills" && <SkillImport />}

      {tab === "editor" && <SkillEditor />}

      {tab === "topics" && <TopicEditor />}

      {tab === "voice" && <VoiceSettings />}

      {tab === "scheduler" && <SchedulerSettings />}

      {tab === "general" && <GeneralSettings />}
    </div>
  );
}

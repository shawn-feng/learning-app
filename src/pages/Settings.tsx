import { useState, useEffect } from "react";
import VoiceSettings from "../components/VoiceSettings";
import SchedulerSettings from "../components/SchedulerSettings";
import GeneralSettings from "../components/GeneralSettings";
import TopicEditor from "../components/TopicEditor";

// ISSUE-039 + token-plan 拆分：
// 仅保留国内/已确认的 provider，移除国外 provider（anthropic / google / openrouter / groq）。
// qwen（按量付费）与 qwen-tokenplan（token-plan 套餐）是**两个完全独立的 provider**：
//   - 各自的 API Key 不相同（用户明确：按量与 token-plan 的 key 是两套）；
//   - 各自的 base URL 也不相同（dashscope.aliyuncs.com vs token-plan.cn-beijing.maas.aliyuncs.com）；
//   - 故 Settings 提供两个独立 key 入口，分别写入 auth.json 的 qwen / qwen-tokenplan 段，互不拷贝。
// - openai 用户未点名删除，默认保留；minimax 为新增的国内 provider。
// 注：DeepSeek 有两处独立通道，互不冲突——
//   ① qwen-tokenplan/deepseek-v4-*：百炼 token-plan 套餐内的 DeepSeek，走 token-plan key + token-plan URL；
//   ② SDK 内置 deepseek/*：DeepSeek 官方直连，走用户自己的 deepseek key（auth.json 的 deepseek 段）。
//   两者都在白名单 ALLOWED_MODEL_PROVIDERS 中保留，故这里 deepseek 也要给独立 key 入口。
const PROVIDERS = [
  { id: "qwen", name: "通义千问 (按量付费)", keyHint: "sk-..." },
  { id: "qwen-tokenplan", name: "通义千问 (token-plan 套餐)", keyHint: "sk-...（与按量不同的 key）" },
  { id: "deepseek", name: "DeepSeek (官方直连)", keyHint: "sk-..." },
  { id: "openai", name: "OpenAI", keyHint: "sk-..." },
  { id: "minimax", name: "MiniMax", keyHint: "请填写 MiniMax API Key" },
];

export default function Settings() {
  const [tab, setTab] = useState<"models" | "voice" | "scheduler" | "general" | "topics">("models");
  const [selectedProvider, setSelectedProvider] = useState("qwen");
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem("defaultModel") || "");
  // ISSUE-020：编程 agent 模型（空 = 未启用，create_html_lesson 不可用）。
  // programmingModel = 已保存值（显示「当前已保存」）；programmingModelDraft = 下拉暂存（未保存的选择）。
  // 两者独立：下拉不跟随上方 provider 切换、保存走独立按钮，与「默认模型」配置互不耦合。
  const [programmingModel, setProgrammingModel] = useState("");
  const [programmingModelDraft, setProgrammingModelDraft] = useState("");

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

  // 编程 agent 模型初始值（主进程 app-settings.json 为准）；草稿同步为已保存值
  useEffect(() => {
    window.api.piGetProgrammingModel().then((r: any) => {
      if (r?.success) {
        const k = r.key || "";
        setProgrammingModel(k);
        setProgrammingModelDraft(k);
      }
    }).catch(() => {});
  }, []);

  // 初始化时自动加载模型列表：保证「编程 agent 模型」下拉与「设为默认」列表
  // 首次打开页面即有选项（此前只靠「保存 key / 手动刷新」填充，下拉空导致无法指定）。
  useEffect(() => {
    window.api.piGetModels().then((models: any) => {
      if (Array.isArray(models)) setAvailableModels(models);
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

  // ISSUE-020：编程 agent 模型「保存」动作（由独立按钮触发，不随下拉 onChange 即时保存）。
  // modelId 为空 = 停用。
  async function handleSaveProgramming(provider: string, modelId: string) {
    const key = modelId ? `${provider}/${modelId}` : "";
    const r = await window.api.piSetProgrammingModel(key);
    if (r?.success) {
      setProgrammingModel(key); // 已保存值更新
      setKeyStatus(key ? `已保存编程 agent 模型：${modelId}` : "已停用编程 agent 模型");
    } else {
      setKeyStatus(`编程 agent 模型保存失败: ${r?.error || ""}`);
    }
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
            <h4 style={{ fontSize: 15 }}>当前可用模型（{PROVIDERS.find((p) => p.id === selectedProvider)?.name || selectedProvider}）</h4>
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

          {(() => {
            const filtered = availableModels.filter((m) => m.provider === selectedProvider);
            if (availableModels.length === 0) {
              return <p style={{ color: "#888", fontSize: 13 }}>还没有可用的模型，先保存一个 API key。</p>;
            }
            if (filtered.length === 0) {
              return <p style={{ color: "#888", fontSize: 13 }}>该 provider 暂无可用模型，请确认已保存其 API key 后点「刷新」。</p>;
            }
            return filtered.map((m) => {
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
            });
          })()}

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #eee" }}>
            <h4 style={{ fontSize: 15, marginBottom: 4 }}>编程 agent 模型</h4>
            <p style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
              用于自动生成 / 修改孩子学习的 HTML 资料（create_html_lesson 工具）。独立于上方「默认模型」配置，不跟随 provider 切换；选好后点「保存」生效，未选择则功能不可用。
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={programmingModelDraft}
                onChange={(e) => setProgrammingModelDraft(e.target.value)}
                disabled={availableModels.length === 0}
                style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, minWidth: 260 }}
              >
                <option value="">未启用（默认）</option>
                {availableModels.map((m) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.name}（{m.provider}/{m.id}）
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  const v = programmingModelDraft;
                  const sep = v.indexOf("/");
                  handleSaveProgramming(sep > 0 ? v.slice(0, sep) : "", sep > 0 ? v.slice(sep + 1) : "");
                }}
                disabled={programmingModelDraft === programmingModel || availableModels.length === 0}
                style={{
                  padding: "8px 16px",
                  background: programmingModelDraft === programmingModel ? "#ddd" : "#667eea",
                  color: programmingModelDraft === programmingModel ? "#666" : "white",
                  border: "none",
                  borderRadius: 8,
                  fontSize: 13,
                  cursor: programmingModelDraft === programmingModel ? "default" : "pointer",
                }}
              >
                保存编程 agent 模型
              </button>
            </div>
            {availableModels.length === 0 && (
              <p style={{ fontSize: 12, color: "#c0392b", marginTop: 6 }}>
                暂无可用模型：请先在「API key」区配置并保存一个模型提供商的 key，模型列表加载后可在这里选择编程 agent 模型。
              </p>
            )}
            {programmingModel && (
              <p style={{ fontSize: 12, color: "#667eea", marginTop: 6 }}>当前已保存的编程 agent 模型：{programmingModel}</p>
            )}
          </div>
        </div>
      )}

      {tab === "topics" && <TopicEditor />}

      {tab === "voice" && <VoiceSettings />}

      {tab === "scheduler" && <SchedulerSettings />}

      {tab === "general" && <GeneralSettings />}
    </div>
  );
}

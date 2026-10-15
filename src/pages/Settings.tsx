import { useState, useEffect } from "react";
import { RefreshCw, CheckCircle } from "lucide-react";
import IconButton from "../components/IconButton";
import VoiceSettings from "../components/VoiceSettings";
import AssessmentSettings from "../components/AssessmentSettings";
import VisionSettings from "../components/VisionSettings";
import SchedulerSettings from "../components/SchedulerSettings";
import BackupSettings from "../components/BackupSettings";
import GeneralSettings from "../components/GeneralSettings";
import FeishuBindPanel from "../components/FeishuBindPanel";
import NamespacePanel from "../components/NamespacePanel";
import OpenApiSettings from "../components/OpenApiSettings";
// ISSUE-144 P5：家长「场景口径」编辑器（按场景覆盖助手口径，存服务端 agents 库）
import SceneSkillSettings from "../components/SceneSkillSettings";
import CustomPromptEditor from "../components/CustomPromptEditor";
import AccountSettings from "../components/AccountSettings";
// ISSUE-174：大模型配额面板（TokenHub 统一模型接入）
import TokenHubQuotaPanel from "../components/TokenHubQuotaPanel";

// 语音合成音色（ISSUE-174 续：内置渠道 TTS=minimax-speech-* 时生效；家长端显式选择优先于管理端云端配置。
// 清单 = benefit-auth VOICE_OPTIONS 同款，均经 MiniMax sync_tts 真调实测）
const TTS_VOICE_OPTIONS = [
  { v: "", n: "跟随管理端配置（默认音色）" },
  { v: "minimax_55e81114-ce7e-4ca1", n: "默认音色（通用女声）" },
  { v: "female-shaonv", n: "少女音（亲切朗读）" },
  { v: "female-yujie", n: "御姐音（沉稳讲述）" },
  { v: "male-qn-qingse", n: "青涩青年男声" },
  { v: "clever_boy", n: "童声·小男孩（儿童内容）" },
  { v: "audiobook_female_1", n: "有声书女声（故事长文）" },
];

// ISSUE-174（2026-10-10 调整版）：模型渠道三态开关（app_settings.modelChannel，用户拍板）——
// ① 「AI模型」= 内置渠道（TokenHub 托管 Key）：开关控制启停，配额直显，**不展示模型来源与列表**；
// ② 「自定义模型」= 自定义 provider 渠道：独立开关，启用即自动停用内置（两开关镜像同一状态，
//    服务端单值存储，互斥）；自定义渠道内保留 Key 录入 / 默认 / 视觉 / 编程 / 语音配置。

const PROVIDERS = [
  { id: "qwen", name: "通义千问 (按量付费)", keyHint: "sk-..." },
  { id: "qwen-tokenplan", name: "通义千问 (token-plan 套餐)", keyHint: "sk-...（与按量不同的 key）" },
  { id: "deepseek", name: "DeepSeek (官方直连)", keyHint: "sk-..." },
  { id: "moyu", name: "魔芋AI (聚合平台)", keyHint: "sk-...（魔芋令牌，moyu.cn 控制台创建）" },
  { id: "openai", name: "OpenAI", keyHint: "sk-..." },
  { id: "minimax", name: "MiniMax", keyHint: "请填写 MiniMax API Key" },
  { id: "mimo", name: "小米 MiMo (按量付费)", keyHint: "sk-...（MiMo 按量 Key）" },
  { id: "mimo-tokenplan", name: "小米 MiMo (token-plan 套餐)", keyHint: "tp-...（套餐 Key，与按量不同）" },
];

type ModelChannel = "builtin" | "custom" | "off";

/** 开关样式组件（两处渠道开关共用） */
function ChannelToggle(props: { checked: boolean; onToggle: (next: boolean) => void }) {
  const { checked, onToggle } = props;
  return (
    <button
      onClick={() => onToggle(!checked)}
      role="switch"
      aria-checked={checked}
      style={{
        width: 52, height: 28, borderRadius: 14, border: "none", cursor: "pointer",
        background: checked ? "#667eea" : "#cbd5e1", position: "relative", flexShrink: 0, padding: 0,
        transition: "background .2s",
      }}
    >
      <span style={{
        position: "absolute", top: 3, left: checked ? 27 : 3, width: 22, height: 22,
        borderRadius: "50%", background: "white", transition: "left .2s", boxShadow: "0 1px 3px rgba(0,0,0,.2)",
      }} />
    </button>
  );
}

export default function Settings() {
  const [tab, setTab] = useState<"tokenhub" | "models" | "evaluation" | "scheduler" | "feishu" | "scene" | "prompt" | "ns" | "openapi" | "general" | "backup" | "account">("tokenhub");
  // ---- 自定义模型渠道（保留原有 provider Key 录入 UI） ----
  const [selectedProvider, setSelectedProvider] = useState("qwen");
  const [apiKey, setApiKey] = useState("");
  const [keyStatus, setKeyStatus] = useState<string>("");
  // ISSUE-163：各 provider 已存 key 的打码回显（前6+****+后4），provider id → keyMasked
  const [keyMasked, setKeyMasked] = useState<Record<string, string>>({});
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [defaultModel, setDefaultModel] = useState(() => localStorage.getItem("defaultModel") || "");
  // 编程 agent 模型：programmingModel = 已保存值；programmingModelDraft = 下拉暂存
  const [programmingModel, setProgrammingModel] = useState("");
  const [programmingModelDraft, setProgrammingModelDraft] = useState("");
  // 模型渠道三态：builtin=内置 AI 模型 / custom=自定义模型 / off=停用（两 tab 开关镜像此状态）
  const [modelChannel, setModelChannel] = useState<ModelChannel>("builtin");
  // 语音合成音色（app_settings.ttsVoice，家长级；空 = 跟随管理端云端配置）
  const [ttsVoice, setTtsVoice] = useState("");

  useEffect(() => {
    window.api.piGetModelChannel?.().then((r: any) => {
      if (r?.success && (r.channel === "custom" || r.channel === "off")) setModelChannel(r.channel);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.api.piGetSettings?.().then((r: any) => {
      if (r?.success && typeof r.appSettings?.ttsVoice === "string") setTtsVoice(r.appSettings.ttsVoice);
    }).catch(() => {});
  }, []);

  /** 音色选择：服务端 app_settings.ttsVoice（家长级，全设备生效），空 = 跟随管理端。 */
  async function changeTtsVoice(v: string) {
    const prev = ttsVoice;
    setTtsVoice(v);
    const r = await window.api.piSetTtsVoice?.(v);
    if (!r?.success) {
      setTtsVoice(prev);
      setKeyStatus(`音色保存失败: ${r?.error || ""}`);
    }
  }

  /** 渠道切换：服务端单值存储，开一个自动关另一个；off = 内置/自定义全停。 */
  async function switchChannel(next: ModelChannel) {
    if (next === modelChannel) return;
    if (next === "custom" && !Object.values(keyMasked).some((v) => v)) {
      if (!confirm("尚未配置任何自定义模型的 API Key，启用后 AI 功能将不可用（可在下方录入 Key）。确定启用自定义模型？")) return;
    }
    if (next === "off" && modelChannel === "builtin") {
      if (!confirm("关闭内置 AI 模型后，孩子端 AI 功能将不可用（除非已启用自定义模型）。确定关闭？")) return;
    }
    const r = await window.api.piSetModelChannel?.(next);
    if (r?.success) {
      setModelChannel(next);
      setKeyStatus("");
    } else {
      setKeyStatus(`渠道切换失败: ${r?.error || ""}`);
    }
  }

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

  useEffect(() => {
    window.api.piGetProgrammingModel().then((r: any) => {
      if (r?.success) {
        const k = r.key || "";
        setProgrammingModel(k);
        setProgrammingModelDraft(k);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    window.api.piGetModels().then((models: any) => {
      if (Array.isArray(models)) setAvailableModels(models);
    }).catch(() => {});
  }, []);

  // ISSUE-163：加载各 provider 已存 key 的打码前缀
  function refreshKeyMasked() {
    window.api.piGetSettings?.().then((r: any) => {
      if (r?.success && Array.isArray(r.providers)) {
        const m: Record<string, string> = {};
        for (const p of r.providers) if (p?.provider) m[p.provider] = p.keyMasked || "";
        setKeyMasked(m);
      }
    }).catch(() => {});
  }
  useEffect(() => {
    refreshKeyMasked();
  }, []);

  async function handleSetDefault(provider: string, modelId: string) {
    const key = `${provider}/${modelId}`;
    setDefaultModel(key);
    localStorage.setItem("defaultModel", key);
    // 写入服务端 app_settings（ISSUE-097：模型配置唯一真源在服务端，agent 与本页读同一行）
    const r = await window.api.piSetDefaultModel(key);
    setKeyStatus(r?.success ? `已将 ${modelId} 设为默认模型` : `默认模型保存失败: ${r?.error || ""}`);
  }

  async function handleSaveProgramming(provider: string, modelId: string) {
    const key = modelId ? `${provider}/${modelId}` : "";
    const r = await window.api.piSetProgrammingModel(key);
    if (r?.success) {
      setProgrammingModel(key);
      setKeyStatus(key ? `已保存编程 agent 模型：${modelId}` : "编程 agent 模型已恢复系统默认");
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
      setApiKey("");
      const models = await window.api.piGetModels();
      if (Array.isArray(models)) setAvailableModels(models);
      refreshKeyMasked();
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
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <h3 style={{ marginBottom: 16 }}>设置</h3>

      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        {(
          [
            ["tokenhub", "AI模型"],
            ["models", "自定义模型"],
            ["evaluation", "发音评测"],
            ["scheduler", "定时任务"],
            ["feishu", "飞书绑定"],
            ["scene", "场景口径"],
            ["prompt", "自定义说明"],
            ["ns", "自定义数据"],
            ["openapi", "开放接口"],
            ["backup", "数据备份"],
            ["general", "通用设置"],
            ["account", "账号安全"],
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

      {/* ============ ① AI模型：内置渠道启停开关 + 配额直显（不展示来源/模型列表） ============ */}
      {tab === "tokenhub" && (
        <div className="settings-section">
          <h3>AI模型</h3>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, padding: "14px 16px",
            background: modelChannel === "builtin" ? "#f0f4ff" : "#f8fafc",
            border: modelChannel === "builtin" ? "1px solid #dfe4ff" : "1px solid #e2e8f0",
            borderRadius: 10, marginBottom: 16,
          }}>
            <span style={{ fontSize: 22 }}>{modelChannel === "builtin" ? "✅" : "⏸️"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                内置 AI 模型{modelChannel === "builtin" ? " · 已启用" : " · 已停用"}
              </div>
              <div style={{ fontSize: 12, color: "#667", marginTop: 2 }}>
                {modelChannel === "builtin"
                  ? "AI 助手 / 视觉理解 / 编程 agent 均使用内置模型，按账号配额计费，无需任何配置。"
                  : "已停用：当前" + (modelChannel === "custom" ? "使用「自定义模型」页配置的模型。" : "AI 功能不可用（自定义模型也未启用）。")}
              </div>
            </div>
            <ChannelToggle checked={modelChannel === "builtin"} onToggle={(v) => switchChannel(v ? "builtin" : "off")} />
          </div>

          {/* 语音合成音色：服务端 TTS（朗读/设备语音回复）用 MiniMax 合成时的音色；家长端显式选择优先于管理端云端配置 */}
          <div style={{ padding: "12px 16px", border: "1px solid #e2e8f0", borderRadius: 10, marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>语音合成音色</div>
            <div style={{ fontSize: 12, color: "#667", marginBottom: 8 }}>
              内置语音合成（朗读、设备语音回复）的音色，家长级设置、所有设备生效；选「跟随管理端」则以管理页配置为准。
            </div>
            <select
              value={ttsVoice}
              onChange={(e) => changeTtsVoice(e.target.value)}
              style={{ width: "100%", maxWidth: 380, padding: "8px 10px", fontSize: 13 }}
            >
              {TTS_VOICE_OPTIONS.map((o) => (
                <option key={o.v} value={o.v}>{o.n}</option>
              ))}
            </select>
          </div>

          {/* ISSUE-174 调整：配额直接展示在本页，不再单独一个标签 */}
          <TokenHubQuotaPanel />

          {keyStatus && <p style={{ fontSize: 13, color: keyStatus.startsWith("渠道切换失败") || keyStatus.startsWith("保存失败") ? "red" : "#667eea", marginTop: 12 }}>{keyStatus}</p>}
        </div>
      )}

      {/* ============ ② 自定义模型：独立开关（启用即停用内置）+ provider 渠道配置 ============ */}
      {tab === "models" && (
        <div className="settings-section">
          <h3>自定义模型</h3>
          <div style={{
            display: "flex", alignItems: "center", gap: 12, padding: "14px 16px",
            background: modelChannel === "custom" ? "#f0f4ff" : "#f8fafc",
            border: modelChannel === "custom" ? "1px solid #dfe4ff" : "1px solid #e2e8f0",
            borderRadius: 10, marginBottom: 12,
          }}>
            <span style={{ fontSize: 22 }}>{modelChannel === "custom" ? "✅" : "⏸️"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                自定义模型{modelChannel === "custom" ? " · 已启用" : " · 已停用"}
              </div>
              <div style={{ fontSize: 12, color: "#667", marginTop: 2 }}>
                {modelChannel === "custom"
                  ? "已启用：内置 AI 模型已自动停用，全部功能改用下方配置的自定义模型。"
                  : modelChannel === "builtin"
                    ? "内置 AI 模型启用中：下方配置会保存，但仅在启用自定义模型后生效（启用即自动停用内置模型）。"
                    : "AI 模型当前整体停用：内置与自定义模型均未启用。"}
              </div>
            </div>
            <ChannelToggle checked={modelChannel === "custom"} onToggle={(v) => switchChannel(v ? "custom" : "off")} />
          </div>
          <p className="desc">
            可选：配置自己的模型提供商 API Key。启用自定义模型后，所有 AI 功能优先使用此处配置
            （默认 / 视觉 / 编程 / 语音），内置模型停用。
          </p>

          <div className="provider-list">
            {PROVIDERS.map((p) => (
              <div
                key={p.id}
                className={`provider-chip ${selectedProvider === p.id ? "active" : ""}`}
                onClick={() => setSelectedProvider(p.id)}
                title={keyMasked[p.id] ? `已配置 Key：${keyMasked[p.id]}` : "未配置 Key"}
              >
                {p.name}
                {keyMasked[p.id] && (
                  <span style={{ marginLeft: 4, color: selectedProvider === p.id ? "#fff" : "#27ae60", fontSize: 12 }}>✓</span>
                )}
              </div>
            ))}
          </div>

          <div style={{ display: "flex", gap: 12, marginBottom: 4 }}>
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

          <p style={{ fontSize: 12, color: keyMasked[selectedProvider] ? "#27ae60" : "#98a2b0", margin: "0 0 12px" }}>
            {keyMasked[selectedProvider]
              ? `当前已保存：${keyMasked[selectedProvider]}（重新输入并保存可更换）`
              : "该 provider 尚未配置 API key"}
          </p>

          {keyStatus && <p style={{ fontSize: 13, color: keyStatus.startsWith("保存失败") ? "red" : "#667eea", marginBottom: 16 }}>{keyStatus}</p>}

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <h4 style={{ fontSize: 15 }}>当前可用模型（{PROVIDERS.find((p) => p.id === selectedProvider)?.name || selectedProvider}）</h4>
            <IconButton icon={RefreshCw} title="刷新模型" onClick={handleRefreshModels} />
          </div>

          {(() => {
            const filtered = availableModels.filter((m: any) => m.provider === selectedProvider);
            if (filtered.length === 0) {
              return <p style={{ color: "#888", fontSize: 13 }}>该 provider 暂无可用模型，请确认已保存其 API key 后点「刷新」。</p>;
            }
            return filtered.map((m: any) => {
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
                    <IconButton
                      icon={CheckCircle}
                      title={isDefault ? "已设为默认" : "设为默认"}
                      active={isDefault}
                      disabled={isDefault}
                      onClick={() => handleSetDefault(m.provider, m.id)}
                    />
                  </div>
                </div>
              );
            });
          })()}

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #eee" }}>
            <h4 style={{ fontSize: 15, marginBottom: 4 }}>编程 agent 模型</h4>
            <p style={{ fontSize: 12, color: "#999", marginBottom: 8 }}>
              用于自动生成 / 修改孩子学习的 HTML 资料。未选择（或所选 provider 未配 Key）时使用系统默认 TokenHub 模型；
              列表含 TokenHub 模型（无需 Key）与已配置的自定义模型。
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select
                value={programmingModelDraft}
                onChange={(e) => setProgrammingModelDraft(e.target.value)}
                disabled={availableModels.length === 0}
                style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, minWidth: 260 }}
              >
                <option value="">系统默认（TokenHub）</option>
                {availableModels.map((m: any) => (
                  <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                    {m.name}（{m.provider}/{m.id}）{m.provider === "tokenhub" ? " · 无需Key" : ""}
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
            {programmingModel && (
              <p style={{ fontSize: 12, color: "#667eea", marginTop: 6 }}>当前已保存的编程 agent 模型：{programmingModel}</p>
            )}
          </div>

          {/* ISSUE-174 调整：视觉 / 语音模型并入自定义模型渠道（原独立标签取消） */}
          <div style={{ marginTop: 24, paddingTop: 16, borderTop: "1px solid #eee" }}>
            <VisionSettings />
          </div>
          <div style={{ marginTop: 16 }}>
            <VoiceSettings />
          </div>
        </div>
      )}

      {tab === "evaluation" && <AssessmentSettings />}

      {tab === "scheduler" && <SchedulerSettings />}

      {tab === "backup" && <BackupSettings />}

      {tab === "feishu" && <FeishuBindPanel />}
      {tab === "scene" && <SceneSkillSettings />}

      {/* ISSUE-175：家长 agent 全局自定义层——追加在家长助手 system prompt 末尾，重开会话生效 */}
      {tab === "prompt" && (
        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16, display: "flex", flexDirection: "column" }}>
          <CustomPromptEditor
            scope="parent"
            refId=""
            title="自定义说明"
            entityLabel="家长助手"
            description={
              <>
                给家长助手追加的个性化要求（例如：「汇报时先说结论再列细节」「每天结束时给我一句总结」），对助手的**所有场景**生效。
                内容整段**追加**在助手行为规范的最末尾；基础规范由系统维护，这里改不到。
                想调整某个场景的具体说法（而非全局要求），用旁边的「场景口径」。
              </>
            }
            placeholder={"在这里写给家长助手的额外要求，一行一条即可，例如：\n· 汇报先给结论，再列细节\n· 提到分数时同时说明错因类别"}
          />
        </div>
      )}
      {tab === "ns" && <NamespacePanel />}
      {tab === "openapi" && <OpenApiSettings />}
      {tab === "general" && <GeneralSettings />}
      {tab === "account" && <AccountSettings />}
    </div>
  );
}

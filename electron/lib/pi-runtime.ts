import {
  ModelRuntime,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getAuthPath } from "./config";
import { getDefaultModelKey } from "./app-settings";
import fs from "fs";

const cacheKey = "__learningAppModelRuntime";

// 通义千问（DashScope OpenAI 兼容接口）模型清单。
// 千问官方 API：baseUrl = https://dashscope.aliyuncs.com/compatible-mode/v1，API Key 形如 sk-...
// 注意：SDK 内置的 "qwen-token-plan*" 是阿里云百炼 token-plan 套餐（模型为 MiniMax/DeepSeek/GLM 等），
// 与这里接入的通义千问官方模型（qwen-max/plus/flash）不是一回事。
// 说明：qwen-max/plus/flash 是「稳定别名」，会自动路由到当前最新版本
// （qwen-max→qwen3.8-max、qwen-plus→qwen3.7-plus、qwen-flash→qwen3.7-flash）。
// qwen3 是推理模型，无法真正「关闭思考」：若用 enable_thinking:false，模型会把思考过程
// 直接混进 content 正文（表现为消息气泡里出现「我需要……题目设计……答案……」这类自言自语），
// 且 SDK 无法将其与正式回复分离。正确做法是 reasoning:true + compat.thinkingFormat:"qwen"，
// 让 SDK 按 thinking 等级发送 enable_thinking，并把返回的 reasoning_content 路由到独立的
// thinking 块（前端折叠成 🧠 思考过程），content 只保留干净正文。
// 另：reasoning:true 后 SDK 会把 system 提示词转成 developer 角色（supportsDeveloperRole 默认按
// OpenAI 语义判定为 true），但 DashScope 兼容接口只认 system 不认 developer（报 400
// "developer is not one of ['system','assistant','user','tool','function']"）。
// 故 compat 里必须显式 supportsDeveloperRole:false，让 system 保持 system。
// 性能：qwen3 思考很冗长（实测 flash/plus 思考约 1900 字符、占 10~20s，正文迟迟不出，
// 远慢于 deepseek-v4-flash 的 ~158 字符/1s）。reasoning_effort 对 qwen3.7 无效（low/medium 无差异），
// 正确参数是 thinking_budget（限制思考 token 数）。实测 flash 自由思考约 1900 字符/12s，
// budget=512 可压到 770 字符/7.4s，但会把「需查证/多步推理」的复杂问题思考腰斩、偶发幻觉；
// 故 flash 现用 thinking_budget=2048（复杂问题基本想得完、速度仍远快于 max）。
// plus 现同调 thinking_budget=2048（与 flash 一致，覆盖复杂问题、不再腰斩思考）。
// 故 flash/plus 加 samplingParams.thinking_budget=2048。注意 samplingParams 最后 Object.assign 进请求，
// 但其中不含 enable_thinking，不会覆盖 thinkingFormat 分支写入的 enable_thinking:true。
// 另：thinkingLevelMap 里 off:null 表示「qwen 不支持 off 等级」，防止历史遗留的会话 thinkingLevel=off
// 把 qwen 卡在关思考（enable_thinking=false → 思考混进正文、无 thinking 块）。SDK 会把 off clamp 到 minimal。
// 注意 maxTokens 是「单次最大输出」硬上限（reasoning_content + content 共享），超了会报 400：
//   qwen3.8-max=131072 / qwen3.7-max=65536 / qwen3.7-plus=32768 / qwen3.7-flash=16384
// 故此处取值：max=65536、plus=32768、flash=16384（均为安全值）。
const QWEN_MODELS: ProviderModelConfig[] = [
  {
    id: "qwen-max",
    name: "通义千问 Max",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
  {
    id: "qwen-plus",
    name: "通义千问 Plus",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 32768,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
    samplingParams: { thinking_budget: 2048 },
  },
  {
    id: "qwen-flash",
    name: "通义千问 Flash",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 16384,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
    // 思考预算 2048：原 512 会把「需查证/多步推理」的问题思考腰斩（reasoning 卡在 512），
    // 模型在没想完时输出正文、偶发幻觉（见珊珊会话）。2048 覆盖绝大多数复杂问题、速度仍远快于 qwen-max。
    samplingParams: { thinking_budget: 2048 },
  },
];

// 经 DashScope 同端点可调用的 DeepSeek 系列（百炼第三方模型，费用低于直连 deepseek 官方）。
// 关键：DeepSeek 的思考格式与 qwen 不同——必须用 thinkingFormat:"deepseek"（不是 "qwen"），
// 并 requiresReasoningContentOnAssistantMessages:true，否则 reasoning_content 会混进正文、
// 没有独立 🧠 思考块（重现早前 qwen reasoning:false 的「思考灌进正文」bug）。
// 参数取自 SDK 内置 deepseek provider 的 deepseek.json（cost/maxTokens/contextWindow 一致）：
//   maxTokens=384000（思考+最终输出共享，DeepSeek-V4 的 384k 限制，区别于 qwen 的 16k/32k/65k）；
//   contextWindow=1000000；thinkingLevelMap 与 SDK 对齐（min/low/medium 置 null，仅 high/max 有效，
//   配合 pi-session.ts 对 thinkingLevel==="off" 的强制纠正为 high）。
// 注：千问平台（platform.qianwenai.com 模型清单）同时提供稳定别名 deepseek-v4-flash-0731 /
// deepseek-v4-pro-0813（定点快照）与无后缀别名（自动路由最新版）；两者都登记，用户可按需选定点版。
const QWEN_DEEPSEEK_MODELS: ProviderModelConfig[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash 0731 (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro 0813 (百炼)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false, requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
];

// 视觉/多模态模型（Qwen3-VL 系列，经 DashScope 同端点调用）。
// 当前（2026-07-15 官方文档）推荐的视觉模型已是 Qwen3-VL 系列（qwen3-vl-plus / qwen3-vl-flash），
// 输入支持 文本·图像·视频；旧的 qwen-vl-max/plus 已被官方列入「旧版不再推荐」，故这里挂 Qwen3-VL。
// thinking 语义与 qwen 文本模型一致（同属 Qwen3 家族），复用 thinkingFormat:"qwen" + supportsDeveloperRole:false；
// 区别是 input 多了 "image"（图片上传走视觉模型识别，见 ISSUE-008 的 pi:prompt 自动切换逻辑）。
// maxTokens 取保守安全值（VL 输出上限低于纯文本 qwen，避免超 400）；contextWindow 取官方 256k。
const QWEN_VL_MODELS: ProviderModelConfig[] = [
  {
    id: "qwen3-vl-flash",
    name: "通义千问 VL Flash (视觉)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 8192,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
  {
    id: "qwen3-vl-plus",
    name: "通义千问 VL Plus (视觉)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 256000,
    maxTokens: 8192,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    thinkingLevelMap: { off: null },
  },
];

// 图片上传时自动切换到的视觉模型（provider/modelId）。便宜优先用 flash。
export const DEFAULT_VISION_MODEL = { provider: "qwen", modelId: "qwen3-vl-flash" };

const QWEN_PROVIDER: ProviderConfig = {
  name: "通义千问 (Qwen)",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  // qwen 官方三款 + 经同端点可调用的 DeepSeek V4 系列（费用更低）+ Qwen3-VL 视觉系列（图片上传用）。
  models: [...QWEN_MODELS, ...QWEN_DEEPSEEK_MODELS, ...QWEN_VL_MODELS],
};

function registerQwenProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("qwen", QWEN_PROVIDER);
  } catch (err) {
    console.error("[qwen] register provider failed:", (err as Error).message);
  }
}

export async function getSharedRuntime(): Promise<ModelRuntime> {
  const g = globalThis as any;
  if (!g[cacheKey]) {
    const authPath = getAuthPath();
    // Ensure auth.json exists with valid structure
    if (!fs.existsSync(authPath) || fs.statSync(authPath).size < 4) {
      fs.writeFileSync(authPath, "{}", "utf-8");
    }
    g[cacheKey] = await ModelRuntime.create({ authPath });
    registerQwenProvider(g[cacheKey]);
  }
  return g[cacheKey];
}

export async function getAvailableModels() {
  const runtime = await getSharedRuntime();
  return runtime.getAvailable();
}

// 显式指定的默认模型：deepseek 的便宜档 flash，避免走 SDK 默认的 deepseek-v4-pro（更贵）
// 这是「兜底默认」——仅当用户未在设置里指定默认模型时生效。
const DEFAULT_PROVIDER = "deepseek";
const DEFAULT_MODEL = "deepseek-v4-flash";

export async function getDefaultModel() {
  const runtime = await getSharedRuntime();
  // 优先使用用户在设置里指定的默认模型（存于 app-settings.json，主进程可读，
  // 与渲染侧 Settings / ModelSelector 同源），解决「设置改了默认模型、孩子模式仍显示 deepseek flash」。
  const key = getDefaultModelKey();
  if (key) {
    const sep = key.indexOf("/");
    const provider = sep > 0 ? key.slice(0, sep) : key;
    const modelId = sep > 0 ? key.slice(sep + 1) : "";
    if (provider && modelId) {
      const model = runtime.getModel(provider, modelId);
      if (model) return model;
    }
  }
  // 未设置或指定模型无法解析（如 provider 未注册）→ 回退到 deepseek flash。
  return runtime.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL);
}

export async function checkProviderAuth(providerId: string) {
  const runtime = await getSharedRuntime();
  return runtime.checkAuth(providerId);
}

export async function setProviderApiKey(providerId: string, apiKey: string) {
  // Pi SDK reads credentials from auth.json directly.
  // Write API key to auth.json, then recreate the runtime singleton.
  const authPath = getAuthPath();
  let auth: Record<string, any> = {};
  try {
    if (fs.existsSync(authPath)) {
      auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
    }
  } catch {
    auth = {};
  }

  auth[providerId] = { type: "api_key", key: apiKey };

  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8");

  // Invalidate cached runtime so next call picks up new credentials
  const g = globalThis as any;
  if (g[cacheKey]) {
    try { g[cacheKey].dispose?.(); } catch {}
    delete g[cacheKey];
  }
}

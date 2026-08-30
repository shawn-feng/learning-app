import {
  ModelRuntime,
  type ProviderConfig,
  type ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { getAuthPath } from "./config";
import { getDefaultModelKey, getProgrammingModelKey, getVisionModelKey } from "./app-settings";
import fs from "fs";
import path from "path";

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
// 远慢于 deepseek-v4-flash-0731 的 ~158 字符/1s）。reasoning_effort 对 qwen3.7 无效（low/medium 无差异），
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
// 注：百炼平台同时提供定点快照（deepseek-v4-flash-0731 / deepseek-v4-pro-0813）与无后缀别名
// （自动路由最新版）。⚠️ 无后缀别名已从百炼下线（2026-08-24 实测调用报 403 AccessDenied.Unpurchased），
// 故只登记定点快照，避免设置页出现「可选但必报错」的模型。
const QWEN_DEEPSEEK_MODELS: ProviderModelConfig[] = [
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
  name: "通义千问 (Qwen) · 按量付费",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  // qwen 官方三款 + Qwen3-VL 视觉系列（图片上传用）+ DeepSeek V4 系列（百炼生态，按量端点亦可调用）。
  // DeepSeek 同时在 QWEN_PROVIDER（按量）与 QWEN_TOKENPLAN_PROVIDER（套餐）下各注册一份，
  // 用户在两个千问 provider 里都能看到并选择 DeepSeek；走哪种计费由选中的 provider 端点决定。
  models: [...QWEN_MODELS, ...QWEN_VL_MODELS, ...QWEN_DEEPSEEK_MODELS],
};

function registerQwenProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("qwen", QWEN_PROVIDER);
  } catch (err) {
    console.error("[qwen] register provider failed:", (err as Error).message);
  }
}

// 阿里云百炼 token-plan 套餐通道（与按量付费是不同的 base URL，打到哪个 URL 决定走哪种计费）。
//   - 按量付费：https://dashscope.aliyuncs.com/compatible-mode/v1
//   - token-plan：https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
// 套餐内的第三方模型（DeepSeek V4 系列等）必须走 token-plan 端点才能被套餐抵扣。
// 鉴权：qwen-tokenplan 走 auth.json 中独立的 key 段（auth["qwen-tokenplan"]，sk-sp- 开头，
// 套餐专属），与按量付费的 auth.qwen 不是同一个 Key，切勿互相拷贝或同步。
const QWEN_TOKENPLAN_PROVIDER: ProviderConfig = {
  name: "通义千问 (Qwen) · token-plan 套餐",
  baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  api: "openai-completions",
  // 经 token-plan 套餐可调用的模型：DeepSeek V4 系列（费用低于直连 deepseek 官方 / 按量）
  // + Qwen3-VL 视觉系列（视觉模型在套餐通道同样可用，视觉配置可选手按量或套餐，见 VisionSettings）。
  models: [...QWEN_DEEPSEEK_MODELS, ...QWEN_VL_MODELS],
};

function registerQwenTokenplanProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("qwen-tokenplan", QWEN_TOKENPLAN_PROVIDER);
  } catch (err) {
    console.error("[qwen-tokenplan] register provider failed:", (err as Error).message);
  }
}

// MiniMax 国内大模型（OpenAI 兼容接口）。官方文档：
//   - OpenAI 兼容 baseUrl（中国国内账号）：https://api.minimaxi.com/v1 ；国际账号用 https://api.minimax.io/v1
//   - 鉴权：HTTP Bearer（Authorization: Bearer <API_KEY>），与 OpenAI 一致
//   - 模型清单（OpenAI 兼容）：MiniMax-M3 / M2.7(+highspeed) / M2.5(+highspeed) / M2.1(+highspeed) / M2
// 注意：SDK 的 thinkingFormat 仅支持 openai/deepseek/qwen 等固定枚举，**没有 "minimax"**，
// 故 MiniMax 此处按普通 openai-completions 模型接入（reasoning 不开启），不猜测思考格式；
// 若将来要启用 M3 的 thinking（adaptive），需先在 SDK 增加 "minimax" thinkingFormat 处理（超出本 issue 范围）。
// M3 虽支持多模态（图/视频），但本应用视觉模型切换固定走 qwen（DEFAULT_VISION_MODEL），
// 故 MiniMax 仅登记 text 输入，避免意外接管视觉通道。
const MINIMAX_MODELS: ProviderModelConfig[] = [
  {
    id: "MiniMax-M3",
    name: "MiniMax M3 (1M 上下文)",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 16384,
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 HighSpeed",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
  {
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 HighSpeed",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
  {
    id: "MiniMax-M2.1-highspeed",
    name: "MiniMax M2.1 HighSpeed",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
  {
    id: "MiniMax-M2.1",
    name: "MiniMax M2.1",
    api: "openai-completions",
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 204800,
    maxTokens: 8192,
  },
];

const MINIMAX_PROVIDER: ProviderConfig = {
  name: "MiniMax (国内)",
  // 国内账号走 api.minimaxi.com；若用户的 MiniMax 是国际账号，改回 https://api.minimax.io/v1 即可。
  baseUrl: "https://api.minimaxi.com/v1",
  api: "openai-completions",
  models: MINIMAX_MODELS,
};

function registerMinimaxProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("minimax", MINIMAX_PROVIDER);
  } catch (err) {
    console.error("[minimax] register provider failed:", (err as Error).message);
  }
}

// 小米 MiMo（OpenAI 兼容接口）。官方文档：
//   - OpenAI 兼容 baseUrl（按量付费）：https://api.xiaomimimo.com/v1
//   - token-plan 套餐端点：https://token-plan-cn.xiaomimimo.com/v1（tp- 开头 key，与按量 sk- 不同，
//     若用户用套餐，把 baseUrl 换成该端点并在 auth["mimo"] 配套餐 key 即可）
//   - 鉴权：Authorization: Bearer 与 api-key: 头均支持（文档 curl 示例用 api-key，OpenAI SDK 用 Bearer）
//   - 在售模型（2026-08 官方模型列表）：mimo-v2.5-pro（文本/深度思考）、mimo-v2.5（全模态理解）；
//     旧 v2 系列（mimo-v2-pro/v2-omni/v2-flash/v2-tts）已 2026-06-30 下线，不登记。
// 思考格式：MiMo 与 DeepSeek 同风格（thinking: {type: enabled/disabled}，assistant 消息返回
// reasoning_content，多轮工具调用需回传历史 reasoning_content）→ 直接复用 SDK 的
// thinkingFormat:"deepseek" + requiresReasoningContentOnAssistantMessages:true，参数与 QWEN_DEEPSEEK_MODELS
// 对齐。MiMo 支持 developer role（第三方 pi provider 实测），supportsDeveloperRole 保持默认 true。
// 视觉：mimo-v2.5 是官方全模态模型（文本+图片，OpenAI 兼容 image_url 格式），登记 image 输入，
// 使其可被选为「默认视觉模型」（图片上传自动切换，见 getVisionModel / Settings 视觉模型下拉）。
const MIMO_MODELS: ProviderModelConfig[] = [
  {
    id: "mimo-v2.5-pro",
    name: "小米 MiMo V2.5 Pro (旗舰)",
    api: "openai-completions",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536, // 官方最大输出 128K，取安全值
    compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
  {
    id: "mimo-v2.5",
    name: "小米 MiMo V2.5 (全模态)",
    api: "openai-completions",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 65536,
    compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true },
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" },
  },
];

const MIMO_PROVIDER: ProviderConfig = {
  name: "小米 MiMo (按量付费)",
  baseUrl: "https://api.xiaomimimo.com/v1",
  api: "openai-completions",
  models: MIMO_MODELS,
};

function registerMimoProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("mimo", MIMO_PROVIDER);
  } catch (err) {
    console.error("[mimo] register provider failed:", (err as Error).message);
  }
}

// 小米 MiMo token-plan 套餐通道（与按量付费是不同的 base URL 与 key 段，打到哪个 URL 决定走哪种计费）。
//   - 按量付费：https://api.xiaomimimo.com/v1（auth["mimo"]，sk- 开头）
//   - token-plan：https://token-plan-cn.xiaomimimo.com/v1（auth["mimo-tokenplan"]，tp- 开头，套餐专属）
// 两通道 key 不相同，切勿互相拷贝或同步（与 qwen/qwen-tokenplan 双通道同理）。
const MIMO_TOKENPLAN_PROVIDER: ProviderConfig = {
  name: "小米 MiMo · token-plan 套餐",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  api: "openai-completions",
  models: MIMO_MODELS,
};

function registerMimoTokenplanProvider(runtime: ModelRuntime): void {
  try {
    runtime.registerProvider("mimo-tokenplan", MIMO_TOKENPLAN_PROVIDER);
  } catch (err) {
    console.error("[mimo-tokenplan] register provider failed:", (err as Error).message);
  }
}

export async function getSharedRuntime(): Promise<ModelRuntime> {
  const g = globalThis as any;
  if (!g[cacheKey]) {
    const authPath = getAuthPath();
    // Ensure auth.json exists with valid structure.
    // ⚠️ 按家长分区后 authPath = parents/<parentId>/auth.json，未登录(_guest)或新家长目录
    // 可能不存在 → 写前先建父目录，否则 ENOENT（测试/极简环境实测踩坑）。
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    if (!fs.existsSync(authPath) || fs.statSync(authPath).size < 4) {
      fs.writeFileSync(authPath, "{}", "utf-8");
    }
    // 注意：qwen（按量付费）与 qwen-tokenplan（token-plan 套餐）是**两个完全独立的 provider**，
    // 各自使用 auth.json 中独立的 key 段（auth.qwen / auth["qwen-tokenplan"]）和独立的 base URL。
    // 两者 API Key 不相同，切勿互相拷贝或同步——这是用户明确的账号事实。
    g[cacheKey] = await ModelRuntime.create({ authPath });
    registerQwenProvider(g[cacheKey]);
    registerQwenTokenplanProvider(g[cacheKey]);
    registerMinimaxProvider(g[cacheKey]);
    registerMimoProvider(g[cacheKey]);
    registerMimoTokenplanProvider(g[cacheKey]);
  }
  return g[cacheKey];
}

// ISSUE-039：provider 白名单——只暴露国内/已保留的 provider，屏蔽 SDK 内置的国外 provider
// （anthropic / google / openrouter / groq 等），避免前端「设为默认模型」下拉泄漏国外模型。
// 即使未来 SDK 升级又注册了新国外 provider，也只会被挡在白名单之外。
// 注：openai 用户未点名删除，默认保留；如需一并去掉，从本数组移除 "openai" 即可。
const ALLOWED_MODEL_PROVIDERS = ["qwen", "qwen-tokenplan", "deepseek", "openai", "minimax", "mimo", "mimo-tokenplan"];

export async function getAvailableModels() {
  const runtime = await getSharedRuntime();
  const models = await runtime.getAvailable();
  return models.filter((m: any) => ALLOWED_MODEL_PROVIDERS.includes(m.provider));
}

// 显式指定的默认模型：token-plan 套餐内的 deepseek 便宜档 flash 定点快照（qwen-tokenplan/deepseek-v4-flash-0731），
// 避免未配置时落到更贵的档位。注意：这是 qwen-tokenplan provider 下的 DeepSeek，走 token-plan 套餐端点，
// 与 SDK 内置 deepseek/*（DeepSeek 官方直连，独立 key）是两条不同通道。
// 这是「兜底默认」——仅当用户未在设置里指定默认模型时生效。
// 注：无后缀 deepseek-v4-flash 已从百炼下线，只登记 -0731 定点快照。
const DEFAULT_PROVIDER = "qwen-tokenplan";
const DEFAULT_MODEL = "deepseek-v4-flash-0731";

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
  // 未设置或指定模型无法解析（如 provider 未注册）→ 回退到 qwen-tokenplan 的 deepseek-v4-flash-0731（套餐端点）。
  return runtime.getModel(DEFAULT_PROVIDER, DEFAULT_MODEL);
}

// 默认视觉模型（图片上传时 pi:prompt 自动切换用）。读 app-settings 的 visionModel（"provider/modelId"），
// 用户可在设置页「模型配置」指定任意多模态模型为默认视觉模型；未设置或解析失败回退 qwen/qwen3-vl-flash。
export async function getVisionModel() {
  const runtime = await getSharedRuntime();
  const key = getVisionModelKey();
  if (key) {
    const sep = key.indexOf("/");
    const provider = sep > 0 ? key.slice(0, sep) : "";
    const modelId = sep > 0 ? key.slice(sep + 1) : "";
    if (provider && modelId) {
      const model = runtime.getModel(provider, modelId);
      if (model) return model;
    }
  }
  return runtime.getModel(DEFAULT_VISION_MODEL.provider, DEFAULT_VISION_MODEL.modelId);
}

// 编程 agent 模型（ISSUE-020）。未在设置页配置（programmingModel 为空）或模型无法解析时返回 null
// —— create_html_lesson 工具据此报「未配置」错误并提示家长先去设置页配置，不静默回退。
export async function getProgrammingModel() {
  const key = getProgrammingModelKey();
  if (!key) return null;
  const sep = key.indexOf("/");
  const provider = sep > 0 ? key.slice(0, sep) : key;
  const modelId = sep > 0 ? key.slice(sep + 1) : "";
  if (!provider || !modelId) return null;
  const runtime = await getSharedRuntime();
  return runtime.getModel(provider, modelId) ?? null;
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

  // SPLIT（2026-08-30 用户决策）：模型 key 随家长账号上云，多客户端/孩子登录 2 分钟轮询同步。
  // 保存后全量推送服务端（config key "auth"，按家长隔离）；离线/未登录跳过。
  try {
    const { pushConfig } = await import("./config-sync");
    await pushConfig("auth", auth);
  } catch {
    // 未登录/服务端不可用：仅本地保存
  }

  // Invalidate cached runtime so next call picks up new credentials
  const g = globalThis as any;
  if (g[cacheKey]) {
    try { g[cacheKey].dispose?.(); } catch {}
    delete g[cacheKey];
  }
}

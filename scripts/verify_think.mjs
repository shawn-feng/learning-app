import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const authPath = "data/shared/auth.json";
const rt = await ModelRuntime.create({ authPath });

// 与 pi-runtime.ts 当前一致的最新配置
const QWEN_MODELS = [
  { id: "qwen-flash", name: "通义千问 Flash", api: "openai-completions", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 16384,
    compat: { thinkingFormat: "qwen", supportsDeveloperRole: false },
    samplingParams: { thinking_budget: 512 } },
];
rt.registerProvider("qwen", { name: "Qwen", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", api: "openai-completions", models: QWEN_MODELS });
const model = rt.getModel("qwen", "qwen-flash");

const SYSTEM = "你是孩子的学习伙伴，温和耐心，用孩子能懂的话引导学习。";
const PROMPT = "请你分三步教孩子判断陈述句和疑问句，每一步都要设计一道练习题考孩子，先介绍概念再出题，语气亲切。";

const ctx = {
  systemPrompt: SYSTEM,
  messages: [{ role: "user", content: [{ type: "text", text: PROMPT }] }],
  tools: [],
};

// 捕获 payload + 完整 message
let cap = null;
const t0 = Date.now();
const stream = rt.streamSimple(model, ctx, {
  reasoning: "medium",
  onPayload: (p) => { cap = p; return p; },
});
let lastMessage = null;
for await (const ev of stream) {
  if (ev.type === "done" || ev.type === "message_end") {
    lastMessage = ev.message || ev.partial;
  }
}
// 兜底：用 result()
const finalMessage = await stream.result();
const dt = (Date.now() - t0) / 1000;

console.log("payload enable_thinking:", cap?.enable_thinking);
console.log("payload thinking_budget:", cap?.thinking_budget);
console.log("payload reasoning_effort:", cap?.reasoning_effort);

const content = finalMessage?.content || [];
const types = content.map(c => c.type);
console.log("content types:", types);
let thinking = "", text = "";
for (const c of content) {
  if (c.type === "thinking") thinking += c.thinking || "";
  else if (c.type === "text") text += c.text || "";
}
console.log(`耗时 ${dt.toFixed(2)}s | thinking ${thinking.length}字符 | text ${text.length}字符`);
console.log("thinking 开头:", thinking.slice(0, 150).replace(/\n/g, " "));
console.log("text 开头:", text.slice(0, 150).replace(/\n/g, " "));

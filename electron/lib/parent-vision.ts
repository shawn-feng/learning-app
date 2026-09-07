/**
 * 家长 agent 识图旁路会话（P3）：一次独立的「图片 → 视觉模型 → 文字」调用。
 *
 * 背景（2026-09-07）：家长 agent 起草教学文案时经常「读不到图片/视频内容」，只能靠片名猜。
 * 为让家长 agent 能读懂教材扫描页/截图/图示的真实内容，新增识图能力。这里用**一次性 in-memory
 * 会话 + 视觉模型**（visionModel，默认 qwen3-vl-flash）发一条带图请求取回文字即弃，**不污染**家长
 * 主会话历史、不打断当前 agent 推理流、不落盘。
 *
 * 形态参考 daily-summary.ts / exam-engine.ts 的临时会话：SessionManager.inMemory + DefaultResourceLoader
 * (noContextFiles/noSkills) + noTools（纯问答，不挂任何工具）。
 */
import path from "path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getSharedRuntime, getVisionModel } from "./pi-runtime";

/** 与 pi-coding-agent jsonl / ipc pi:prompt 一致的图像输入块（data 为 base64，无 data: 前缀）。 */
export interface VisionImageInput {
  type: "image";
  mimeType: string;
  data: string;
}

/** 按图片扩展名映射 MIME（缺省 application/octet-stream）。 */
export function imageMimeFromExt(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    avif: "image/avif",
  };
  return map[ext] ?? "application/octet-stream";
}

/** 取 session 里最后一条 assistant 的 text（内存会话结构：role + content[type=text]）。 */
function lastAssistantText(session: any): string {
  const msgs: Array<any> = session?.messages ?? [];
  let text = "";
  for (const m of msgs) {
    if (m?.role !== "assistant") continue;
    const content = Array.isArray(m.content) ? m.content : [];
    const t = content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
    if (t) text = t;
  }
  return text;
}

/**
 * 用视觉模型读一张图片（base64），返回模型文字回答。dataDir 用作会话 cwd（家长数据根目录）。
 * question 缺省为「描述图片并识别其中全部文字」。
 */
export async function describeImageViaVision(
  dataDir: string,
  image: VisionImageInput,
  question?: string
): Promise<string> {
  const runtime = await getSharedRuntime();
  const model = await getVisionModel();

  const loader = new DefaultResourceLoader({
    cwd: dataDir,
    agentDir: path.join(dataDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () =>
      "你是家长工作台里的「图片理解助手」。用户会给你一张图片（教材页/截图/图示等），" +
      "请忠实描述画面内容并识别图中全部文字（含标题、正文、标注），保持准确、不臆造。",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: dataDir,
    agentDir: path.join(dataDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    // 纯一问一答：不挂任何工具，避免旁路调用触发无关工具或污染上下文
    tools: [],
    customTools: [],
  });

  const promptText =
    (question && question.trim()
      ? question.trim()
      : "请描述这张图片的内容，并逐字识别图中出现的所有文字。") +
    "\n\n只输出文字回答，不要编造图片里没有的信息。";

  try {
    await session.prompt(promptText, { images: [image] });
    const text = lastAssistantText(session);
    if (!text.trim()) throw new Error("视觉模型未返回任何文字");
    return text.trim();
  } finally {
    try {
      session.dispose();
    } catch {
      /* 忽略 dispose 失败 */
    }
  }
}

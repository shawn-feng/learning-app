/**
 * 识图旁路（P2）：把客户端 `electron/lib/parent-vision.ts` 的能力迁到服务端。
 *
 * 语义与客户端一致：一次性 in-memory 会话 + 视觉模型，问一条带图请求取回文字即弃，
 * 不污染家长主会话历史、不落盘。区别只是运行时/模型由服务端口径决定（家长的 auth + app_settings）。
 *
 * 为什么单独跑一条会话而不是挂进主会话：主会话可能用文本模型（无 image 输入），
 * 且识图属于旁路工具调用，混进主上下文会污染家长正在进行的推理流。
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { CoreSessionDeps } from "@pi/agent-core";
import { getWorkerRuntime, pickVisionModel } from "@pi/agent-core";

const DEPS: CoreSessionDeps = {
  createAgentSession,
  ResourceLoader: DefaultResourceLoader,
  SessionManager: SessionManager as unknown as CoreSessionDeps["SessionManager"],
};

export interface VisionImageInput {
  type: "image";
  mimeType: string;
  data: string;
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
};

export function imageMimeFromExt(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

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

/** 用视觉模型读一张图（base64），返回模型文字回答。 */
export async function describeImageViaVision(
  opts: {
    dataDir: string;
    parentId: string;
    auth: Record<string, unknown>;
    appSettings?: Record<string, unknown>;
    agentDir: string;
  },
  image: VisionImageInput,
  question?: string
): Promise<string> {
  const runtime = await getWorkerRuntime(opts.dataDir, opts.parentId, opts.auth);
  const model = pickVisionModel(runtime, opts.appSettings);

  const loader = new DefaultResourceLoader({
    cwd: opts.agentDir,
    agentDir: opts.agentDir,
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () =>
      "你是家长工作台里的「图片理解助手」。用户会给你一张图片（教材页/截图/图示等），" +
      "请忠实描述画面内容并识别图中全部文字（含标题、正文、标注），保持准确、不臆造。",
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: opts.agentDir,
    agentDir: opts.agentDir,
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
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
      /* 忽略 */
    }
  }
}

export { DEPS as VISION_SESSION_DEPS };

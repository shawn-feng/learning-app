import { describe, it, expect, beforeAll } from "vitest";
import { getSharedRuntime, getAvailableModels, setProviderApiKey } from "../electron/lib/pi-runtime";

// 验证 ISSUE-007 实施：经 DashScope 同端点挂入 qwen provider 的 DeepSeek V4 模型。
// 核心要求（避免「思考混进正文」bug）：
//   1. 3 个 DeepSeek 模型都被注册进 qwen provider（无后缀 deepseek-v4-flash 已随百炼下线移除，
//      仅保留定点快照 -0731 与 pro/-0813）；
//   2. compat.thinkingFormat === "deepseek"（不是 "qwen"，否则 reasoning_content 会进正文）；
//   3. compat.requiresReasoningContentOnAssistantMessages === true；
//   4. maxTokens === 384000（DeepSeek-V4 思考+输出共享上限，区别于 qwen 的 16k/32k/65k）。

const EXPECTED_DS = [
  "deepseek-v4-flash-0731",
  "deepseek-v4-pro",
  "deepseek-v4-pro-0813",
];

describe("ISSUE-007 qwen provider 挂载 DeepSeek 模型", () => {
  let runtime: Awaited<ReturnType<typeof getSharedRuntime>>;

  beforeAll(async () => {
    // 测试环境无真实 key：写入占位 key，使 SDK getAvailable() 认为 qwen/deepseek 已配置 auth。
    // 否则 auth.json 为空 → getAvailable() 只枚举「已配 auth 的 provider」→ 返回 []（根因）。
    // setProviderApiKey 写 auth.json 后销毁 runtime 缓存，下一次 getSharedRuntime 重建即读到 key。
    await setProviderApiKey("qwen", "sk-test-placeholder");
    await setProviderApiKey("deepseek", "sk-test-placeholder");
    runtime = await getSharedRuntime();
  });

  it("qwen provider 下存在全部 3 个 DeepSeek 模型", () => {
    for (const id of EXPECTED_DS) {
      const model = runtime.getModel("qwen", id);
      expect(model, `qwen/${id} 应被注册`).toBeTruthy();
    }
  });

  it("DeepSeek 模型 compat.thinkingFormat 必须为 'deepseek'（防止思考混进正文）", () => {
    for (const id of EXPECTED_DS) {
      const model = runtime.getModel("qwen", id)!;
      const fmt = (model as any).compat?.thinkingFormat;
      expect(fmt, `qwen/${id} 的 thinkingFormat`).toBe("deepseek");
    }
  });

  it("DeepSeek 模型 requiresReasoningContentOnAssistantMessages 必须为 true", () => {
    for (const id of EXPECTED_DS) {
      const model = runtime.getModel("qwen", id)!;
      expect((model as any).compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
    }
  });

  it("DeepSeek 模型 maxTokens 必须为 384000", () => {
    for (const id of EXPECTED_DS) {
      const model = runtime.getModel("qwen", id)!;
      expect((model as any).maxTokens).toBe(384000);
    }
  });

  it("qwen 官方模型 thinkingFormat 仍为 'qwen'（未被 DeepSeek 改动污染）", () => {
    const qwenFlash = runtime.getModel("qwen", "qwen-flash")!;
    expect((qwenFlash as any).compat?.thinkingFormat).toBe("qwen");
  });

  it("getAvailableModels() 返回的可用模型包含 qwen/deepseek 项", async () => {
    const all = await getAvailableModels();
    // getAvailable() 返回扁平列表，每项形如 { provider, id, ... }
    const flat = (all as any[]).map((m) => `${m.provider}/${m.id}`);
    for (const id of EXPECTED_DS) {
      expect(flat, `可用模型应含 qwen/${id}`).toContain(`qwen/${id}`);
    }
  });
});

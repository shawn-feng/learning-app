/**
 * ISSUE-052 回归测试：qwen.ts ASR 识别文本的多路径提取 + 错误真因透出。
 * 用 stub global.fetch 喂三种响应结构（不发起真实网络），验证：
 *  1. 按量 DashScope（双层 output.output.sentence[]）能取到文本
 *  2. token-plan MaaS（单层 output.sentence 对象 / output.text / 顶层 text）能取到文本
 *  3. HTTP 成功但响应空 → 抛带真因的错误（不再笼统「未返回识别文本」）
 *  4. 静音（NO_WORDS 语义）→ 抛「没有识别到语音」短路文案
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { transcribe } from "../electron/lib/voice/providers/qwen";

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}
function errResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("qwen ASR 响应文本提取（ISSUE-052）", () => {
  const wav = Buffer.from("RIFF fake wav");

  it("按量 DashScope 双层 output.output.sentence[] → 取到文本", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        okResponse({
          output: {
            output: {
              sentence: [{ text: "你好世界", sentence_id: 0 }],
            },
          },
        })
      );
    const text = await transcribe(wav, {
      apiKey: "sk-test",
      endpoint: "https://dashscope.aliyuncs.com/.../generation",
    });
    expect(text).toBe("你好世界");
    expect(spy).toHaveBeenCalledOnce();
  });

  it("token-plan 单层 output.sentence 对象 + 顶层 text → 取到文本", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({
        request_id: "req-1",
        text: "today lesson",
        output: {
          request_id: "req-1",
          text: "today lesson",
          sentence: {
            sentence_id: 0,
            begin_time: 0,
            end_time: null,
            text: "today lesson",
            words: [],
          },
        },
      })
    );
    const text = await transcribe(wav, {
      apiKey: "sk-sp-test",
      endpoint: "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    });
    expect(text).toBe("today lesson");
  });

  it("token-plan 只有 output.text（无 sentence）→ 也能取到", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ output: { text: "only output text", request_id: "req" } })
    );
    const text = await transcribe(wav, { apiKey: "sk-sp-test", endpoint: "https://token-plan.../generation" });
    expect(text).toBe("only output text");
  });

  it("HTTP 200 但无文本 → 抛带真因错误，不透出代码当文案", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ output: { text: "", sentence: { text: "" } }, code: "DataInspectionFailed", message: "内容检测未通过" })
    );
    await expect(transcribe(wav, { apiKey: "sk-test", endpoint: "dashscope" })).rejects.toThrow(
      /内容检测未通过|DataInspectionFailed/
    );
  });

  it("HTTP 200 全空响应无 code/message → 抛 HTTP 状态兜底（不再『未返回识别文本』）", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse({ output: {} }));
    await expect(transcribe(wav, { apiKey: "sk-test", endpoint: "dashscope" })).rejects.toThrow(
      /千问识别失败/
    );
    await expect(transcribe(wav, { apiKey: "sk-test", endpoint: "dashscope" })).rejects.not.toThrow(
      /未返回识别文本/
    );
  });

  it("静音 NO_WORDS 语义 → 短路文案『没有识别到语音』", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      errResponse(400, { code: "CLIENT_ERROR", message: "InvalidParameter: no words found in audio" })
    );
    await expect(transcribe(wav, { apiKey: "sk-test", endpoint: "dashscope" })).rejects.toThrow(
      /没有识别到语音/
    );
  });
});

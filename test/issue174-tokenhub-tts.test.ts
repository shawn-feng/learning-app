/**
 * ISSUE-174 续：服务端 TTS 接入 TokenHub（管理端「语音合成模型」= minimax-speech-* 时启用）。
 * 官方同步合成代理 POST /v1/wand/minimax-tts/sync_tts（文档 /document/product/1823/135796，
 * 2026-10-12 实测：hex 音频、status=2 完成、usage.total_tokens 与文本同池计费）。
 * stub global.fetch + EdgeTTS（不发真实网络），验证：
 *  1. 渠道分发：minimax-speech-* + 家长 Key → tokenhub；无 Key / edge-tts / indextts-2 → edge
 *  2. 请求体：model/text/voice_setting(speed·vol)/audio_setting(24kHz mp3)/output_format=hex
 *  3. 响应解析：hex → MP3 Buffer、usage.total_tokens 带出
 *  4. base_resp.status_code != 0 → 报官方 status_msg；缺 Key / 未接入模型 → 可读错误
 *  5. synthesizeReply 端到端：tokenhub 渠道出音频带 usage；缓存命中不再打 API；tokenhub
 *     失败回落 edge-tts（回复音频不缺席）
 *  6. 用量口径：minimax-speech-* 计入 TokenHub 白名单、归类 tts（配额面板语音合成卡片）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 管理端默认模型 → minimax-speech-2.8-turbo（tokenhub 渠道生效的前提）
vi.mock("../server/src/auth/tokenhub", () => ({
  getSystemDefaultModels: () => ({
    text: "tokenhub/deepseek/deepseek-flash",
    vision: "tokenhub/deepseek/deepseek-v4-flash-vision-exp",
    asr: "hy-asr-3.0-preview",
    tts: "minimax-speech-2.8-turbo",
    voice: "female-shaonv",
  }),
}));
// edge-tts 不出真实网络：固定返回可识别的假 MP3
vi.mock("@andresaya/edge-tts", () => ({
  EdgeTTS: class {
    async synthesize() {}
    toBuffer() {
      return Buffer.from("edge-fake-mp3");
    }
  },
}));

const { synthesizeTokenhubTts, pickTtsPlan, synthesizeReply } = await import("../server/src/tts/index");
const { classifyModelCategory, isTokenHubModel } = await import("../server/src/db/token-usage");

const HEX_AUDIO = Buffer.from("ID3\x04fake-mp3-bytes").toString("hex");

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}
function tokenhubOk() {
  return okResponse({
    data: { audio: HEX_AUDIO, status: 2 },
    base_resp: { status_code: 0, status_msg: "success" },
    usage: { chars: 41, total_tokens: 820 },
  });
}
function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tts-test-")));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("渠道分发 pickTtsPlan", () => {
  it("minimax-speech-* + 家长 Key → tokenhub", () => {
    expect(pickTtsPlan("minimax-speech-2.8-turbo", "sk-key")).toBe("tokenhub");
    expect(pickTtsPlan("minimax-speech-02-hd", " sk-key ")).toBe("tokenhub");
  });
  it("无 Key / edge-tts / 未接入模型 → edge", () => {
    expect(pickTtsPlan("minimax-speech-2.8-turbo", "")).toBe("edge");
    expect(pickTtsPlan("minimax-speech-2.8-turbo", undefined)).toBe("edge");
    expect(pickTtsPlan("edge-tts", "sk-key")).toBe("edge");
    expect(pickTtsPlan("indextts-2", "sk-key")).toBe("edge");
    expect(pickTtsPlan("", "sk-key")).toBe("edge");
  });
});

describe("synthesizeTokenhubTts 请求/响应", () => {
  it("请求体含官方字段（voice_setting/audio_setting/hex），响应 hex 解码为 MP3 + usage", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
    const r = await synthesizeTokenhubTts("你好，今天天气真不错。", {
      model: "minimax-speech-2.8-turbo",
      apiKey: "sk-test",
      rate: "+20%",
      volume: "100%",
    });
    expect(r.buffer.toString("latin1")).toBe(Buffer.from(HEX_AUDIO, "hex").toString("latin1"));
    expect(r.buffer.subarray(0, 3).toString("latin1")).toBe("ID3");
    expect(r.usage).toEqual({ total: 820 });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://tokenhub.tencentmaas.com/v1/wand/minimax-tts/sync_tts");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("minimax-speech-2.8-turbo");
    expect(body.output_format).toBe("hex");
    expect(body.voice_setting.voice_id).toBe("minimax_55e81114-ce7e-4ca1"); // 直调不带 voice → 兜底默认音色
    expect(body.voice_setting.speed).toBeCloseTo(1.2); // +20% → 1.2
    expect(body.voice_setting.vol).toBe(1);
    expect(body.audio_setting).toMatchObject({ sample_rate: 24000, format: "mp3", channel: 1 });
  });

  it("直调带 voice（管理端「合成音色」）→ 透传 voice_id", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
    await synthesizeTokenhubTts("测试", { model: "minimax-speech-2.8-turbo", apiKey: "sk", voice: "clever_boy" });
    const body = JSON.parse(String((spy.mock.calls[0] as any)[1].body));
    expect(body.voice_setting.voice_id).toBe("clever_boy");
  });

  it("语速/音量夹取：-80% → 0.5 下限；1000% 音量 → 上限 10", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
    await synthesizeTokenhubTts("测试", { model: "minimax-speech-2.8-turbo", apiKey: "sk", rate: "-80%", volume: "1000%" });
    const body = JSON.parse(String((spy.mock.calls[0] as any)[1].body));
    expect(body.voice_setting.speed).toBe(0.5);
    expect(body.voice_setting.vol).toBe(10);
  });

  it("base_resp.status_code != 0 → 抛官方 status_msg", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ base_resp: { status_code: 1004, status_msg: "invalid api key" } })
    );
    await expect(
      synthesizeTokenhubTts("你好", { model: "minimax-speech-2.8-turbo", apiKey: "sk-bad" })
    ).rejects.toThrow(/invalid api key/);
  });

  it("合成未完成（status!=2）/ 缺 Key / 未接入模型 → 可读错误", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      okResponse({ data: { audio: "", status: 1 }, base_resp: { status_code: 0 } })
    );
    await expect(
      synthesizeTokenhubTts("你好", { model: "minimax-speech-2.8-turbo", apiKey: "sk" })
    ).rejects.toThrow(/未完成/);
    await expect(
      synthesizeTokenhubTts("你好", { model: "minimax-speech-2.8-turbo", apiKey: "" })
    ).rejects.toThrow(/缺少 API Key/);
    await expect(
      synthesizeTokenhubTts("你好", { model: "indextts-2", apiKey: "sk" })
    ).rejects.toThrow(/不支持模型/);
  });
});

describe("synthesizeReply 渠道端到端（stub fetch）", () => {
  it("tokenhub 渠道：出音频带 model+usage；同文本再合成走缓存不再打 API", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
    const dir = tmpDir();
    const r1 = await synthesizeReply("你好世界", { tokenhubApiKey: "sk-test" }, dir);
    expect(r1.model).toBe("minimax-speech-2.8-turbo");
    expect(r1.usage).toEqual({ total: 820 });
    expect(r1.buffer.subarray(0, 3).toString("latin1")).toBe("ID3");
    const r2 = await synthesizeReply("你好世界", { tokenhubApiKey: "sk-test" }, dir);
    expect(r2.usage).toBeUndefined(); // 缓存命中：无新增官方计费
    expect(spy).toHaveBeenCalledOnce();
  });

  it("synthesizeReply 带 tokenhubVoice（家长端显式选择）→ 优先于云端配置音色", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(tokenhubOk());
    await synthesizeReply("音色覆盖测试", { tokenhubApiKey: "sk-test", tokenhubVoice: "male-qn-qingse" }, tmpDir());
    const body = JSON.parse(String((spy.mock.calls[0] as any)[1].body));
    expect(body.voice_setting.voice_id).toBe("male-qn-qingse");
  });

  it("tokenhub 失败 → 回落 edge-tts（不抛错、有音频、无 usage）", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));
    const r = await synthesizeReply("hello world", { tokenhubApiKey: "sk-test" }, tmpDir());
    expect(r.model).toBe("edge-tts");
    expect(r.usage).toBeUndefined();
    expect(r.buffer.toString()).toBe("edge-fake-mp3");
  });
});

describe("用量口径（配额面板四类拆分）", () => {
  it("minimax-speech-* 计入 TokenHub 白名单且归类 tts", () => {
    expect(isTokenHubModel("minimax-speech-2.8-turbo")).toBe(true);
    expect(isTokenHubModel("tokenhub/minimax-speech-02-hd")).toBe(true);
    expect(isTokenHubModel("indextts-2")).toBe(false); // 未接入，不会产生消耗
    expect(classifyModelCategory("minimax-speech-2.8-turbo")).toBe("tts");
    expect(classifyModelCategory("indextts-2")).toBe("tts");
    // 不污染既有归类
    expect(classifyModelCategory("hy-asr-3.0-preview")).toBe("asr");
    expect(classifyModelCategory("deepseek/deepseek-flash")).toBe("text");
  });
});

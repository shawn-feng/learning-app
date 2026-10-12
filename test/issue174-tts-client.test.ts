/**
 * ISSUE-174 续：客户端朗读 edge 分支改走服务端合成。
 * 背景：本机 edge-tts 被微软 403 拒绝（2026-10-12 实测），管理端 minimax-speech-* 只能在服务端调用。
 * electron/lib/voice/tts.ts 的 edge 分支现在优先调 serverFetchBinary("/tts/synthesize")（家长 JWT），
 * 失败回落本地 edge-tts。stub 三个依赖模块，验证：
 *  1. 默认（edge-tts provider）→ server 优先：返回 server 音频、路径/凭证/参数正确
 *  2. server 失败 → 回落本地 edge-tts（不抛错）
 *  3. 显式自定义 provider（qwen）不受影响（不走 server）
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env["PI_TEST_DATA_DIR"] = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tts-client-")));

const serverFetchBinary = vi.hoisted(() => vi.fn(async () => Buffer.from("server-mp3")));
vi.mock("../electron/lib/server-client", () => ({ serverFetchBinary }));
vi.mock("../electron/lib/client-data", () => ({ currentSessionToken: () => "tok-123" }));
vi.mock("@andresaya/edge-tts", () => ({
  EdgeTTS: class {
    async synthesize() {}
    toBuffer() {
      return Buffer.from("edge-fake-mp3");
    }
  },
}));
vi.mock("../electron/lib/voice/providers/qwen-tts", () => ({
  QWEN_TTS_VOICES: ["Cherry"],
  synthesizeQwenTts: vi.fn(async () => Buffer.from("qwen-fake-mp3")),
}));
vi.mock("../electron/lib/voice/providers/mimo-tts", () => ({
  MIMO_TTS_VOICES: ["mimo_default"],
  synthesizeMimoTts: vi.fn(async () => Buffer.from("mimo-fake-mp3")),
}));

const { synthesize } = await import("../electron/lib/voice/tts");

beforeEach(() => {
  serverFetchBinary.mockClear();
  serverFetchBinary.mockImplementation(async () => Buffer.from("server-mp3"));
});

describe("客户端 TTS 服务端优先分发", () => {
  it("默认 edge-tts provider → 优先调 /tts/synthesize（带 text/rate/volume + JWT）", async () => {
    const buf = await synthesize("你好世界", {});
    expect(buf.toString()).toBe("server-mp3");
    expect(serverFetchBinary).toHaveBeenCalledOnce();
    const [path, opts] = serverFetchBinary.mock.calls[0] as [string, { method: string; body: any; token: string }];
    expect(path).toBe("/tts/synthesize");
    expect(opts.method).toBe("POST");
    expect(opts.body).toMatchObject({ text: "你好世界" });
    expect(opts.token).toBe("tok-123");
  });

  it("server 失败 → 回落本地 edge-tts（不抛错）", async () => {
    serverFetchBinary.mockRejectedValue(new Error("server down"));
    const buf = await synthesize("回落测试", {});
    expect(buf.toString()).toBe("edge-fake-mp3");
  });

  it("显式自定义 provider（qwen）不走 server", async () => {
    await synthesize("自定义", { provider: "qwen" });
    expect(serverFetchBinary).not.toHaveBeenCalled();
  });
});

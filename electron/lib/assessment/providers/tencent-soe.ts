// 腾讯云智聆口语评测（新版）接入
// 协议（文档 product 1774 / 接口 107497）：
//   握手：wss://soe.cloud.tencent.com/soe/api/<AppID>?<参数字典序> &signature=<HmacSha1>
//   签名原文 = "soe.cloud.tencent.com/soe/api/<AppID>?" + 除 signature 外所有参数按 key 字典序
//             拼接 "k=v&..."（不 urlencode），用 SecretKey 做 HmacSha1 再 base64。
//   发送：二进制音频帧（wav 分片，保持 1:1 实时率：16k 每 40ms = 1280 字节），
//        最后发文本帧 {"type":"end"} 通知结束。
//   接收：{code, message, result:"{...}", final:0|1}；result 为 JSON 字符串，
//         final=1 表示评测完成（SuggestedScore/PronAccuracy/PronFluency/PronCompletion/Words/PhoneInfo）。
import crypto from "crypto";
import { extractWavPcm } from "../../voice/audio";
import type { AssessmentResult } from "../types";

const HOST = "soe.cloud.tencent.com/soe/api";
const WSS_BASE = "wss://soe.cloud.tencent.com/soe/api";
const TIMEOUT_MS = 30_000;

/** 构造智聆握手 URL：参数字典序 → HmacSha1(SecretKey) → base64 签名 → wss URL（含签名参数） */
export function buildSoeUrl(
  creds: { appId: string; secretId: string; secretKey: string },
  refText: string
): { url: string; signPlain: string; signature: string } {
  const appId = creds.appId.trim();
  const secretId = creds.secretId.trim();
  const secretKey = creds.secretKey.trim();

  const timestamp = Math.floor(Date.now() / 1000);
  const expired = timestamp + 3600; // 签名有效期 1 小时（<90 天）
  const nonce = Math.floor(Math.random() * 900000000) + 100000000;
  const voiceId = crypto.randomUUID();

  // 儿童场景：score_coeff=1.0（最低苛刻度，对应最小年龄段）；句子模式 eval_mode=1；
  // rec_mode=1 录音评测；voice_format=0 pcm（16bit PCM 长度必为偶数，规避 4107 对齐报错）；16k_en 英文标准引擎。
  const params: Record<string, string | number> = {
    eval_mode: 1,
    expired,
    nonce,
    rec_mode: 1,
    ref_text: refText,
    score_coeff: 1.0,
    secretid: secretId,
    sentence_info_enabled: 1,
    server_engine_type: "16k_en",
    text_mode: 0,
    timestamp,
    voice_format: 0,
    voice_id: voiceId,
  };

  const sorted = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signPlain = `${HOST}/${appId}?` + sorted.map(([k, v]) => `${k}=${v}`).join("&");
  const signature = crypto.createHmac("sha1", secretKey).update(signPlain, "utf-8").digest("base64");

  const query = sorted
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  return {
    url: `${WSS_BASE}/${appId}?${query}&signature=${encodeURIComponent(signature)}`,
    signPlain,
    signature,
  };
}

export async function assess(
  wav: Buffer,
  creds: Record<string, string>,
  opts: { refText: string }
): Promise<AssessmentResult> {
  const appId = (creds.appId || "").trim();
  const secretId = (creds.secretId || "").trim();
  const secretKey = (creds.secretKey || "").trim();
  if (!appId || !secretId || !secretKey) {
    throw new Error("智聆配置不完整（appId / secretId / secretKey）");
  }
  const { url } = buildSoeUrl({ appId, secretId, secretKey }, opts.refText);

  // 转纯 PCM（16k/单声道/16bit）发送：voice_format=0 时引擎按 16bit 样本对齐解析，
  // PCM 长度必为偶数，规避 4107「音频数据指针或长度必须为偶数」（wav 头解析不可靠）。
  let pcm: Buffer;
  try {
    pcm = extractWavPcm(wav);
  } catch (e) {
    throw new Error(`智聆音频格式异常：${(e as Error).message}（需要 16kHz/单声道/16bit WAV）`);
  }

  // 使用 Node 22+/Electron 内置全局 WebSocket（undici），不依赖 ws 包——
  // ws 的可选依赖 bufferutil/utf-8-validate 在 electron-vite 打包时解析失败
  // （Could not resolve "bufferutil" imported by "ws"）。
  return new Promise<AssessmentResult>((resolve, reject) => {
    let done = false;
    let ws: WebSocket;
    let connError = "";
    const finish = (err?: Error, result?: AssessmentResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* noop */
      }
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("智聆评测超时（30s）")), TIMEOUT_MS);

    ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      // ⚠️ rec_mode=1（录音评测）模式下**只能发送一个数据包**（错误 4015）：
      // 整个音频一次性发出，不可分片。分片发送只适用于 rec_mode=0（流式实时模式，需保持 1:1 实时率）。
      ws.send(pcm);
      ws.send(JSON.stringify({ type: "end" }));
    });

    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      const text =
        typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf-8");
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (typeof msg.code === "number" && msg.code !== 0) {
        finish(new Error(`智聆返回错误(${msg.code}): ${msg.message || "未知错误"}`));
        return;
      }
      if (msg.final === 1) {
        if (msg.result) {
          try {
            // result 可能是 JSON 字符串（流式中间结果），也可能是已解析的对象（录音模式最终结果）
            const r = typeof msg.result === "string" ? JSON.parse(msg.result) : msg.result;
            finish(undefined, parseSoeResult(r));
          } catch (e) {
            finish(new Error(`解析智聆结果失败: ${(e as Error).message}`));
          }
        } else {
          finish(new Error("智聆返回 final 但无 result"));
        }
      }
    });

    ws.addEventListener("error", () => {
      connError = "连接失败（请检查网络 / SecretId / SecretKey）";
    });
    ws.addEventListener("close", () => {
      if (!done) finish(new Error(connError || "智聆连接被服务端关闭"));
    });
  });
}

export function parseSoeResult(r: any): AssessmentResult {
  const words = Array.isArray(r.Words)
    ? r.Words.map((w: any) => ({
        word: w.ReferenceWord || w.Word || "",
        score: Math.round(w.PronAccuracy ?? 0),
        dpType: typeof w.MatchTag === "number" ? w.MatchTag : undefined,
        phones: Array.isArray(w.PhoneInfo)
          ? w.PhoneInfo.map((p: any) => ({
              phone: p.ReferencePhone || p.Phone || "",
              score: Math.round(p.PronAccuracy ?? 0),
            }))
          : [],
      }))
    : [];
  return {
    provider: "tencent-soe",
    score: Math.round(r.SuggestedScore ?? 0),
    accuracy: Math.round(r.PronAccuracy ?? 0),
    fluency: Math.round(r.PronFluency ?? 0),
    completeness: Math.round(r.PronCompletion ?? 0),
    words,
    raw: r,
  };
}

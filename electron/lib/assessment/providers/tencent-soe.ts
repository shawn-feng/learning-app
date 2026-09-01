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
  // rec_mode=1 录音评测；voice_format=1 wav；16k_en 英文标准引擎。
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
    voice_format: 1,
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

  const { default: WS } = await import("ws");
  return new Promise<AssessmentResult>((resolve, reject) => {
    let done = false;
    let ws: InstanceType<typeof WS>;
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

    ws = new WS(url);
    ws.on("open", () => {
      // wav 分片发送（保持 1:1 实时率，防止引擎报"发送过快"错误）
      const CHUNK = 1280; // 16k * 2B * 40ms
      let offset = 0;
      const sendNext = () => {
        if (done) return;
        if (offset < wav.length) {
          const end = Math.min(offset + CHUNK, wav.length);
          ws.send(wav.subarray(offset, end));
          offset = end;
          setTimeout(sendNext, 40);
        } else {
          ws.send(JSON.stringify({ type: "end" }));
        }
      };
      sendNext();
    });

    ws.on("message", (data: Buffer) => {
      const text = typeof data === "string" ? data : data.toString("utf-8");
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
            finish(undefined, parseSoeResult(JSON.parse(msg.result)));
          } catch (e) {
            finish(new Error(`解析智聆结果失败: ${(e as Error).message}`));
          }
        } else {
          finish(new Error("智聆返回 final 但无 result"));
        }
      }
    });

    ws.on("error", (err: Error) => finish(new Error(`智聆连接失败: ${err.message}`)));
    ws.on("close", () => {
      if (!done) finish(new Error("智聆连接被服务端关闭"));
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

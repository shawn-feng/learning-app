// 阿里 SSECP（声希）客户端发音评测 —— 严格按声希官方 HTTP POST API 实现。
// 架构：评测在 app 客户端（Electron 主进程）完成，不经过我们的云服务端。
//   鉴权：声希直连 authorize（明文 http://api.cloud.ssapi.cn:8080，MD5 签名）→ warrant_id
//   评测：HTTPS POST https://api.cloud.ssapi.cn/{coreType}?appkey&connect_id&request_id&warrant_id
//         multipart 表单：text(JSON: {connect, start}) + audio(wav 文件)
//   要点：connect_id/request_id 须 32 位 UUID；Request-Index:0 头必带
// 题型映射：中文（含汉字）→ cn.pred.score（段落/背诵，天然支持长文本，无需拆句/拆音频）；英文 → en.sent.score
// 不需要阿里云 AccessKey，也不需要卡死的 CreateAccessWarrant.requestSign（声希私有算法）。
import { createHash, randomUUID } from "crypto";
import type { AssessmentResult, WordScore } from "../types";

const AUTH_URL = "http://api.cloud.ssapi.cn:8080/auth/authorize";
const API_BASE = "https://api.cloud.ssapi.cn";

const CJK_RE = /[㐀-鿿豈-﫿]/;

/** 按参考文本语种选声希 coreType：中文背诵/段落走 cn.pred.score（支持长文本），英文走 en.sent.score。 */
export function coreTypeForText(refText: string): string {
  return CJK_RE.test(refText || "") ? "cn.pred.score" : "en.sent.score";
}

interface SsecpCreds {
  appKey: string;
  appSecret: string;
  userId?: string;
}

/** 声希直连鉴权，返回 warrant_id（默认 120 分钟有效）。 */
async function authorize(creds: SsecpCreds): Promise<string> {
  const userId = creds.userId || "pi-child";
  const timestamp = String(Math.floor(Date.now() / 1000));
  const clientIp = "127.0.0.1";
  const signRaw =
    `app_secret=${creds.appSecret}&appid=${creds.appKey}&timestamp=${timestamp}` +
    `&user_client_ip=${clientIp}&user_id=${userId}`;
  const requestSign = createHash("md5").update(signRaw, "utf-8").digest("hex");
  const body = new URLSearchParams({
    appid: creds.appKey,
    timestamp,
    user_id: userId,
    user_client_ip: clientIp,
    request_sign: requestSign,
  });
  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json: any = await res.json();
  if (json?.code === 0 && json?.data?.warrant_id) return json.data.warrant_id;
  throw new Error(`声希鉴权失败 code=${json?.code} msg=${json?.message || JSON.stringify(json).slice(0, 160)}`);
}

const uuid32 = () => randomUUID().replace(/-/g, "");

export async function assess(
  wav: Buffer,
  creds: Record<string, string>,
  opts: { refText: string }
): Promise<AssessmentResult> {
  const appKey = (creds.appKey || "").trim();
  const appSecret = (creds.appSecret || "").trim();
  if (!appKey || !appSecret) {
    throw new Error("阿里 SSECP 配置不完整（appKey / appSecret）");
  }
  const userId = (creds.userId || "pi-child").trim();
  const refText = opts.refText || "";
  const coreType = coreTypeForText(refText);

  const warrantId = await authorize({ appKey, appSecret, userId });
  const connectId = uuid32();
  const requestId = uuid32();
  const ts = String(Math.floor(Date.now() / 1000));

  const textPayload = JSON.stringify({
    start: {
      cmd: "start",
      param: {
        app: {
          warrantId,
          timestamp: ts,
          userId,
          sig: "default",
          signature: "default",
          connect_id: connectId,
          applicationId: appKey,
        },
        audio: { sampleBytes: 2, sampleRate: 16000, channel: 1, audioType: "wav" },
        request: {
          tokenId: userId,
          precision: 1.0,
          rank: 100,
          refText,
          ginger_mode: "Synchrony",
          coreType,
          request_id: requestId,
        },
      },
    },
    connect: {
      cmd: "connect",
      param: {
        app: {
          warrantId,
          timestamp: ts,
          userId,
          sig: "default",
          signature: "default",
          connect_id: connectId,
          applicationId: appKey,
        },
        sdk: { source: 7, version: 1, protocol: 2 },
      },
    },
  });

  const url =
    `${API_BASE}/${coreType}` +
    `?appkey=${encodeURIComponent(appKey)}` +
    `&connect_id=${connectId}&request_id=${requestId}&warrant_id=${encodeURIComponent(warrantId)}`;

  const form = new FormData();
  form.append("text", textPayload);
  form.append("audio", new Blob([wav], { type: "audio/wav" }), "test.wav");

  const res = await fetch(url, {
    method: "POST",
    headers: { "Request-Index": "0" },
    body: form,
  });
  const bodyText = await res.text();
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`声希返回非 JSON（HTTP ${res.status}）：${bodyText.slice(0, 160)}`);
  }
  if (!parsed?.result) {
    throw new Error(`声希评测失败（HTTP ${res.status}）：${bodyText.slice(0, 160)}`);
  }
  return parseSsecpResult(parsed, coreType);
}

function parseSsecpResult(parsed: any, coreType: string): AssessmentResult {
  const r = parsed.result || {};
  const words: WordScore[] = [];

  if (Array.isArray(r.details)) {
    if (coreType.startsWith("cn")) {
      // 中文两层：details[句] -> snt_details[字]
      for (const snt of r.details) {
        const chars = Array.isArray(snt.snt_details) ? snt.snt_details : [];
        for (const ch of chars) {
          words.push({
            word: ch.chn_char || ch.char || "",
            score: Math.round(ch.score ?? 0),
            dpType: typeof ch.dp_type === "number" ? ch.dp_type : undefined,
            phones: [],
          });
        }
      }
    } else {
      // 英文一层：details[词]
      for (const w of r.details) {
        words.push({
          word: w.char || w.word || "",
          score: Math.round(w.score ?? 0),
          dpType: typeof w.dp_type === "number" ? w.dp_type : undefined,
          phones: [],
        });
      }
    }
  }

  const fluencyVal = r.fluency && typeof r.fluency === "object" ? r.fluency.overall : r.fluency;

  return {
    provider: "aliyun-ssecp",
    score: Math.round(r.overall ?? r.pron ?? 0),
    accuracy: r.accuracy != null ? Math.round(r.accuracy) : undefined,
    fluency: fluencyVal != null ? Math.round(fluencyVal) : undefined,
    completeness: r.integrity != null ? Math.round(r.integrity) : undefined,
    words,
    raw: parsed,
  };
}

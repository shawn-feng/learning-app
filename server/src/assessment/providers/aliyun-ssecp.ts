// 阿里 SSECP（声希）客户端发音评测 —— 严格按声希官方 HTTP POST API 实现。
//   鉴权：声希直连 authorize（明文 http://api.cloud.ssapi.cn:8080，MD5 签名）→ warrant_id
//   评测：HTTPS POST https://api.cloud.ssapi.cn/{coreType}?appkey&connect_id&request_id&warrant_id
//         multipart 表单：text(JSON: {connect, start}) + audio(wav 文件)
// 题型映射：中文（含汉字）→ cn.pred.score（段落/背诵，天然支持长文本）；英文 → en.sent.score
// 不需要阿里云 AccessKey。
import { createHash, randomUUID } from "crypto";
import type { AssessmentResult, SpeechSentence, WordScore } from "../types.js";
import { dimensionMeanScore } from "../score.js";

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
  opts: { refText: string; /** 打分松紧 0-4（0=不传，保持引擎默认；1 严格 / 2 宽松 / 3 非常严格 / 4 非常宽松） */ typeThres?: number }
): Promise<AssessmentResult> {
  const appKey = (creds.appKey || "").trim();
  const appSecret = (creds.appSecret || "").trim();
  if (!appKey || !appSecret) {
    throw new Error("阿里 SSECP 配置不完整（appKey / appSecret）");
  }
  const userId = (creds.userId || "pi-child").trim();
  const refText = opts.refText || "";
  const coreType = coreTypeForText(refText);
  const typeThres = Number(opts.typeThres) || 0;
  const withTypeThres = typeThres >= 1 && typeThres <= 4;

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
          // 0/缺省 = 不传，保持引擎默认松紧
          ...(withTypeThres ? { typeThres } : {}),
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

/** 有限数字才收，其余（undefined/null/NaN/字符串）一律 undefined。 */
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 单个字/词节点 → WordScore。
 * 中文取 chn_char（可能带标点）、拼音 char、tone/tonescore；英文取 char、音素 phone[]。
 * isCn=false 时不映射 tone/tonescore（英文的 tonescore 是"升降调 0/1"，语义不同）。
 */
function toWordScore(node: any, isCn: boolean): WordScore {
  const phones = Array.isArray(node?.phone)
    ? node.phone
        .map((p: any) => ({
          phone: String(p?.char ?? p?.phone ?? ""),
          score: Math.round(num(p?.score) ?? 0),
          startMs: num(p?.start),
          endMs: num(p?.end),
        }))
        .filter((p: { phone: string }) => p.phone)
    : [];
  const toneScore = num(node?.tonescore);
  return {
    word: String(node?.chn_char ?? node?.char ?? node?.word ?? ""),
    score: Math.round(num(node?.score) ?? num(node?.overall) ?? 0),
    dpType: typeof node?.dp_type === "number" ? node.dp_type : undefined,
    tone: isCn ? num(node?.tone) : undefined,
    toneScore: isCn && toneScore != null ? Math.round(toneScore) : undefined,
    isPause: node?.is_pause === 1 || node?.is_pause === true ? true : undefined,
    startMs: num(node?.start),
    endMs: num(node?.end),
    phones,
  };
}

/**
 * 声希结果 → AssessmentResult（导出供回归测试对账「维度平均」口径）。
 *
 * details 有两种形状（官方文档）：
 *  - 嵌套：中文篇章 cn.pred.score / 英文段落 en.pred.score → details[] = 句子 {text,score,fluency,snt_details[]}
 *  - 平铺：中文背诵 cn.recite.score / 单字 cn.word.score / 英文句子 en.sent.score → details[] = 字/词
 * 这里按节点是否带 snt_details 自动判别，避免换题型后取空（旧实现只按 coreType 前缀分支）。
 */
export function parseSsecpResult(parsed: any, coreType: string): AssessmentResult {
  const r = parsed?.result || {};
  const isCn = coreType.startsWith("cn");
  const words: WordScore[] = [];
  const sentences: SpeechSentence[] = [];

  if (Array.isArray(r.details)) {
    for (let si = 0; si < r.details.length; si++) {
      const node: any = r.details[si];
      if (Array.isArray(node?.snt_details)) {
        const f = node.fluency && typeof node.fluency === "object" ? node.fluency : {};
        sentences.push({
          text: String(node.text ?? ""),
          score: Math.round(num(node.score) ?? 0),
          pause: num(f.pause),
          speed: num(f.speed),
        });
        for (const item of node.snt_details) {
          const w = toWordScore(item, isCn);
          if (!w.word) continue;
          w.sentenceIndex = si;
          words.push(w);
        }
      } else {
        const w = toWordScore(node, isCn);
        if (!w.word) continue;
        w.sentenceIndex = 0;
        words.push(w);
      }
    }
  }

  const fluencyVal = r.fluency && typeof r.fluency === "object" ? r.fluency.overall : r.fluency;
  const info = r.info && typeof r.info === "object" ? r.info : {};

  // ISSUE-183：最终分 = 各维度平均（见 ../score.ts）；三维度都缺才回退 overall，再缺 0。
  return {
    provider: "aliyun-ssecp",
    score: dimensionMeanScore([r.accuracy, fluencyVal, r.integrity], r.overall ?? r.pron),
    accuracy: r.accuracy != null ? Math.round(r.accuracy) : undefined,
    fluency: fluencyVal != null ? Math.round(fluencyVal) : undefined,
    completeness: r.integrity != null ? Math.round(r.integrity) : undefined,
    words,
    sentences: sentences.length ? sentences : undefined,
    audioQuality:
      num(info.tipId) != null || num(info.snr) != null
        ? { tipId: num(info.tipId), snr: num(info.snr), clip: num(info.clip), volume: num(info.volume) }
        : undefined,
    raw: parsed,
  };
}

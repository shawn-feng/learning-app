// SSECP 口语评测（声希引擎）服务端调用。
// 协议与 electron/lib/assessment/providers/aliyun-kid.ts 完全一致（同一后端 api.cloud.ssapi.cn），
// 此处移植到 learning-server（Node 22 全局 WebSocket + node:crypto），并扩展支持全部 coreType（21 题型）。
// 结果字段依 help.aliyun.com/document_detail/2996314（句子结果结构）：overall/pron(=accuracy)/integrity/
//   fluency{pause,speed}/rhythm{sense,stress,tone}/details[]{char,score,start,end,dp_type}/phone[]/syllable/stress/tipId。
// ⚠️ 实验性：coreType 与返回字段依公开资料还原，首次实测若报错按实际 SDK 行为微调下方常量即可。
import crypto from "node:crypto";
import type { SpeechAssessment, SsecpQuestionType } from "./question-types.js";
import { coreTypeOf } from "./question-types.js";

const AUTH_URL = "https://api.cloud.ssapi.cn:8080/auth/authorize";
const WS_URL = "wss://api.cloud.ssapi.cn";
const TIMEOUT_MS = 30_000;

export interface SsecpCreds {
  appKey: string;
  appSecret: string;
  userId?: string;
}

let cachedWarrant: { id: string; expireAt: number } | null = null;

async function authorize(creds: SsecpCreds): Promise<string> {
  const appKey = creds.appKey.trim();
  const appSecret = creds.appSecret.trim();
  if (!appKey || !appSecret) throw new Error("SSECP 评测配置不完整（appKey / appSecret）");

  const now = Date.now();
  if (cachedWarrant && cachedWarrant.expireAt - now > 60_000) return cachedWarrant.id;

  const userId = (creds.userId || "").trim() || "pi-child";
  const timestamp = String(Math.floor(now / 1000));
  const clientIp = "127.0.0.1"; // 鉴权一致性占位（DEMO 传本机公网 IP，评测仅用于签名）
  const signRaw =
    `app_secret=${appSecret}&appid=${appKey}&timestamp=${timestamp}` +
    `&user_client_ip=${clientIp}&user_id=${userId}`;
  const requestSign = crypto.createHash("md5").update(signRaw, "utf-8").digest("hex");

  const body = new URLSearchParams({
    appid: appKey,
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
  if (json.code === 0 && json.data?.warrant_id) {
    cachedWarrant = { id: json.data.warrant_id, expireAt: Number(json.data.expire_at || 0) * 1000 };
    return cachedWarrant.id;
  }
  throw new Error(`SSECP 鉴权失败: ${json.message || JSON.stringify(json).slice(0, 200)}`);
}

export async function assessSpeech(
  wav: Buffer,
  opts: { questionType: SsecpQuestionType | string; refText: string; creds: SsecpCreds; feedback?: boolean }
): Promise<SpeechAssessment> {
  const appKey = opts.creds.appKey.trim();
  const appSecret = opts.creds.appSecret.trim();
  const userId = (opts.creds.userId || "").trim() || "pi-child";
  const coreType = coreTypeOf(opts.questionType);
  if (!coreType) throw new Error(`不支持的口语题型：${opts.questionType}`);
  const warrantId = await authorize(opts.creds);

  return new Promise<SpeechAssessment>((resolve, reject) => {
    let done = false;
    let started = false;
    let connError = "";
    let ws: WebSocket;
    const timer = setTimeout(() => finish(new Error("SSECP 评测超时（30s）")), TIMEOUT_MS);

    function finish(err?: Error, result?: SpeechAssessment) {
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
    }

    const timestamp = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHash("md5").update(appSecret + timestamp, "utf-8").digest("hex");

    const sendConnect = () => {
      ws.send(
        JSON.stringify({
          cmd: "connect",
          param: {
            app: { timestamp, applicationId: appKey, sig },
            sdk: { version: "1.0.0", type: 0, source: 7, protocol: 1, os: "linux", os_version: "", arch: "", product: "" },
          },
        })
      );
    };

    const sendStart = () => {
      started = true;
      ws.send(
        JSON.stringify({
          cmd: "start",
          param: {
            request: { coreType, refText: opts.refText, rank: 100, feedback: opts.feedback ? 1 : 0 },
            audio: { sampleRate: 16000, channel: 1, sampleBytes: 2, audioType: "wav" },
            app: { userId },
          },
        })
      );
      // start 后按实时率发音频（16k 每 40ms = 1280 字节）
      const CHUNK = 1280;
      let offset = 0;
      const sendNext = () => {
        if (done) return;
        if (offset < wav.length) {
          const end = Math.min(offset + CHUNK, wav.length);
          ws.send(wav.subarray(offset, end));
          offset = end;
          setTimeout(sendNext, 40);
        } else {
          ws.send(JSON.stringify({ cmd: "stop", param: {} }));
        }
      };
      sendNext();
    };

    ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => sendConnect());

    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      const text = typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf-8");
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (msg.errId !== undefined || (msg.code !== undefined && msg.code !== 0)) {
        finish(new Error(`SSECP 错误: ${msg.error || msg.message || JSON.stringify(msg).slice(0, 200)}`));
        return;
      }
      if (!started) {
        sendStart();
        return;
      }
      if (msg.eof === 1 && msg.result) {
        try {
          finish(undefined, parseSsecpResult(msg.result, coreType));
        } catch (e) {
          finish(new Error(`解析 SSECP 结果失败: ${(e as Error).message}`));
        }
      }
    });

    ws.addEventListener("error", () => {
      connError = "SSECP 连接失败（检查网络 / AppKey / AppSecret）";
    });
    ws.addEventListener("close", () => {
      if (!done) finish(new Error(connError || "SSECP 连接被服务端关闭"));
    });
  });
}

export function parseSsecpResult(r: any, coreType: string): SpeechAssessment {
  const fluency = r.fluency
    ? { overall: Math.round(r.fluency.overall ?? 0), pause: r.fluency.pause, speed: r.fluency.speed }
    : undefined;
  const prosody = r.rhythm
    ? { overall: Math.round(r.rhythm.overall ?? 0), sense: r.rhythm.sense, stress: r.rhythm.stress, tone: r.rhythm.tone }
    : undefined;

  const details = Array.isArray(r.details) ? r.details : [];
  const words = details.map((d: any) => ({
    word: d.char || "",
    score: Math.round(d.score ?? 0),
    dpType: typeof d.dp_type === "number" ? d.dp_type : undefined,
    startMs: typeof d.start === "number" ? d.start : undefined,
    endMs: typeof d.end === "number" ? d.end : undefined,
    phones: Array.isArray(d.phone)
      ? d.phone.map((p: any) => ({ phone: p.char || "", score: Math.round(p.score ?? 0), startMs: p.start, endMs: p.end }))
      : [],
  }));

  const cnSyllables =
    coreType.startsWith("cn") && Array.isArray(r.syllable)
      ? r.syllable.map((s: any) => ({
          char: s.char || "",
          score: Math.round(s.score ?? 0),
          stress: Array.isArray(r.stress) ? r.stress.find((x: any) => x.char === s.char)?.score : undefined,
        }))
      : undefined;

  const audioQuality =
    r.info?.tipId !== undefined
      ? {
          tipId: r.info.tipId,
          snr: r.realtime_details?.info?.snr,
          clip: r.realtime_details?.info?.clip,
          volume: r.realtime_details?.info?.volume,
        }
      : undefined;

  return {
    provider: "aliyun-ssecp",
    overall: Math.round(r.overall ?? 0),
    pron: Math.round(r.pron ?? r.accuracy ?? 0),
    accuracy: r.accuracy != null ? Math.round(r.accuracy) : undefined,
    integrity: r.integrity != null ? Math.round(r.integrity) : undefined,
    fluency,
    prosody,
    words,
    cnSyllables,
    audioQuality,
    raw: { result: r, coreType },
  };
}

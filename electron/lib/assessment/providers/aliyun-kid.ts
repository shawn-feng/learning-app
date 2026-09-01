// 阿里云智能科教-口语评测（儿童单词 en.word_kid.score）接入
// 技术方为声希科技（singsound），鉴权与协议基于其公开 DEMO 与官方文档还原：
//   1) 鉴权：POST https://api.cloud.ssapi.cn:8080/auth/authorize（form）
//      参数 appid/timestamp/user_id/user_client_ip/request_sign
//      request_sign = MD5("app_secret=<secret>&appid=<appid>&timestamp=<ts>&user_client_ip=<ip>&user_id=<uid>")
//      返回 { code:0, data:{ warrant_id, expire_at } }
//   2) 评测：wss://api.cloud.ssapi.cn（WebSocket）
//      发送 JSON connect 包 → 收到回显 → 发送 JSON start 包（request.coreType/refText + audio 参数）
//      → 发送二进制音频帧 → 发送 stop 包 → 接收 { request_id, eof, params, refText, result }。
// ⚠️ 实验性：connect/start 包细节与连接 path 依据公开资料还原，首次实测若报错
//   （服务端返回 errId/error JSON），按实际 SDK 行为微调下方常量即可。
import crypto from "crypto";
import type { AssessmentResult } from "../types";

const AUTH_URL = "https://api.cloud.ssapi.cn:8080/auth/authorize";
const WS_URL = "wss://api.cloud.ssapi.cn"; // path 待实测确认（如有则形如 /v1/xxx）
const TIMEOUT_MS = 30_000;

let cachedWarrant: { id: string; expireAt: number } | null = null;

async function authorize(creds: Record<string, string>): Promise<string> {
  const appKey = (creds.appKey || "").trim();
  const appSecret = (creds.appSecret || "").trim();
  if (!appKey || !appSecret) throw new Error("阿里评测配置不完整（appKey / appSecret）");

  const now = Date.now();
  if (cachedWarrant && cachedWarrant.expireAt - now > 60_000) return cachedWarrant.id;

  const userId = (creds.userId || "").trim() || "pi-child";
  const timestamp = String(Math.floor(now / 1000));
  // user_client_ip：DEMO 中传本机公网 IP；评测仅用于鉴权一致性，取固定占位即可
  const clientIp = "127.0.0.1";
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
  throw new Error(`阿里评测鉴权失败: ${json.message || JSON.stringify(json).slice(0, 200)}`);
}

export async function assess(
  wav: Buffer,
  creds: Record<string, string>,
  opts: { refText: string }
): Promise<AssessmentResult> {
  const appKey = (creds.appKey || "").trim();
  const appSecret = (creds.appSecret || "").trim();
  const userId = (creds.userId || "").trim() || "pi-child";
  const warrantId = await authorize(creds);

  // 使用 Node 22+/Electron 内置全局 WebSocket（undici），不依赖 ws 包（同 tencent-soe.ts）。
  return new Promise<AssessmentResult>((resolve, reject) => {
    let done = false;
    let ws: WebSocket;
    let started = false; // 是否已发 start（connect 回显后再发）
    let connError = "";
    const timer = setTimeout(() => finish(new Error("阿里评测超时（30s）")), TIMEOUT_MS);

    function finish(err?: Error, result?: AssessmentResult) {
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
            sdk: {
              version: "1.0.0",
              type: 0,
              source: 7,
              protocol: 1,
              os: "windows",
              os_version: "",
              arch: "",
              product: "",
            },
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
            request: {
              coreType: "en.word_kid.score",
              refText: opts.refText,
              rank: 100,
            },
            audio: {
              sampleRate: 16000,
              channel: 1,
              sampleBytes: 2,
              audioType: "wav",
            },
            app: { userId },
          },
        })
      );
      // start 后按实时率发音频（与智聆一致：16k 每 40ms = 1280 字节）
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
      const text =
        typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf-8");
      let msg: any;
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      // 服务端错误（errId/error 结构）
      if (msg.errId !== undefined || (msg.code !== undefined && msg.code !== 0)) {
        finish(new Error(`阿里评测错误: ${msg.error || msg.message || JSON.stringify(msg).slice(0, 200)}`));
        return;
      }
      if (!started) {
        // connect 回显 → 发 start
        sendStart();
        return;
      }
      // 结果包：{ request_id, eof, params, refText, result }
      if (msg.eof === 1 && msg.result) {
        try {
          finish(undefined, parseKidResult(msg.result, appKey));
        } catch (e) {
          finish(new Error(`解析阿里评测结果失败: ${(e as Error).message}`));
        }
      }
    });

    ws.addEventListener("error", () => {
      connError = "连接失败（请检查网络 / AppKey / AppSecret）";
    });
    ws.addEventListener("close", () => {
      if (!done) finish(new Error(connError || "阿里评测连接被服务端关闭"));
    });
  });
}

export function parseKidResult(r: any, appKey: string): AssessmentResult {
  const details = Array.isArray(r.details) ? r.details : [];
  const words = details.map((d: any) => ({
    word: d.char || "",
    score: Math.round(d.score ?? 0),
    dpType: typeof d.dp_type === "number" ? d.dp_type : undefined,
    phones: Array.isArray(d.phone)
      ? d.phone.map((p: any) => ({
          phone: p.char || "",
          score: Math.round(p.score ?? 0),
          startMs: typeof p.start === "number" ? p.start : undefined,
          endMs: typeof p.end === "number" ? p.end : undefined,
        }))
      : [],
  }));
  return {
    provider: "aliyun-kid",
    score: Math.round(r.overall ?? 0),
    words,
    raw: { result: r, applicationId: appKey },
  };
}

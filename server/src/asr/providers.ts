/**
 * ASR 转录 provider（ISSUE-165：从 electron/lib/voice/providers/* 移植到服务端）。
 * 请求体、响应多路径解析（ISSUE-052 双通道结构兼容）、「没有识别到语音」语义判定
 * 全部逐字保留；唯一差异：兜底 API Key 不再读本机 auth.json，由调用方注入
 * （服务端从该家长 auth 封套解析，见 asr/config.ts getAuthEnvelopeKey）。
 */

const QWEN_ASR_ENDPOINT_PAYG = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

/** 千问（阿里云百炼）语音识别：qwen-audio-3.0-asr-flash，DashScope 原生接口（非 OpenAI 兼容）。 */
export async function transcribeQwen(
  wav: Buffer,
  creds: Record<string, string>,
  fallbackKey: string
): Promise<string> {
  const isTokenPlan = (creds.endpoint || "").includes("token-plan");
  const apiKey = (creds.apiKey || "").trim() || fallbackKey;
  if (!apiKey) {
    throw new Error(
      isTokenPlan
        ? "千问 token-plan 语音配置不完整（API Key 未填，且模型配置里也没有 token-plan Key）"
        : "千问语音配置不完整（API Key 未填，且模型配置里也没有千问按量 Key）"
    );
  }

  const endpoint = (creds.endpoint || "").trim() || QWEN_ASR_ENDPOINT_PAYG;
  const dataUri = `data:audio/wav;base64,${wav.toString("base64")}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "qwen-audio-3.0-asr-flash",
      input: {
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: dataUri } }],
          },
        ],
      },
      parameters: { format: "wav", sample_rate: "16000" },
    }),
  });

  const json: any = await res.json().catch(() => ({}));

  // 多路径提取识别文本，兼容两种计费通道的响应结构（ISSUE-052）：
  //   - 按量 DashScope：双层 output.output.sentence[]（sentence 是数组）
  //   - token-plan MaaS：单层 output.sentence（sentence 是对象）/ output.text / 顶层 text
  function pickText(body: any): string {
    if (!body || typeof body !== "object") return "";
    const readStr = (v: unknown): string => (typeof v === "string" ? v : "");
    const arrText =
      Array.isArray(body?.output?.output?.sentence) && body.output.output.sentence.length
        ? readStr(body.output.output.sentence[0]?.text)
        : "";
    if (arrText) return arrText;
    const single = readStr(body?.output?.sentence?.text);
    if (single) return single;
    return readStr(body?.output?.text) || readStr(body?.text) || readStr(body?.result?.text) || "";
  }

  function pickError(body: any): { code: string; message: string } {
    const code = String(
      body?.code ?? body?.output?.code ?? body?.error?.code ?? body?.output?.error?.code ?? ""
    );
    const message = String(
      body?.message ??
        body?.output?.message ??
        body?.error?.message ??
        body?.output?.error?.message ??
        body?.output?.sentence?.text ??
        ""
    );
    return { code, message };
  }

  // 「没识别到语音」语义判定（静音/太轻）：命中即短路，不发起 fallback。
  function isNoSpeech(code: string, message: string): boolean {
    const hay = `${code} ${message}`;
    return (
      /\bno[\s_-]*words\b/i.test(hay) ||
      /NO_WORDS/i.test(code) ||
      /没有识别到语音|未检测到语音|no speech/i.test(hay)
    );
  }

  if (!res.ok) {
    const { code, message } = pickError(json);
    const msg = message || `HTTP ${res.status}`;
    if (isNoSpeech(code, msg)) {
      throw new Error("没有识别到语音，请靠近麦克风再说一次");
    }
    throw new Error(`千问识别失败: ${code ? `[${code}] ` : ""}${msg}`);
  }

  const text = pickText(json);
  if (text.trim()) {
    return text.trim();
  }
  const { code, message } = pickError(json);
  if (isNoSpeech(code, message)) {
    throw new Error("没有识别到语音，请靠近麦克风再说一次");
  }
  const shown = message || (code ? `[${code}]` : `HTTP ${res.status}`) || "响应无识别文本";
  throw new Error(`千问识别失败: ${code ? `[${code}] ` : ""}${shown}`);
}

const MIMO_ASR_ENDPOINT_PAYG = "https://api.xiaomimimo.com/v1/chat/completions";

/** 小米 MiMo 语音识别（mimo-v2.5-asr）：OpenAI Chat Completions 兼容接口。 */
export async function transcribeMimo(
  wav: Buffer,
  creds: Record<string, string>,
  fallbackKey: string
): Promise<string> {
  const isTokenPlan = (creds.endpoint || "").includes("token-plan");
  const apiKey = (creds.apiKey || "").trim() || fallbackKey;
  if (!apiKey) {
    throw new Error(
      isTokenPlan
        ? "小米 MiMo 套餐语音配置不完整（API Key 未填，且模型配置里也没有套餐 Key）"
        : "小米 MiMo 语音配置不完整（API Key 未填，且模型配置里也没有按量 Key）"
    );
  }

  const endpoint = (creds.endpoint || "").trim() || MIMO_ASR_ENDPOINT_PAYG;
  const dataUri = `data:audio/wav;base64,${wav.toString("base64")}`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mimo-v2.5-asr",
      messages: [
        {
          role: "user",
          content: [{ type: "input_audio", input_audio: { data: dataUri } }],
        },
      ],
      asr_options: { language: "auto" },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MiMo 识别失败 (HTTP ${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("MiMo 未识别到语音");
  return text;
}

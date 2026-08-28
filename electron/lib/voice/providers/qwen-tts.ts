import fs from "fs";
import { getAuthPath } from "../../config";

// 从模型认证配置（auth.json）读取千问 API Key 作为兜底凭证。
// isTokenPlan=true 时读 qwen-tokenplan 段（套餐专用 key），否则读 qwen 段（按量）。
function loadQwenKeyFromAuth(isTokenPlan: boolean): string {
  try {
    const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
    if (isTokenPlan) {
      const key = auth?.["qwen-tokenplan"]?.key || auth?.["qwen-tokenplan"]?.apiKey;
      return typeof key === "string" ? key.trim() : "";
    }
    const key = auth?.qwen?.key || auth?.qwen?.apiKey;
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

// 千问语音合成（qwen3-tts-flash / CosyVoice，DashScope 原生接口，非 OpenAI 兼容）：
//   POST {endpoint}/api/v1/services/audio/tts/SpeechSynthesizer
//   body: { model:"qwen3-tts-flash", input:{ text, voice, format:"mp3", sample_rate:24000 } }
// 非流式响应 output.audio = 音频 URL（24h 有效）→ 再 GET 下载得到音频 Buffer。
// 计费通道（与聊天 LLM 一致）：
//   - 按量付费端点：https://dashscope.aliyuncs.com/api/v1（auth["qwen"]，sk- 开头）
//   - token-plan 套餐端点：https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1（auth["qwen-tokenplan"]）
const QWEN_TTS_ENDPOINT_PAYG = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
const QWEN_TTS_ENDPOINT_TOKENPLAN =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";

// 千问 TTS 模型与音色（qwen3-tts-flash，中文音色）
export const QWEN_TTS_MODEL = "qwen3-tts-flash";
export const QWEN_TTS_VOICES = ["Cherry", "Ethan", "Kunye"];

export async function synthesizeQwenTts(
  text: string,
  voice: string,
  isTokenPlan: boolean,
  creds: Record<string, string> = {}
): Promise<Buffer> {
  // 优先级：语音配置里填的 apiKey > 模型配置（auth.json）同名段 key
  const apiKey = (creds.apiKey || "").trim() || loadQwenKeyFromAuth(isTokenPlan);
  if (!apiKey) {
    throw new Error(
      isTokenPlan
        ? "千问套餐语音合成不可用（未填 Key，且模型配置里也没有千问套餐 Key）"
        : "千问语音合成不可用（未填 Key，且模型配置里也没有千问按量 Key）"
    );
  }
  const endpoint = isTokenPlan ? QWEN_TTS_ENDPOINT_TOKENPLAN : QWEN_TTS_ENDPOINT_PAYG;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: QWEN_TTS_MODEL,
      input: { text, voice, format: "mp3", sample_rate: 24000 },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`千问语音合成失败 (HTTP ${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as { output?: { audio?: string; audio_url?: string } };
  const audioUrl = data?.output?.audio || data?.output?.audio_url;
  if (!audioUrl) throw new Error("千问语音合成响应缺少音频 URL");
  // 下载音频文件（非流式返回的 URL 有效期 24h）
  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`千问音频下载失败 (HTTP ${audioRes.status})`);
  return Buffer.from(await audioRes.arrayBuffer());
}

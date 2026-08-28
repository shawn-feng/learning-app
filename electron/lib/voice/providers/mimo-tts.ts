import fs from "fs";
import { getAuthPath } from "../../config";

// 从模型认证配置（auth.json）读取小米 MiMo API Key 作为兜底凭证。
// isTokenPlan=true 时读 mimo-tokenplan 段（套餐专用 key，tp- 开头），否则读 mimo 段（sk- 开头）。
function loadMimoKeyFromAuth(isTokenPlan: boolean): string {
  try {
    const auth = JSON.parse(fs.readFileSync(getAuthPath(), "utf-8"));
    if (isTokenPlan) {
      const key = auth?.["mimo-tokenplan"]?.key || auth?.["mimo-tokenplan"]?.apiKey;
      return typeof key === "string" ? key.trim() : "";
    }
    const key = auth?.mimo?.key || auth?.mimo?.apiKey;
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

// 小米 MiMo 语音合成（mimo-v2.5-tts）：OpenAI Chat Completions 兼容接口。
//   POST {endpoint}/chat/completions
//   body: { model:"mimo-v2.5-tts",
//           messages:[{ role:"assistant", content: text }],   // 要合成的文本放 assistant 消息
//           audio:{ format:"mp3", voice } }                    // 音色（mimo_default/冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean）
// 音频在响应 choices[0].message.audio.data（base64）。
// 计费通道（与聊天 LLM 一致）：
//   - 按量付费端点：https://api.xiaomimimo.com/v1（auth["mimo"]，sk- 开头）
//   - token-plan 套餐端点：https://token-plan-cn.xiaomimimo.com/v1（auth["mimo-tokenplan"]，tp- 开头）
const MIMO_TTS_ENDPOINT_PAYG = "https://api.xiaomimimo.com/v1/chat/completions";
const MIMO_TTS_ENDPOINT_TOKENPLAN = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";

export const MIMO_TTS_MODEL = "mimo-v2.5-tts";
// 预置音色（mimo-v2.5-tts）：中文 mimo_default(冰糖)/茉莉/苏打/白桦，英文 Mia/Chloe/Milo/Dean
export const MIMO_TTS_VOICES = [
  "mimo_default",
  "冰糖",
  "茉莉",
  "苏打",
  "白桦",
  "Mia",
  "Chloe",
  "Milo",
  "Dean",
];

export async function synthesizeMimoTts(
  text: string,
  voice: string,
  isTokenPlan: boolean,
  creds: Record<string, string> = {}
): Promise<Buffer> {
  // 优先级：语音配置里填的 apiKey > 模型配置（auth.json）同名段 key
  const apiKey = (creds.apiKey || "").trim() || loadMimoKeyFromAuth(isTokenPlan);
  if (!apiKey) {
    throw new Error(
      isTokenPlan
        ? "小米 MiMo 套餐语音合成不可用（未填 Key，且模型配置里也没有 MiMo 套餐 Key）"
        : "小米 MiMo 语音合成不可用（未填 Key，且模型配置里也没有 MiMo 按量 Key）"
    );
  }
  const endpoint = isTokenPlan ? MIMO_TTS_ENDPOINT_TOKENPLAN : MIMO_TTS_ENDPOINT_PAYG;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MIMO_TTS_MODEL,
      messages: [{ role: "assistant", content: text }],
      audio: { format: "mp3", voice },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`MiMo 语音合成失败 (HTTP ${res.status})：${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { audio?: { data?: string } } }>;
  };
  const audioB64 = data?.choices?.[0]?.message?.audio?.data;
  if (!audioB64) throw new Error("MiMo 语音合成响应缺少音频数据");
  return Buffer.from(audioB64, "base64");
}

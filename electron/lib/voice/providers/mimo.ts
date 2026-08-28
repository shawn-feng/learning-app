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

// 小米 MiMo 语音识别（mimo-v2.5-asr）：OpenAI Chat Completions 兼容接口。
//   POST {endpoint}/chat/completions
//   body: { model:"mimo-v2.5-asr", messages:[{ role:"user", content:[{ type:"input_audio",
//          input_audio:{ data:"data:audio/wav;base64,..." } }] }], asr_options:{ language:"auto" } }
// 识别文本在响应 choices[0].message.content。支持 wav / mp3（≤10MB base64）。
// 计费通道（与聊天 LLM 一致）：
//   - 按量付费端点：https://api.xiaomimimo.com/v1（auth["mimo"]，sk- 开头）
//   - token-plan 套餐端点：https://token-plan-cn.xiaomimimo.com/v1（auth["mimo-tokenplan"]，tp- 开头）
// creds.endpoint 缺省时回退按量端点；token-plan 语音配置在 voice-config 里填 endpoint 即可切到套餐通道。
const MIMO_ASR_ENDPOINT_PAYG = "https://api.xiaomimimo.com/v1/chat/completions";
const MIMO_ASR_ENDPOINT_TOKENPLAN = "https://token-plan-cn.xiaomimimo.com/v1/chat/completions";

export async function transcribe(wav: Buffer, creds: Record<string, string>): Promise<string> {
  // 根据 endpoint 判断是否为 token-plan 通道：套餐端点域名含 "token-plan"，
  // 与按量付费（api.xiaomimimo.com）是两套独立 API Key，必须读各自 auth 段。
  const isTokenPlan = (creds.endpoint || "").includes("token-plan");
  const apiKey = (creds.apiKey || "").trim() || loadMimoKeyFromAuth(isTokenPlan);
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

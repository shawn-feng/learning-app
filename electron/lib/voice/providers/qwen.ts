import fs from "fs";
import { getAuthPath } from "../../config";

// 从模型认证配置（auth.json）读取千问 API Key 作为兜底凭证
// isTokenPlan=true 时读 qwen-tokenplan 段（token-plan 套餐专用 key，与按量不同），否则读 qwen 段。
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

// 千问（阿里云百炼）语音识别：qwen-audio-3.0-asr-flash
// 走 DashScope 原生接口（非 OpenAI 兼容）：
//   POST {endpoint}/api/v1/services/aigc/multimodal-generation/generation
//   body: { model, input: { messages: [{ role:"user", content:[{ type:"input_audio",
//          input_audio: { data: "data:audio/wav;base64,..." } }] }] },
//          parameters: { format: "wav", sample_rate: "16000" } }
// 注意：OpenAI 兼容接口（/compatible-mode/v1/chat/completions）对 qwen-audio-3.0-asr-flash
// 不识别 data URI 的 MIME，必须显式 parameters.format，因此用原生接口。
// 识别文本在响应 output.output.sentence.text。
//
// 计费通道（与聊天 LLM 一致）：
//   - 按量付费端点：https://dashscope.aliyuncs.com/api/v1/...
//   - token-plan 套餐端点：https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/...
// creds.endpoint 缺省时回退按量端点；token-plan 语音配置在 voice-config 里填 endpoint 即可切到套餐通道。
const QWEN_ASR_ENDPOINT_PAYG = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const QWEN_ASR_ENDPOINT_TOKENPLAN =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";

export async function transcribe(wav: Buffer, creds: Record<string, string>): Promise<string> {
  // 根据 endpoint 判断是否为 token-plan 通道：token-plan 套餐端点域名含 "token-plan"，
  // 与按量付费（dashscope）是两套独立 API Key，必须读各自 auth 段。
  const isTokenPlan = (creds.endpoint || "").includes("token-plan");
  const apiKey = (creds.apiKey || "").trim() || loadQwenKeyFromAuth(isTokenPlan);
  if (!apiKey) {
    throw new Error(
      isTokenPlan
        ? "千问 token-plan 语音配置不完整（API Key 未填，且模型配置里也没有 token-plan Key）"
        : "千问语音配置不完整（API Key 未填，且模型配置里也没有千问按量 Key）"
    );
  }

  const endpoint = (creds.endpoint || "").trim() || QWEN_ASR_ENDPOINT_PAYG;
  const dataUri = `data:audio/wav;base64,${wav.toString("base64")}`;
  const res = await fetch(
    endpoint,
    {
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
    }
  );

  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = json?.code || "";
    const message = json?.message || `HTTP ${res.status}`;
    // 没有识别到语音内容（静音/太轻）：语义错误，不应回退到其他服务
    if (code === "CLIENT_ERROR" && /NO_WORDS/i.test(message)) {
      throw new Error("没有识别到语音，请靠近麦克风再说一次");
    }
    throw new Error(`千问识别失败: ${message}`);
  }
  const text: unknown = json?.output?.output?.sentence?.text;
  if (typeof text === "string" && text.trim()) {
    return text.trim();
  }
  throw new Error("千问识别失败: 未返回识别文本");
}

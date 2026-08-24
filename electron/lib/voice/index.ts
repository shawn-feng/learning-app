import { loadVoiceConfig, getTranscribeCandidates, type VoiceProviderId } from "./voice-config";
import { webmToWav16k } from "./audio";
import { transcribe as aliyunTranscribe } from "./providers/aliyun";
import { transcribe as tencentTranscribe } from "./providers/tencent";
import { transcribe as qwenTranscribe } from "./providers/qwen";

const PROVIDER_NAMES: Record<string, string> = {
  aliyun: "阿里云",
  tencent: "腾讯云",
  qwen: "千问(按量)",
  "qwen-tokenplan": "千问(token-plan)",
  iflytek: "讯飞",
  baidu: "百度",
};

function dispatch(id: VoiceProviderId, wav: Buffer, creds: Record<string, string>): Promise<string> {
  switch (id) {
    case "aliyun":
      return aliyunTranscribe(wav, creds);
    case "tencent":
      return tencentTranscribe(wav, creds);
    case "qwen":
    case "qwen-tokenplan":
      // 两个千问语音通道复用同一 transcribe 实现；token-plan 的 endpoint 已在 creds 中
      // （DEFAULT_CONFIG 已预填 token-plan ASR 端点，按量通道未填则回退 dashscope 域名）。
      return qwenTranscribe(wav, creds);
    default:
      return Promise.reject(new Error(`供应商 ${id} 尚未实现`));
  }
}

// 语音识别统一入口：webm 音频 → 16k wav → 按默认服务（优先）+ 其余已配置服务逐个尝试 → 文本
// onlyProvider 传了则只测试该服务（用于设置页验证凭证），不做 fallback。
export async function transcribeAudio(webmBuffer: Buffer, onlyProvider?: string): Promise<string> {
  const cfg = loadVoiceConfig();
  if (!cfg.enabled) throw new Error("语音输入未启用，请先在设置中开启");

  const wav = await webmToWav16k(webmBuffer);

  let candidates = getTranscribeCandidates(cfg);
  if (onlyProvider) {
    const id = onlyProvider as VoiceProviderId;
    candidates = cfg.providers[id] ? [{ id, creds: cfg.providers[id] }] : [];
  }
  if (candidates.length === 0) {
    throw new Error(
      onlyProvider
        ? "该语音服务尚未配置凭证，请先填写并保存"
        : "未配置可用的语音服务，请先在设置中填写凭证"
    );
  }

  const errors: string[] = [];
  for (const { id, creds } of candidates) {
    try {
      const text = await dispatch(id, wav, creds);
      if (candidates.length > 1) {
        console.log(`[voice] 使用 ${id} 识别成功（默认=${cfg.provider}）`);
      }
      return text;
    } catch (e) {
      const msg = (e as Error).message;
      // 语义错误（如「没有识别到语音」）：不是服务不可用，不应回退，直接上报
      if (/没有识别到语音/.test(msg)) {
        throw e;
      }
      errors.push(`${PROVIDER_NAMES[id] || id}: ${msg}`);
      console.error(`[voice] ${id} 识别失败，尝试下一个:`, msg);
    }
  }
  throw new Error(`所有语音服务均识别失败：\n${errors.join("\n")}`);
}

export { loadVoiceConfig, saveVoiceConfig, getMaskedConfig, applyVoiceConfigPatch, getTranscribeCandidates, isProviderConfigured } from "./voice-config";
export { synthesize } from "./tts";

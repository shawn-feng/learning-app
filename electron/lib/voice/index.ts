import { loadVoiceConfig } from "./voice-config";
import { webmToWav16k } from "./audio";
import { transcribe as aliyunTranscribe } from "./providers/aliyun";
import { transcribe as tencentTranscribe } from "./providers/tencent";

// 语音识别统一入口：webm 音频 → 16k wav → 按 provider 分发 → 文本
export async function transcribeAudio(webmBuffer: Buffer): Promise<string> {
  const cfg = loadVoiceConfig();
  if (!cfg.enabled) throw new Error("语音输入未启用，请先在设置中开启");

  const creds = cfg.providers[cfg.provider];
  if (!creds) throw new Error(`未知供应商: ${cfg.provider}`);

  const wav = await webmToWav16k(webmBuffer);

  switch (cfg.provider) {
    case "aliyun":
      return aliyunTranscribe(wav, creds);
    case "tencent":
      return tencentTranscribe(wav, creds);
    default:
      throw new Error(`供应商 ${cfg.provider} 尚未实现`);
  }
}

export { loadVoiceConfig, saveVoiceConfig, getMaskedConfig, applyVoiceConfigPatch } from "./voice-config";
export { synthesize } from "./tts";

// ASR（语音识别）配置与转录已上收服务端（ISSUE-165）：配置读 /asr/config、转录走
// /asr/transcribe（本机只做 webm→wav 转码），见 ipc-handlers.ts voice:* 三个 handler
// 与 ./voice-config（旧本机 voice-config.json 一次性导入）。本文件只剩 TTS。
export { loadTtsConfig, saveTtsConfig, getMaskedTtsConfig, applyTtsConfigPatch, TTS_PROVIDER_ORDER } from "./tts-config";
export { synthesize, prewarmTexts, TTS_VOICES } from "./tts";

/// <reference types="vite/client" />

// Web 版环境类型：
// - window.api 由 ../shim/install.ts 在 React 挂载前安装（与 electron/preload.ts 同签名面）。
// - lib.dom 不含 Web Speech API 的主接口（仅有 SpeechRecognitionEvent 等事件类型），
//   这里给出 SpeechRecognition / webkitSpeechRecognition 的最小构造器桩（Phase 5 语音域使用）。
declare global {
  interface Window {
    api: any;
    /** Chrome/Edge 的 Web Speech API（可能不存在，使用前判空） */
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}

/** SpeechRecognition 构造器最小桩：实例成员在 Phase 5 voice/stt.ts 中按需细化。 */
interface SpeechRecognitionCtor {
  new (): any;
}

export {};

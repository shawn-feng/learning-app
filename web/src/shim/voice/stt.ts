/**
 * voice/stt.ts（Phase 5）：浏览器语音识别（SpeechRecognition）听写会话。
 *
 * 方案（设计方案 §2 #7 的最小一致实现）：浏览器无法转写「传入的音频 buffer」
 * （无云端 ASR 凭证通道，WebAudio 拿不到云端识别），因此识别走 SpeechRecognition
 * 独立监听麦克风，与 useAudioRecorder 的 MediaRecorder 录音**并行**：
 *   - 录音 blob（webm/opus）仍由 MediaRecorder 产出 → 播放/上传/合并链路与 Electron 一致；
 *   - 听写会话由 useAudioRecorder 的 web 分支在 start/stop 时并行驱动
 *     （window.api.voiceDictationStart / voiceDictationStop）；
 *   - window.api.voiceTranscribe(audio) 返回最近一次会话的识别文本 + 传入音频的
 *     base64（对齐 ipc voice:transcribe 的 {success, text, audio} 形状）。
 *
 * 一次性消费：识别结果被 voiceTranscribe 取走即清账，避免旧文本串扰后续无关调用
 * （如考核 iframe 的 exam:asr 直接调 voiceTranscribe——无并行听写时返回空文本，
 * 走渲染层现有容错）。另设 60s 新鲜度窗：更早的残留结果视为串扰，不返回。
 */

/** 结果账本：stopDictation 落账，consumeDictationResult 一次性消费。 */
interface DictationResult {
  text: string;
  error: string;
  at: number;
}

/** 结果新鲜度窗（毫秒）：超过视为陈旧串扰，不返回。 */
const RESULT_FRESH_MS = 60000;
/** stop 后等 onend 送达最后一批 final 结果的兜底上限（毫秒）。 */
const STOP_WAIT_MS = 1000;

interface DictationSession {
  rec: any;
  active: boolean;
  finalText: string;
  error: string;
  restartTimer: ReturnType<typeof setTimeout> | null;
  stopWaiters: Array<() => void>;
}

let session: DictationSession | null = null;
let lastResult: DictationResult | null = null;

/** 环境探测：Chrome/Edge 的 SpeechRecognition（带 webkit 前缀）。 */
export function isSttSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window.SpeechRecognition || (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)
  );
}

function getCtor(): any {
  const w = window as unknown as { SpeechRecognition?: any; webkitSpeechRecognition?: any };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
}

function settleStop(s: DictationSession): void {
  for (const w of s.stopWaiters.splice(0, s.stopWaiters.length)) w();
}

/**
 * 开始一次听写会话（continuous + interim，zh-CN）。
 * - 已有活跃会话：幂等返回（按住说话期间不会重复起）；
 * - 浏览器不支持：throw 明确错误（调用方 catch 降级为只录不识别，不崩）；
 * - 麦克风被拒：会话以 error 收尾（voiceTranscribe 返回 {success:false, error}）。
 */
export async function startDictation(): Promise<void> {
  if (!isSttSupported()) {
    throw new Error("当前浏览器不支持语音识别（需 Chrome/Edge），语音输入不可用");
  }
  if (session?.active) return;

  const Ctor = getCtor();
  const rec = new Ctor();
  rec.lang = "zh-CN";
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;

  const s: DictationSession = {
    rec,
    active: true,
    finalText: "",
    error: "",
    restartTimer: null,
    stopWaiters: [],
  };
  session = s;

  rec.onresult = (ev: any) => {
    // 只累计 final 结果（interim 仅用于引擎侧缓冲，最终文本以 isFinal 为准）
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res?.isFinal) {
        const piece = String(res[0]?.transcript || "").trim();
        if (piece) s.finalText += piece;
      }
    }
  };
  rec.onerror = (ev: any) => {
    const err = String(ev?.error || "");
    // 致命错误：会话收尾并记因（not-allowed=麦克风权限；audio-capture=无麦克风）
    if (err === "not-allowed" || err === "service-not-allowed") {
      s.error = "麦克风权限被拒绝，请在浏览器地址栏允许麦克风后重试";
      s.active = false;
      settleStop(s);
    } else if (err === "audio-capture") {
      s.error = "未检测到可用麦克风设备";
      s.active = false;
      settleStop(s);
    }
    // no-speech / aborted / network 等非致命：保持会话，交 onend 自动重启
  };
  rec.onend = () => {
    if (s.active) {
      // Chrome 静音数秒后自动停：active 期间自动重启保持连续监听
      if (s.restartTimer) clearTimeout(s.restartTimer);
      s.restartTimer = setTimeout(() => {
        if (!s.active) return;
        try {
          s.rec.start();
        } catch {
          /* 已在启动中的 InvalidStateError 竞态：忽略，等下一次 onend */
        }
      }, 250);
    } else {
      settleStop(s);
    }
  };

  try {
    rec.start();
  } catch (e) {
    session = null;
    throw new Error("语音识别启动失败：" + ((e as Error).message || "未知错误"));
  }
}

/**
 * 结束当前听写会话，返回 {text, error} 并落账（供 voiceTranscribe 消费）。
 * - 无活跃会话：返回空文本（不动账本——避免把更早的残留结果误配给本次录音）；
 * - stop 后等 onend 送达最后一批 final 结果（最多 STOP_WAIT_MS，防挂起）。
 */
export async function stopDictation(): Promise<{ text: string; error: string }> {
  const s = session;
  if (!s || !s.active) {
    session = null;
    return { text: "", error: "" };
  }
  s.active = false;
  if (s.restartTimer) {
    clearTimeout(s.restartTimer);
    s.restartTimer = null;
  }
  try {
    s.rec.stop();
  } catch {
    try {
      s.rec.abort();
    } catch {
      /* ignore */
    }
  }
  await new Promise<void>((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(fin, STOP_WAIT_MS);
    s.stopWaiters.push(fin);
  });
  const text = s.finalText.trim();
  const error = s.error;
  lastResult = { text, error, at: Date.now() };
  if (session === s) session = null;
  return { text, error };
}

/**
 * 一次性消费最近一次会话结果（voiceTranscribe 专用）：
 * - 取走即清账，杜绝旧文本串扰下一次无关调用；
 * - 60s 新鲜度窗外的残留视为串扰，返回空。
 */
export function consumeDictationResult(): { text: string; error: string } {
  const r = lastResult;
  lastResult = null;
  if (!r) return { text: "", error: "" };
  if (Date.now() - r.at > RESULT_FRESH_MS) return { text: "", error: "" };
  return { text: r.text, error: r.error };
}

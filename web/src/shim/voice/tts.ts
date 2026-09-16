/**
 * voice/tts.ts（Phase 5）：浏览器 speechSynthesis 封装。
 *
 * 两种播报模式，语义对齐 MaterialsPanel.speakMaterialText 的 Electron 实现
 * （ISSUE-011/ISSUE-2026-09-08，见 src/lib/page-bridge.ts 的 tts 上抛链路）：
 *   - 打断模式（mode="interrupt"，默认）：资料朗读/点读/查词等单条意图——新请求
 *     取消当前播报并清空队列（epoch 失效全部在途请求），立即播新条；
 *   - FIFO 队列模式（mode="queue"）：场景多角色连读——请求入队顺序播，播完一条
 *     再取下一条，互不覆盖。
 *
 * Promise 语义：resolve(true)=播到终点；resolve(false)=被打断/取消/出错/环境不支持。
 * 永不 reject（调用点均为 fire-and-forget 或「resolve 即收尾」，无 throw 路径）。
 *
 * 音色/语速：rate 为 edge-tts 风格百分号串（"+0%"/"-50%"…，ChatWindow 档位），
 * 换算 speechSynthesis.rate；voice 优先取调用传入，缺省读 models.ts 同一存储
 * （localStorage "web.ttsConfig"，家长设置的 edge-tts 音色）并尽力映射到本机引擎音色。
 */

export type SpeakMode = "interrupt" | "queue";

export interface SpeakOptions {
  /** edge-tts 风格语速（"+0%"/"-50%"/"+30%"…）；缺省 1.0x */
  rate?: string;
  /** 音色（edge-tts voiceId 或引擎音色名/语言码）；缺省用 web.ttsConfig 配置，再缺省交引擎按语言自动选 */
  voice?: string;
  /** 播报模式：interrupt（默认，新取代旧）| queue（FIFO 排队） */
  mode?: SpeakMode;
}

interface QueuedSpeak {
  text: string;
  opts: SpeakOptions;
  /** 入队时的 epoch：打断后过期条目直接失效（resolve(false)，不开口） */
  epoch: number;
  resolve: (playedToEnd: boolean) => void;
}

// ---------------------------------------------------------------------------
// 环境探测（Node/无 speechSynthesis 环境优雅降级：resolve(false)，不 throw）
// ---------------------------------------------------------------------------

export function isSpeechSynthesisSupported(): boolean {
  return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined";
}

// ---------------------------------------------------------------------------
// 音色解析
// ---------------------------------------------------------------------------

/** edge-tts 风格语速（"+30%"/"-50%"）→ speechSynthesis.rate（0.1~10，钳制）。 */
function parseRate(rate?: string): number | undefined {
  if (!rate) return undefined;
  const m = /([+-]?\d+(?:\.\d+)?)\s*%/.exec(String(rate));
  if (!m) return undefined;
  const pct = parseFloat(m[1]);
  if (isNaN(pct)) return undefined;
  const r = 1 + pct / 100;
  return Math.min(10, Math.max(0.1, r));
}

/** 读取家长设置的 TTS 音色（与 models.ts 共用 localStorage "web.ttsConfig" 存储，只读）。 */
function getConfiguredVoiceId(): string {
  try {
    const raw = localStorage.getItem("web.ttsConfig");
    if (!raw) return "";
    const cfg = JSON.parse(raw) as { provider?: string; providers?: Record<string, { voice?: string }> };
    const providers = cfg?.providers || {};
    const byProvider =
      (cfg.provider && providers[cfg.provider]?.voice) || providers["edge-tts"]?.voice || "";
    // qwen/mimo 等 HTTP TTS 音色浏览器引擎无法对应，仅 edge-tts 的 voiceId 有映射意义
    return byProvider;
  } catch {
    return "";
  }
}

let voicesCache: SpeechSynthesisVoice[] | null = null;

function getVoices(): SpeechSynthesisVoice[] {
  if (!isSpeechSynthesisSupported()) return [];
  if (!voicesCache || voicesCache.length === 0) {
    voicesCache = window.speechSynthesis.getVoices() || [];
    // 引擎音色清单异步就绪：首次为空时挂一次性监听刷新
    if (!voicesCache.length) {
      window.speechSynthesis.addEventListener(
        "voiceschanged",
        () => {
          voicesCache = window.speechSynthesis.getVoices() || [];
        },
        { once: true }
      );
    }
  }
  return voicesCache;
}

/** 把配置的音色（edge-tts voiceId 等）尽力映射到本机引擎音色；映射不上交引擎默认。 */
function resolveVoice(voiceId: string): SpeechSynthesisVoice | undefined {
  const voices = getVoices();
  const want = String(voiceId || "").trim();
  if (!voices.length || !want) return undefined;
  const lower = want.toLowerCase();
  // 1) 名称/voiceURI 直接包含（如含 "xiaoxiaoneural" 或用户填了本机音色名）
  let hit = voices.find(
    (v) => v.name.toLowerCase().includes(lower) || String(v.voiceURI || "").toLowerCase().includes(lower)
  );
  // 2) 尾段人名（zh-CN-XiaoxiaoNeural → "xiaoxiao"）
  if (!hit) {
    const tail = want.split("-").pop()!.replace(/neural$/i, "").toLowerCase();
    if (tail && tail !== want.toLowerCase()) {
      hit = voices.find((v) => v.name.toLowerCase().includes(tail));
    }
  }
  // 3) 语言前缀（zh-CN / zh-HK / en-US…）→ 引擎同语言首个音色
  if (!hit) {
    const lang = want.split("-").slice(0, 2).join("-").toLowerCase();
    if (lang) hit = voices.find((v) => v.lang.toLowerCase().replace("_", "-") === lang);
  }
  return hit || undefined;
}

// ---------------------------------------------------------------------------
// 播报状态机（打断 epoch + FIFO 队列）
// ---------------------------------------------------------------------------

const queue: QueuedSpeak[] = [];
let current: QueuedSpeak | null = null;
/** 打断纪元：每次打断/取消 +1，使排队中的过期请求失效 */
let epoch = 0;
/** Chrome 长文本 ~15s 自动暂停的保活句柄（仅播报期间运行） */
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;

function startKeepalive(): void {
  if (keepaliveTimer !== null || typeof window === "undefined") return;
  keepaliveTimer = setInterval(() => {
    if (!current) {
      if (keepaliveTimer !== null) {
        clearInterval(keepaliveTimer);
        keepaliveTimer = null;
      }
      return;
    }
    // Chrome 桌面端长文本播报约 15 秒会自动 pause：仍在播报则 resume 续上
    if (window.speechSynthesis.speaking) window.speechSynthesis.resume();
  }, 10000);
}

function finish(item: QueuedSpeak, playedToEnd: boolean): void {
  if (current === item) {
    current = null;
  }
  item.resolve(playedToEnd);
  // 微任务后接续队列（让 onend 同步清理先生效）
  setTimeout(pump, 0);
}

function pump(): void {
  if (current || !isSpeechSynthesisSupported()) return;
  const next = queue.shift();
  if (!next) return;
  if (next.epoch !== epoch) {
    next.resolve(false); // 过期（已被打断）：不开口直接失效
    pump();
    return;
  }
  speakOne(next);
}

function speakOne(item: QueuedSpeak): void {
  const syn = window.speechSynthesis;
  current = item;
  const u = new SpeechSynthesisUtterance(item.text);
  const rate = parseRate(item.opts.rate);
  if (rate !== undefined) u.rate = rate;
  const voiceId = item.opts.voice || getConfiguredVoiceId();
  const voice = resolveVoice(voiceId);
  if (voice) {
    u.voice = voice;
    u.lang = voice.lang;
  } else if (voiceId) {
    // 引擎清单里没有可映射音色：至少把语言前缀交给引擎（按语言挑默认音色）
    const lang = voiceId.split("-").slice(0, 2).join("-");
    if (/^[a-z]{2}(-[A-Za-z]{2})?$/.test(lang)) u.lang = lang;
  }

  let settled = false;
  u.onend = () => {
    if (!settled) {
      settled = true;
      finish(item, true);
    }
  };
  u.onerror = () => {
    if (!settled) {
      settled = true;
      finish(item, false);
    }
  };

  startKeepalive();
  // 引擎还占着声道（前一条刚 cancel 未落定）时，先 cancel 再稍候开口，
  // 避免 Chrome 同 tick cancel→speak 偶发吞音
  if (syn.speaking || syn.pending) {
    syn.cancel();
    setTimeout(() => {
      try {
        syn.speak(u);
      } catch {
        finish(item, false);
      }
    }, 60);
  } else {
    try {
      syn.speak(u);
    } catch {
      finish(item, false);
    }
  }
}

/**
 * 播报文本。resolve(true)=播到终点；resolve(false)=被打断/取消/出错/环境不支持。
 * - 打断模式（默认）：失效全部在途请求 + cancel 当前播报，立即播新条；
 * - 队列模式：FIFO 入队，前一条 finish 后由 pump 接续。
 */
export function speak(text: string, opts: SpeakOptions = {}): Promise<boolean> {
  const mode = opts.mode || "interrupt";
  if (!isSpeechSynthesisSupported()) {
    console.warn("[voice/tts] 当前环境无 speechSynthesis，跳过播报");
    return Promise.resolve(false);
  }
  const t = String(text ?? "").trim();
  if (!t) return Promise.resolve(false);

  if (mode === "interrupt") {
    epoch++;
    const stale = queue.splice(0, queue.length);
    for (const s of stale) s.resolve(false);
    if (current) {
      const c = current;
      current = null; // 先摘除：cancel 触发的 onend 不再重复走 finish
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* 引擎异常时按失效处理 */
      }
      c.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const item: QueuedSpeak = { text: t, opts, epoch, resolve };
      // 让 cancel 的状态清理先落定再开口（对齐 Electron 「新朗读打断旧播放」语义）
      setTimeout(() => speakOne(item), 60);
    });
  }

  // FIFO 队列模式：入队顺序播（快照当前 epoch——排队中各条互不失效，只有打断才 epoch++）
  return new Promise<boolean>((resolve) => {
    queue.push({ text: t, opts, epoch, resolve });
    setTimeout(pump, 0);
  });
}

/** 取消当前播报并清空队列（停止按钮 / tts-cancel / 面板卸载语义）。 */
export function cancelSpeak(): void {
  if (!isSpeechSynthesisSupported()) return;
  epoch++;
  const stale = queue.splice(0, queue.length);
  for (const s of stale) s.resolve(false);
  if (current) {
    const c = current;
    current = null;
    c.resolve(false);
  }
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

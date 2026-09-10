import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
import IconButton from "./IconButton";
import { ArrowLeft, PanelRightClose } from "lucide-react";
import { lookupText, type LookupEntry } from "../lib/dictionary";
import { WordLookupOverlay, type LookupState } from "./WordLookupOverlay";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import {
  EventThrottler,
  genRequestId,
  injectBridge,
  SCENE_PAGE_MARKER,
  type MaterialsPanelHandle,
  type PageAction,
  type PageEvent,
  type PageExecDownlink,
  type PageExecParams,
  type PageExecResultUplink,
} from "../lib/page-bridge";

export interface Material {
  id: string;
  format: "html";
  content: string;
  title?: string;
  time: string;
  /** 资料文件路径（相对学习目录），用于去重 */
  filePath?: string;
}

interface Props {
  materials: Material[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  /** iframe 内互动事件上报（节流后），Learn 层转发给主进程注入 agent */
  onPageEvent?: (evt: PageEvent) => void;
  /** ISSUE-008：折叠资料区（收起后聊天区占更多空间） */
  onCollapse?: () => void;
  /** ISSUE-030：资料字号（px）；驱动列表/正文/markdown 的 --material-font 与 HTML iframe 注入 */
  matFontSize?: number;
  /** ISSUE-061：场景页就绪（scene:ready）→ 通知 Learn 进入场景对话模式 */
  onSceneActive?: () => void;
  /** ISSUE-061：场景语音球录音结束 → (ASR 文本, 录音字节) 交 Learn 落 voice/scene 并发场景会话 */
  onSceneVoice?: (text: string, data: ArrayBuffer) => void;
  /** ISSUE-061：场景语音录入错误/失败提示（太短、没听清、ASR 未配置等）——必须让孩子看到，不静默 */
  onSceneMicNotice?: (msg: string) => void;
}

const EXEC_TIMEOUT_MS = 10000;
const THROTTLE_WINDOW_MS = 3000;
const SCROLL_WINDOW_MS = 800;

interface PendingExec {
  resolve: (r: PageExecResultUplink) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 同一交互序列（mouseup 选中 → 随后 click）内 click 不应关闭浮层的时间窗 */
const LOOKUP_CLICK_GRACE_MS = 400;

/** 简单字符串 hash（用于 iframe key：内容变化即重建，含同长度不同内容的重发场景） */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return String(h);
}

/**
 * HTML 内容通过沙盒 iframe 渲染。
 * sandbox="allow-scripts" 让 JS 可以运行（番茄钟、点击交互等），
 * 但不带 allow-same-origin，iframe 处于不透明源，脚本无法读取父页面 DOM / cookie，
 * 保证 AI 生成的内容被隔离在安全边界内。
 *
 * 加载通道二选一：
 * - docUrl（ISSUE-061 根治，2026-09-08）：共享 html 资料走 **真实 URL 顶层文档**（asset://...?doc=1，
 *   协议层已注入桥/SDK）。此前 dataURL/srcDoc 内嵌在 app 沙盒下实测正文 <script> 不执行，
 *   真实导航可让页面正文脚本随文档解析正常执行。加载期间显示进度 overlay。
 * - html（回退）：旧资料 / 无 filePath 的本地产物走 dataURL 内嵌 + 渲染层注入桥。
 */
function HtmlFrame({
  html,
  title,
  iframeRef,
  onLoad,
  refreshEpoch,
  docUrl,
  onDocError,
}: {
  html: string;
  title?: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
  refreshEpoch?: number;
  docUrl?: string;
  onDocError?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const urlMode = !!docUrl;
  // URL 源：docUrl/epoch 变化 → 进入加载态并复位错误态
  useEffect(() => {
    if (!urlMode) return;
    setLoading(true);
    setLoadFailed(false);
  }, [urlMode, docUrl, refreshEpoch]);
  // 超时兜底：10s 仍未 load 完成 → 停止 loading 指示（避免永久转圈），但保留重试语义
  useEffect(() => {
    if (!urlMode || !loading) return;
    const t = setTimeout(() => setLoading(false), 10000);
    return () => clearTimeout(t);
  }, [urlMode, loading]);
  // dataURL 回退：渲染层注入桥（历史行为，本地产物/无 filePath 资料）
  const dataSrc = urlMode ? "" : "data:text/html;charset=utf-8;base64," + btoaUnicode(html);
  const src = urlMode ? docUrl : dataSrc;
  const key =
    urlMode
      ? `doc:${docUrl}:${refreshEpoch || 0}`
      : `${html.length}:${hashStr(html)}:${refreshEpoch || 0}`;
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 320, display: "flex", flexDirection: "column" }}>
      <iframe
        key={key}
        ref={iframeRef}
        className="html-frame"
        sandbox="allow-scripts allow-modals allow-forms"
        src={src}
        title={title || "学习内容"}
        onLoad={() => {
          setLoading(false);
          setLoadFailed(false);
          onLoad?.();
        }}
        onError={() => {
          setLoading(false);
          setLoadFailed(true);
          onDocError?.();
        }}
      />
      {urlMode && loading && (
        <div className="html-frame-loading">
          <div className="hf-progress"><div className="hf-progress-bar" /></div>
          <div className="hf-progress-text">正在加载学习内容…</div>
        </div>
      )}
      {urlMode && loadFailed && (
        <div className="html-frame-error">
          内容加载失败，请让 AI 老师重新展示
        </div>
      )}
    </div>
  );
}

/** UTF-8 安全的 base64（btoa 只支持 Latin1，含中文/emoji 的资料必须先用 UTF-8 编码字节） */
function btoaUnicode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 判定资料是否可用「真实 URL 顶层文档」加载，并构造 asset:// 文档 URL。
 * 条件：filePath 存在、去掉 materials/ 前缀后形如 `topic/xxx/name.html`（服务端共享材料）。
 * 本地产物（outputs/ 开头）或无 filePath 的资料返回空串 → HtmlFrame 回退 dataURL 内嵌。
 * URL 语义：asset://local/parent/{parentId}/{topic}/{rest}?doc=1&font=N&v=epoch
 * parentId 仅作 URL 路径段占位（协议按 session token 定位家长，不校验段值）——用固定 "default"。
 */
function resolveSharedDocUrl(
  filePath: string | undefined,
  matFont: number | undefined,
  epoch: number
): string {
  if (!filePath) return "";
  const norm = String(filePath).replace(/\\/g, "/").replace(/^materials\//, "").trim();
  if (!norm || norm.startsWith("outputs/")) return "";
  if (!/^[^/]+\/.+\.(html|htm)$/i.test(norm)) return "";
  if (norm.includes("..") || norm.includes(":")) return "";
  const segments = norm.split("/").map((s) => encodeURIComponent(s));
  const font = typeof matFont === "number" && matFont >= 8 ? `&font=${matFont}` : "";
  return `asset://local/parent/default/${segments.join("/")}?doc=1${font}&v=${epoch}`;
}

/**
 * 学习资料面板：列表 + 详情两态。
 * - 列表：每一行是一次学习资料（当前会话里 AI 展示过的全部资料）
 * - 详情：点开后展示该份资料，可「返回列表」
 */
/** ISSUE-061：场景页就绪清单 → 给 agent 的中文摘要（物品属性/角色，一次注入，agent 据此问答与驱动） */
function sceneReadyText(manifest: unknown): string {
  const m = (manifest ?? {}) as {
    title?: string; props?: Array<Record<string, any>>; characters?: Array<Record<string, any>>;
  };
  const p = (m.props ?? []).map((x) => {
    let s = x.word || x.id || "";
    if (x.zh) s += ` ${x.zh}`;
    if (x.phon) s += ` ${x.phon}`;
    const av = Object.entries((x.attrs as Record<string, unknown>) || {})
      .map(([k, v]) => `${k}=${v}`).join(" ");
    if (av) s += `（${av}）`;
    return s;
  });
  const c = (m.characters ?? []).map((x) => {
    let s = `${x.id}(${x.name || x.id}`;
    if (x.zh) s += ` ${x.zh}`;
    if (x.persona) s += `，${x.persona}`;
    return s + ")";
  });
  if (!p.length && !c.length) return "";
  const title = m.title ? `${m.title}，` : "场景";
  return `${title}已就绪。可点物品（点击会发单词音并上报）：${p.join("、")}。场景角色：${c.join("、")}。`;
}

const MaterialsPanel = forwardRef<MaterialsPanelHandle, Props>(function MaterialsPanel(
  { materials, selectedId, onOpen, onBack, onPageEvent, onCollapse, matFontSize = 16, onSceneActive, onSceneVoice, onSceneMicNotice },
  ref
) {
  const selected = materials.find((m) => m.id === selectedId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  // MATERIAL 保鲜/display_content 同 path 重发等场景下，React/Chromium 更新 srcDoc 属性不保证
  // 触发 iframe 重载；用 epoch 在内容（selected.content）实质变化时 +1，配合 HtmlFrame key 强重建。
  const [htmlEpoch, setHtmlEpoch] = useState(0);
  const activeHtml = selected && selected.format === "html" ? (selected.content ?? "") : "";
  useEffect(() => {
    if (activeHtml) setHtmlEpoch((e) => e + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHtml]);
  const pendingRef = useRef(new Map<string, PendingExec>());
  const throttlerRef = useRef(new EventThrottler());
  const onPageEventRef = useRef(onPageEvent);
  onPageEventRef.current = onPageEvent;
  // ISSUE-061：场景模式回调 ref（handler 在 useEffect 注册一次，闭包必须读最新 props）
  const onSceneActiveRef = useRef(onSceneActive);
  onSceneActiveRef.current = onSceneActive;
  const onSceneVoiceRef = useRef(onSceneVoice);
  onSceneVoiceRef.current = onSceneVoice;
  const onSceneMicNoticeRef = useRef(onSceneMicNotice);
  onSceneMicNoticeRef.current = onSceneMicNotice;
  // ISSUE-061：场景语音球录音（宿主侧 getUserMedia，iframe 沙箱内无法采集）
  const recorder = useAudioRecorder();
  const recorderApiRef = useRef(recorder);
  recorderApiRef.current = recorder;
  // 按住说话防抖标记：快速 press/release 时忽略（录音由 stop 判空兜底）
  const micHoldingRef = useRef(false);
  // ISSUE-011：资料朗读走 edge-tts（与聊天同链路）。audioRef=当前播放；seq 防乱序（新朗读取代旧回执）
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsSeqRef = useRef(0);
  // ISSUE-2026-09-08：场景多角色连续台词（agent 一轮多条 say → 页面逐条 tts.speak）不得互相覆盖。
  // queue 模式把请求串行：播完一条再取下一条；打断模式（资料朗读/点读/查词）维持「新取代旧」。
  const ttsQueueRef = useRef<{ text: string; seq: number }[]>([]);
  const ttsActiveRef = useRef(false);
  // ISSUE-017：查词浮层状态 + 最近 lookup 时间戳（click 关闭浮层时避开同交互序列）。
  // ⚠️ handler 在 useEffect 注册一次，闭包内 state 恒为初值 → 必须用 ref 同步读取（ISSUE-014 教训）
  const [lookup, setLookup] = useState<LookupState | null>(null);
  const lookupRef = useRef<LookupState | null>(null);
  const lastLookupAtRef = useRef(0);
  const showLookup = useCallback((s: LookupState | null) => {
    lookupRef.current = s;
    setLookup(s);
  }, []);
  const closeLookup = useCallback(() => showLookup(null), [showLookup]);

  // ISSUE-030：资料字号经 CSS 变量下传到列表/正文（作用域限定在孩子端 .content-panel，不波及家长端/聊天）
  const materialFontStyle = { "--material-font": `${matFontSize}px` } as CSSProperties;

  /** 资料/场景朗读（edge-tts）。
   * queue=true：排队模式（场景多角色连读逐句顺序播放，后一条等前一条播完，不互相覆盖）。
   * 默认：打断模式（资料朗读/点读/查词等单条意图，新请求取代正在播的）。
   */
  const speakMaterialText = useCallback(async (text: string, opts?: { queue?: boolean }) => {
    const doPlay = async (playText: string, seq: number) => {
      ttsActiveRef.current = true;
      try {
        const r = await window.api.voiceTts(playText, {});
        if (seq !== ttsSeqRef.current || !r.success || !r.audio) return; // 已被打断（seq 失效）
        console.log("[pi-tts] ▶ 开始播放 seq=" + seq + " text=" + playText.slice(0, 40));
        const blob = new Blob([r.audio], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsAudioRef.current = audio;
        const done = () => {
          if (seq !== ttsSeqRef.current) return; // 过期（已被打断），不接管播放链
          console.log("[pi-tts] ■ 播完 seq=" + seq);
          URL.revokeObjectURL(url);
          // 回执 iframe：桥脚本触发 utterance.onend（朗读按钮复位）
          iframeRef.current?.contentWindow?.postMessage({ type: "page:tts:done" }, "*");
          ttsActiveRef.current = false;
          ttsAudioRef.current = null;
          pump(); // 播完一条 → 播下一条排队台词
        };
        audio.onended = done;
        audio.onerror = done;
        await audio.play();
      } catch (e: any) {
        if (seq === ttsSeqRef.current) {
          ttsActiveRef.current = false;
          ttsAudioRef.current = null;
          pump();
        }
      }
    };
    const pump = () => {
      if (ttsActiveRef.current) return;
      const next = ttsQueueRef.current.shift();
      if (next) void doPlay(next.text, next.seq);
    };
    if (opts?.queue) {
      // 排队模式：快照当前有效 seq 入队（不递增——排队中的各条互不失效，只有打断才 seq++）。
      // 空闲立即由 pump 播放；忙则当前条播完自动取下一条。
      ttsQueueRef.current.push({ text, seq: ttsSeqRef.current });
      pump();
      return;
    }
    // 打断模式（默认，资料朗读/点读/查词）：seq++ 使当前播放/排队全部失效，播新请求
    const seq = ++ttsSeqRef.current;
    ttsQueueRef.current = [];
    ttsAudioRef.current?.pause();
    void doPlay(text, seq);
  }, []);

  /** 停止当前资料朗读（tts-cancel / 卸载时）：清队列并失效全部进行中的合成/播放 */
  const stopMaterialTts = useCallback(() => {
    ttsSeqRef.current++; // 使进行中的合成/播放回执失效
    ttsQueueRef.current = [];
    ttsActiveRef.current = false;
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
  }, []);

  // 使全部未完成指令失效（页面刷新/切换/面板卸载：旧页面不会再回执）
  const rejectPending = useCallback((error: string) => {
    const pending = pendingRef.current;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error });
    }
    pending.clear();
  }, []);

  // message 监听：组件生命周期内注册一次，handler 实时读 iframeRef（天然跟随 iframe 重建）
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return; // 防伪造：只收当前 iframe 的消息
      const data0 = event.data;
      if (!data0 || typeof data0.type !== "string") return;
      if (data0.type === "page:diag") {
        console.warn("[panel-diag]", JSON.stringify(data0).slice(0, 400));
        return;
      }
      if (data0.type.startsWith("page:") || String(data0.type).startsWith("scene:")) {
        console.debug("[panel-msg]", data0.type);
      }
      let data: any = data0;

      // MATERIAL-BRIDGE-PROTOCOL：页面已改走 PiBridge（page:app）——把场景语义动作归一化回
      // 下方既有 scene:* 处理分支（ready/item-click/mic.press/mic.release）；其余 scene.* 或
      // 通用动作保留 page:app 走「app 事件」分支（kind=app 注入 agent）。
      if (data0.type === "page:app") {
        const action = String(data0.action ?? "");
        const pl = data0.payload ?? {};
        const mapped =
          action === "scene.ready"
            ? { type: "scene:ready", manifest: pl }
            : action === "scene.item-click"
              ? { type: "scene:child-click", target: pl.target, word: pl.word, zh: pl.zh }
              : action === "scene.mic.press"
                ? { type: "scene:mic-press" }
                : action === "scene.mic.release"
                  ? { type: "scene:mic-release" }
                  : null;
        if (mapped) data = mapped;
      }

      // ISSUE-061：场景页上行事件（场景页自身脚本发出，非桥脚本）。
      // child-click 带语义（单词+中文）→ 转成通用 click 事件走既有节流上抛链给 agent；
      // mic-press/release 触发宿主录音。
      if (data.type === "scene:child-click") {
        const word = typeof data.word === "string" ? data.word : "";
        const zh = typeof data.zh === "string" ? data.zh : "";
        const evt = {
          type: "page:event",
          kind: "click",
          seq: 0,
          ts: Date.now(),
          detail: { text: word ? `${word}（${zh}）` : "", action: "scene" },
        } as unknown as PageEvent;
        const now = Date.now();
        if (throttlerRef.current.shouldEmit(`scene-click:${word}`, now, THROTTLE_WINDOW_MS)) {
          onPageEventRef.current?.(evt);
        }
        return;
      }
      // ISSUE-061：场景页就绪 → 属性清单文本随孩子下一轮消息附带注入 agent（一次）+ 通知 Learn 进入场景模式
      if (data.type === "scene:ready") {
        const text = sceneReadyText(data.manifest);
        if (text) {
          onPageEventRef.current?.({
            type: "page:event",
            kind: "scene-ready",
            seq: 0,
            ts: Date.now(),
            detail: { text },
          } as unknown as PageEvent);
        }
        onSceneActiveRef.current?.();
        console.warn("[panel-scene] scene:ready 处理完成，触发 onSceneActive", { selected: selected?.filePath, ready: readyRef.current });
        return;
      }
      // ISSUE-061：场景语音球按住说话 → 宿主录音（沙盒 iframe 内无 mic 权限，录音在宿主层）
      if (data.type === "scene:mic-press") {
        micHoldingRef.current = true;
        void recorderApiRef.current.start().catch(() => {
          micHoldingRef.current = false;
          scenePost("scene.mic.result", { ok: false, error: "无法访问麦克风，请检查系统权限" });
        });
        return;
      }
      if (data.type === "scene:mic-release") {
        micHoldingRef.current = false;
        void handleSceneMicRelease();
        return;
      }
      if (typeof data.type === "string" && data.type.startsWith("scene:")) return; // 其余 scene: 上行忽略

      if (!data.type.startsWith("page:")) return;

      // ISSUE-061：场景页 speak() 直接上抛的朗读请求（page:tts，非 page:event 包装）——
      // 此前被丢弃导致场景内角色/单词「有画面没声音」，接入与资料朗读同一条 edge-tts 链。
      if (data.type === "page:tts") {
        const t = String((data as { text?: unknown }).text ?? "");
        if (t.trim()) void speakMaterialText(t);
        return;
      }

      // —— MATERIAL-BRIDGE-PROTOCOL（PiBridge）三类信封 ——
      if (data.type === "page:app") {
        // 页面作者语义事件 → 构造 PageEvent{kind:"app"} 直接上抛给 agent（语义事件不节流）
        const action = String((data as { action?: unknown }).action ?? "");
        if (!action) return;
        onPageEventRef.current?.({
          type: "page:event",
          kind: "app",
          seq: 0,
          ts: Date.now(),
          detail: { action, payload: (data as { payload?: unknown }).payload },
        } as unknown as PageEvent);
        return;
      }
      if (data.type === "page:req") {
        const action = String((data as { action?: unknown }).action ?? "");
        const requestId = String((data as { requestId?: unknown }).requestId ?? "");
        if (action && requestId) void handleAppRequest(action, (data as { payload?: unknown }).payload, requestId);
        return;
      }

      if (data.type === "page:event") {
        const evt = data as PageEvent;
        // ISSUE-011：资料朗读事件走 edge-tts，不进页面操作记录（不 onPageEvent 上抛）
        if (evt.kind === "tts") {
          const text = (evt.detail as { text?: string })?.text;
          console.log("[pi-tts] 收到 iframe tts 事件 text=", text?.slice(0, 40));
          if (text) void speakMaterialText(text);
          return;
        }
        if (evt.kind === "tts-cancel") {
          stopMaterialTts();
          return;
        }
        // ISSUE-017：选中/双击字词 → 本地字典查询 → 浮层展示（不进页面操作记录）
        if (evt.kind === "lookup") {
          const text = (evt.detail as { text?: string })?.text ?? "";
          const ex = (evt.detail as { x?: number })?.x ?? 0;
          const ey = (evt.detail as { y?: number })?.y ?? 0;
          const entries = lookupText(text);
          if (!entries.length) return; // 无中文/查不到 → 不弹浮层
          lastLookupAtRef.current = Date.now();
          const rect = iframeRef.current?.getBoundingClientRect();
          if (!rect) return;
          showLookup({ x: rect.left + ex, y: rect.top + ey, text, entries });
          return;
        }
        // ISSUE-017：点击 iframe 别处（非本次选中交互）或滚动页面 → 关闭查词浮层
        if (lookupRef.current && (evt.kind === "click" || evt.kind === "scroll")) {
          const isSameGesture = evt.kind === "click" && Date.now() - lastLookupAtRef.current < LOOKUP_CLICK_GRACE_MS;
          if (!isSameGesture) showLookup(null);
        }
        // 节流兜底（桥脚本内已有轻量去重）：click/input/submit 同 key 3s 去重，scroll 800ms
        const now = Date.now();
        let key = evt.kind;
        let windowMs = THROTTLE_WINDOW_MS;
        if (evt.kind === "click") key += `:${evt.detail?.index ?? ""}:${evt.detail?.text ?? ""}`;
        else if (evt.kind === "input") key += `:${evt.detail?.index ?? ""}`;
        else if (evt.kind === "submit") key += `:${evt.detail?.index ?? ""}`;
        else if (evt.kind === "scroll") {
          key = "scroll";
          windowMs = SCROLL_WINDOW_MS;
        }
        if (!throttlerRef.current.shouldEmit(key, now, windowMs)) return;
        onPageEventRef.current?.(evt);
      } else if (data.type === "page:ready") {
        readyRef.current = true;
      } else if (data.type === "page:exec:result" || data.type === "page:app-cmd:result") {
        const rid = (data as { requestId?: string }).requestId;
        const p = pendingRef.current.get(rid as string);
        if (p) {
          clearTimeout(p.timer);
          pendingRef.current.delete(rid as string);
          p.resolve({
            ok: (data as { ok?: boolean }).ok === true,
            error: (data as { error?: string }).error,
            data: (data as { data?: unknown }).data,
          });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      rejectPending("页面已关闭");
      readyRef.current = false;
      stopMaterialTts(); // ISSUE-011：面板卸载停止资料朗读
      showLookup(null); // ISSUE-017：卸载关闭查词浮层
    };
  }, [rejectPending, stopMaterialTts, showLookup]);

  // ISSUE-017：Esc 关闭查词浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") showLookup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showLookup]);

  // 场景页下行控制消息（语音球状态机 / agent 忙闲）——MATERIAL-BRIDGE-PROTOCOL 标准信封
  // page:app-cmd（页面 PiBridge.on 接收；fire-and-forget，不挂 pending）
  const scenePost = useCallback((action: string, payload: unknown = null) => {
    const w = iframeRef.current?.contentWindow;
    if (w) w.postMessage({ type: "page:app-cmd", requestId: genRequestId(), action, payload }, "*");
  }, []);

  // ISSUE-061：场景语音球松手 → 停止录音 → ASR → (文本+字节)交 Learn 发场景会话。
  // 每个阶段都向场景页下行 scene.mic.status / scene.mic.result，按钮有明确交互反馈；
  // 出错也下行并在聊天提示（不再静默）。
  const handleSceneMicRelease = useCallback(async () => {
    const r = recorderApiRef.current;
    const notice = (msg: string) => onSceneMicNoticeRef.current?.(msg);
    scenePost("scene.mic.status", { status: "transcribing" }); // 语音球进入「识别中…」
    const blob = await r.stop();
    if (!blob) {
      scenePost("scene.mic.result", { ok: false, error: "没有录到声音，再试一次吧" });
      return;
    }
    if (blob.size < 2000) {
      // 过短：HTML 端按住时已本地即时提示「太快啦」，这里只补一条聊天提示，避免重复弹跳
      notice("说话太短啦，按住说完一整句再松手");
      return;
    }
    try {
      const buf = await blob.arrayBuffer();
      let tr: any;
      try {
        tr = await window.api.voiceTranscribe(buf);
      } catch (e: any) {
        const msg = e?.message || "语音识别失败，请检查语音设置";
        scenePost("scene.mic.result", { ok: false, error: msg });
        notice(msg);
        return;
      }
      const text = tr?.success ? String(tr.text || "").trim() : "";
      if (!text) {
        const msg = tr?.error ? `语音识别失败：${tr.error}` : "没听清你说的话，再说一次好吗？";
        scenePost("scene.mic.result", { ok: false, error: msg });
        notice(msg);
        return;
      }
      // 识别成功：回显给孩子看，然后交给 Learn 发场景会话（场景 agent 处理中 Learn 会置 busy）
      scenePost("scene.mic.result", { ok: true, text });
      onSceneVoiceRef.current?.(text, buf);
    } catch {
      const msg = "处理录音出错，请再试一次";
      scenePost("scene.mic.result", { ok: false, error: msg });
      notice(msg);
    }
  }, [scenePost]);

  // 下行指令：postMessage 到 iframe，requestId 配对等待回执（10s 超时）
  const exec = useCallback(
    (action: PageAction, params?: PageExecParams): Promise<PageExecResultUplink> => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !readyRef.current) {
        return Promise.resolve({ ok: false, error: "页面未就绪或已关闭" });
      }
      const requestId = genRequestId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({ ok: false, error: "页面无响应（10 秒超时）" });
        }, EXEC_TIMEOUT_MS);
        pendingRef.current.set(requestId, { resolve, timer });
        const downlink: PageExecDownlink = { type: "page:exec", requestId, action, ...(params || {}) };
        iframeWin.postMessage(downlink, "*");
      });
    },
    []
  );

  // ISSUE-061：场景页下行指令（scene_command 工具 → Learn → 此处 → 场景页自身脚本）。
  // 修复：①切换资料（iframe 重建）后 readyRef 必须在拿到新页面 page:ready 前保持 false，
  // 否则 agent 在加载竞态里开演的指令会发给尚未就绪的 iframe 而静默丢失（2026-09-07 实测）；
  // ②带 _rq 请求号并等页面 scene:ack（短超时），页面没回应也能在工具回执里暴露，不再「假成功」。
  const isScenarioRef = useRef(false);
  isScenarioRef.current =
    !!selected && selected.format === "html" && (selected.content ?? "").includes(SCENE_PAGE_MARKER);

  // MATERIAL-BRIDGE-PROTOCOL：宿主→页面作者命令（page:app-cmd，页面 PiBridge.on 接收；与 exec 同一套 pending/就绪/超时）。
  // 竞态修复（2026-09-08 实测「no handler for action: scene.say」）：iframe 刚加载/重建时 BRIDGE 的 page:ready
  // 先到（宿主放行），而页面 body 的 PiBridge.on 注册可能晚几百毫秒才执行 → 命令早到会 no handler。
  // 对策：no-handler 且命令重试成本低 → 自动稍等重试一次再报错。
  const appCmd = useCallback((action: string, payload?: unknown): Promise<PageExecResultUplink> => {
    const sendOnce = (): Promise<PageExecResultUplink> => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !readyRef.current) {
        return Promise.resolve({ ok: false, error: "页面未就绪或已关闭" });
      }
      const requestId = genRequestId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({ ok: false, error: "页面无响应（10 秒超时）" });
        }, EXEC_TIMEOUT_MS);
        pendingRef.current.set(requestId, { resolve, timer });
        iframeWin.postMessage(
          { type: "page:app-cmd", requestId, action, payload: payload === undefined ? null : payload },
          "*"
        );
      });
    };
    return sendOnce().then(async (first) => {
      // 页面已握手但业务 handler 未注册（页面 body 尚未跑完）→ 等 700ms 让注册完成再试一次
      if (!first.ok && typeof first.error === "string" && first.error.indexOf("no handler") === 0) {
        await new Promise((r) => setTimeout(r, 700));
        if (iframeRef.current?.contentWindow && readyRef.current) {
          return sendOnce();
        }
      }
      return first;
    });
  }, []);

  const scene = useCallback(
    (command: string, params?: Record<string, unknown>): Promise<PageExecResultUplink> => {
      if (!iframeRef.current?.contentWindow) {
        return Promise.resolve({ ok: false, error: "场景页未打开" });
      }
      if (!readyRef.current) {
        return Promise.resolve({ ok: false, error: "场景页加载中，请稍后再试" });
      }
      if (!isScenarioRef.current) {
        return Promise.resolve({ ok: false, error: "当前展示的不是场景页" });
      }
      // 场景页没有「结束」：完成由 agent 对话提示，不下发 end
      const allowed = ["say", "move", "act", "show", "hide", "highlight", "update"];
      if (!allowed.includes(command)) {
        return Promise.resolve({ ok: false, error: `未知场景指令：${command}` });
      }
      // MATERIAL-BRIDGE-PROTOCOL：场景演出命令 = 标准下行 scene.<cmd>（页面 PiBridge.on 接收，
      // 执行自动回执 page:app-cmd:result；可靠性由 appCmd 的 requestId/就绪 gate/超时底座保证）
      return appCmd(`scene.${command}`, params ?? {});
    },
    [appCmd]
  );

  // 资料内容/选中项变化 → iframe 即将重建，就绪态立即复位（新页面 page:ready 到达前 scene 指令一律
  // 报「加载中」，不再把指令发给半成品的 iframe）。组件卸载时也复位。
  const contentKey = selected ? `${selected.id}|${(selected.content ?? "").length}` : "none";
  const wasContentKeyRef = useRef(contentKey);
  if (wasContentKeyRef.current !== contentKey) {
    wasContentKeyRef.current = contentKey;
    readyRef.current = false;
  }

  // 场景 agent 忙闲 → 场景页显示「角色回应中…」（孩子消息已发、等回复期间）
  const sceneAgentBusy = useCallback(
    (on: boolean) => {
      scenePost("scene.busy", { busy: !!on });
    },
    [scenePost]
  );

  // 场景页准备状态（Learn 场景就绪后预建会话/预热时展示「正在准备场景伙伴…」）
  const scenePreparing = useCallback(
    (on: boolean) => {
      scenePost("scene.prepare", { status: on ? "loading" : "ready" });
    },
    [scenePost]
  );

  // —— MATERIAL-BRIDGE-PROTOCOL：页面 PiBridge.request 的宿主能力处理（page:req → page:app-res）——
  const handleAppRequest = useCallback(
    async (action: string, payload: unknown, requestId: string) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !requestId) return;
      let ok = false;
      let data: unknown;
      let error: string | undefined;
      try {
        if (action === "tts.speak") {
          const text = String((payload as { text?: unknown } | null)?.text ?? "");
          if (!text.trim()) {
            error = "tts.speak 缺少 text";
          } else {
            // queue：场景页的多句台词/点读请求逐条排队播放，后一句不覆盖前一句
            await speakMaterialText(text, { queue: true });
            ok = true;
          }
        } else {
          error = `PiBridge 未知宿主能力: ${action}`;
        }
      } catch (e: any) {
        error = e?.message || String(e);
      }
      iframeWin.postMessage(
        { type: "page:app-res", requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) },
        "*"
      );
    },
    [speakMaterialText]
  );

  useImperativeHandle(ref, () => ({ exec, scene, sceneAgentBusy, appCmd, scenePreparing }), [exec, scene, sceneAgentBusy, appCmd, scenePreparing]);

  // ISSUE-030：资料字号变化 → 运行期下发 iframe（内容未变则 iframe 不重建，靠消息即时生效；
  // 首次挂载的初始化字号由 injectBridge 注入 window.__PI_MAT_FONT，这里只处理后续变更）。
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (win && readyRef.current) {
      win.postMessage({ type: "page:mat-font", px: matFontSize }, "*");
    }
  }, [matFontSize]);

  // 详情视图
  if (selected) {
    // 兜底：内容为空时显示提示，避免空 srcDoc iframe 白屏（display_content 文件读取竞态、
    // IPC 截断等边缘场景曾触发）；同时清洗后端偶发的 \r 与首尾空白。
    const cleanHtml = (selected.content ?? "").replace(/\r/g, "").trim();
    if (!cleanHtml) {
      return (
        <div className="content-panel" style={materialFontStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
            {onCollapse && (
              <IconButton icon={PanelRightClose} title="收起学习资料" onClick={onCollapse} className="material-collapse-btn" />
            )}
          </div>
          {selected.title && <h2 className="material-title">{selected.title}</h2>}
          <div className="placeholder">
            📄
            <br />
            资料内容为空，可让 AI 老师重新展示
          </div>
        </div>
      );
    }
    return (
      <div className="content-panel" style={materialFontStyle} onClick={closeLookup}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
          {onCollapse && (
            <IconButton icon={PanelRightClose} title="收起学习资料" onClick={onCollapse} className="material-collapse-btn" />
          )}
        </div>
        {selected.title && <h2 className="material-title">{selected.title}</h2>}
        {selected.format === "html" ? (
          <HtmlFrame
            // ISSUE-061 根治：服务端共享资料（filePath 可解析为 materials 相对路径）走真实 URL 顶层文档
            //（asset://...?doc=1，协议层注入桥）→ 正文脚本随导航执行；本地产物/无 filePath 回退 dataURL。
            docUrl={resolveSharedDocUrl(selected.filePath, matFontSize, htmlEpoch)}
            html={injectBridge(cleanHtml, matFontSize)}
            title={selected.title}
            iframeRef={iframeRef}
            refreshEpoch={htmlEpoch}
            onLoad={() => {
              rejectPending("页面已刷新");
              showLookup(null); // ISSUE-017：资料刷新后旧浮层坐标失效
            }}
          />
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanHtml}</ReactMarkdown>
          </div>
        )}
        {/* ISSUE-017：查词浮层（fixed 定位，点击外部空白/Esc/滚动关闭） */}
        {lookup && (
          <WordLookupOverlay state={lookup} onSpeak={speakMaterialText} onClose={closeLookup} />
        )}
      </div>
    );
  }

  // 列表视图
  return (
    <div className="content-panel" style={materialFontStyle}>
      <div className="material-list-header">
        <span className="material-list-title">学习资料</span>
        <span className="material-list-count">{materials.length} 份</span>
        {onCollapse && (
          <IconButton
            icon={PanelRightClose}
            title="收起学习资料"
            onClick={onCollapse}
            className="material-collapse-btn"
            style={{ marginLeft: "auto" }}
          />
        )}
      </div>
      {materials.length === 0 ? (
        <div className="placeholder">
          📖
          <br />
          AI 老师会把学习资料展示在这里
        </div>
      ) : (
        <div className="material-list">
          {materials.map((m) => (
            <button key={m.id} className="material-row" onClick={() => onOpen(m.id)}>
              <span className="material-row-icon">{m.format === "html" ? "🎮" : "📄"}</span>
              <span className="material-row-body">
                <span className="material-row-title">{m.title || "未命名资料"}</span>
                <span className="material-row-time">{m.time}</span>
              </span>
              <span className="material-row-arrow">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default MaterialsPanel;

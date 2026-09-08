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
 * srcDoc 注入桥脚本（injectBridge）后，iframe 经 postMessage 与父页面双向通讯：
 * 上报孩子互动（page:event）、接收受控指令（page:exec）并回执（page:exec:result）。
 */
function HtmlFrame({
  html,
  title,
  iframeRef,
  onLoad,
}: {
  html: string;
  title?: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
}) {
  // key 强制 iframe 重建：React/Chromium 在 srcDoc 字符串变化时更新属性但不保证重载（已知
  // Electron 沙箱 iframe 偶发"内容不渲染/白屏"，必现于 display_content 去重后再展示同一份资料
  // 的场景）。key = 长度 + 内容 hash（ISSUE-021：同 path 重发但内容长度相同时也能识别变化）。
  return (
    <iframe
      key={`${html.length}:${hashStr(html)}`}
      ref={iframeRef}
      className="html-frame"
      sandbox="allow-scripts allow-modals allow-forms"
      srcDoc={html}
      title={title || "学习内容"}
      onLoad={onLoad}
    />
  );
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

  /** 资料 html 朗读（speechSynthesis shim 上抛）→ edge-tts 合成播放，结束后回执 iframe 触发按钮复位 */
  const speakMaterialText = useCallback(async (text: string) => {
    const seq = ++ttsSeqRef.current;
    ttsAudioRef.current?.pause();
    console.log("[pi-tts] 收到朗读请求 text=", text.slice(0, 40));
    try {
      const r = await window.api.voiceTts(text, {});
      if (seq !== ttsSeqRef.current || !r.success || !r.audio) {
        console.log("[pi-tts] 跳过：seq 过期或合成失败", { seq, cur: ttsSeqRef.current, success: r?.success });
        return;
      }
      console.log("[pi-tts] 合成成功 bytes=", r.audio.length);
      const blob = new Blob([r.audio], { type: "audio/mpeg" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      ttsAudioRef.current = audio;
      const done = () => {
        if (seq !== ttsSeqRef.current) return;
        URL.revokeObjectURL(url);
        // 回执 iframe：桥脚本触发 utterance.onend（朗读按钮复位）
        iframeRef.current?.contentWindow?.postMessage({ type: "page:tts:done" }, "*");
        console.log("[pi-tts] 播放结束，已回执 iframe");
      };
      audio.onended = done;
      audio.onerror = done;
      await audio.play();
      console.log("[pi-tts] audio.play() 已调用");
    } catch (e: any) {
      console.log("[pi-tts] 播放异常:", e?.message || e);
    }
  }, []);

  /** 停止当前资料朗读（tts-cancel / 卸载时） */
  const stopMaterialTts = useCallback(() => {
    ttsSeqRef.current++; // 使进行中的合成回执失效
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
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      // ISSUE-061：场景页上行事件（场景页自身脚本发出，非桥脚本）。
      // child-click 带语义（单词+中文）→ 转成通用 click 事件走既有节流上抛链给 agent；
      // mic-press/release v1 不注入（孩子用聊天语音输入）。
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
        return;
      }
      // ISSUE-061：场景语音球按住说话 → 宿主录音（沙盒 iframe 内无 mic 权限，录音在宿主层）
      if (data.type === "scene:mic-press") {
        micHoldingRef.current = true;
        void recorderApiRef.current.start().catch(() => {
          micHoldingRef.current = false;
          scenePost({ type: "scene:mic-result", ok: false, error: "无法访问麦克风，请检查系统权限" });
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
      } else if (data.type === "page:exec:result") {
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

  // 场景页下行控制消息（语音球状态机 / agent 忙闲）——fire-and-forget
  const scenePost = useCallback((msg: Record<string, unknown>) => {
    const w = iframeRef.current?.contentWindow;
    if (w) w.postMessage(msg, "*");
  }, []);

  // ISSUE-061：场景语音球松手 → 停止录音 → ASR → (文本+字节)交 Learn 发场景会话。
  // 每个阶段都向场景页下行 scene:mic-status / scene:mic-result，按钮有明确交互反馈；
  // 出错也下行并在聊天提示（不再静默）。
  const handleSceneMicRelease = useCallback(async () => {
    const r = recorderApiRef.current;
    const notice = (msg: string) => onSceneMicNoticeRef.current?.(msg);
    scenePost({ type: "scene:mic-status", status: "transcribing" }); // 语音球进入「识别中…」
    const blob = await r.stop();
    if (!blob) {
      scenePost({ type: "scene:mic-result", ok: false, error: "没有录到声音，再试一次吧" });
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
        scenePost({ type: "scene:mic-result", ok: false, error: msg });
        notice(msg);
        return;
      }
      const text = tr?.success ? String(tr.text || "").trim() : "";
      if (!text) {
        const msg = tr?.error ? `语音识别失败：${tr.error}` : "没听清你说的话，再说一次好吗？";
        scenePost({ type: "scene:mic-result", ok: false, error: msg });
        notice(msg);
        return;
      }
      // 识别成功：回显给孩子看，然后交给 Learn 发场景会话（场景 agent 处理中 Learn 会置 busy）
      scenePost({ type: "scene:mic-result", ok: true, text });
      onSceneVoiceRef.current?.(text, buf);
    } catch {
      const msg = "处理录音出错，请再试一次";
      scenePost({ type: "scene:mic-result", ok: false, error: msg });
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

  const scene = useCallback(
    (command: string, params?: Record<string, unknown>): Promise<PageExecResultUplink> => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin) {
        return Promise.resolve({ ok: false, error: "场景页未打开" });
      }
      if (!readyRef.current) {
        return Promise.resolve({ ok: false, error: "场景页加载中，请稍后再试" });
      }
      if (!isScenarioRef.current) {
        return Promise.resolve({ ok: false, error: "当前展示的不是场景页" });
      }
      // 场景页没有「结束」：完成由 agent 对话提示，不下发 end
      const allowed = ["say", "move", "act", "show", "highlight", "update"];
      if (!allowed.includes(command)) {
        return Promise.resolve({ ok: false, error: `未知场景指令：${command}` });
      }
      const rq = "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      iframeWin.postMessage({ type: `scene:${command}`, _rq: rq, ...(params || {}) }, "*");
      return new Promise((resolve) => {
        const onAck = (e: MessageEvent) => {
          const a = e.data;
          if (a && a.type === "scene:ack" && a._rq === rq) {
            cleanup();
            resolve({ ok: true });
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          // 页面已就绪但没回执：大概率是旧版场景页（无 ack 实现）。仍算成功并带说明，便于诊断。
          resolve({ ok: true, note: "已下发场景指令（页面未回执，可能为旧版页面或仍在渲染）" });
        }, 400);
        function cleanup() {
          clearTimeout(timer);
          window.removeEventListener("message", onAck);
        }
        window.addEventListener("message", onAck);
      });
    },
    []
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
      scenePost({ type: "scene:agent-busy", busy: !!on });
    },
    [scenePost]
  );

  useImperativeHandle(ref, () => ({ exec, scene, sceneAgentBusy }), [exec, scene, sceneAgentBusy]);

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
            html={injectBridge(cleanHtml, matFontSize)}
            title={selected.title}
            iframeRef={iframeRef}
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

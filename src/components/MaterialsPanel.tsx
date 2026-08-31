import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import IconButton from "./IconButton";
import { ArrowLeft, PanelRightClose, Volume2, X } from "lucide-react";
import { lookupText, type LookupEntry } from "../lib/dictionary";
import {
  EventThrottler,
  genRequestId,
  injectBridge,
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
}

const EXEC_TIMEOUT_MS = 10000;
const THROTTLE_WINDOW_MS = 3000;
const SCROLL_WINDOW_MS = 800;

interface PendingExec {
  resolve: (r: PageExecResultUplink) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** ISSUE-017：查词浮层状态（视口坐标 + 选中文本 + 查询结果） */
interface LookupState {
  /** 浮层锚点（视口坐标，已叠加 iframe 偏移） */
  x: number;
  y: number;
  /** 选中的原始文本 */
  text: string;
  entries: LookupEntry[];
}

/** 同一交互序列（mouseup 选中 → 随后 click）内 click 不应关闭浮层的时间窗 */
const LOOKUP_CLICK_GRACE_MS = 400;

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
  // 的场景）。用 html 长度做轻量 key，内容真有变化才重建（避免每次 set render 都销毁重建）。
  return (
    <iframe
      key={html.length}
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
 * ISSUE-017：查词浮层（拼音 + 释义 + 朗读）。
 * fixed 定位在选中坐标旁；点击浮层内部不关闭（stopPropagation），外部/Esc 关闭由父级处理。
 */
function WordLookupOverlay({
  state,
  onSpeak,
  onClose,
}: {
  state: LookupState;
  onSpeak: (text: string) => void;
  onClose: () => void;
}) {
  // 粗略 clamp 到视口内（浮层宽约 240px、高约 180px），避免溢出
  const MARGIN = 8;
  const x = Math.min(Math.max(MARGIN, state.x), window.innerWidth - 240 - MARGIN);
  const y = Math.min(Math.max(MARGIN, state.y), window.innerHeight - 180 - MARGIN);
  return (
    <div
      className="word-lookup-overlay"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="字词释义"
    >
      <div className="word-lookup-head">
        <span className="word-lookup-selected">{state.text}</span>
        <IconButton icon={X} title="关闭" size={16} onClick={onClose} className="word-lookup-close" />
      </div>
      <div className="word-lookup-items">
        {state.entries.map((en, i) => (
          <div className="word-lookup-item" key={`${en.text}-${i}`}>
            <span className="word-lookup-item-word">{en.text}</span>
            <span className="word-lookup-item-py">{en.pinyin || "·"}</span>
            <span className="word-lookup-item-meaning">{en.meaning || "（暂无释义）"}</span>
            {en.text && (
              <IconButton
                icon={Volume2}
                title={`朗读「${en.text}」`}
                size={16}
                onClick={() => onSpeak(en.text)}
                className="word-lookup-item-speak"
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 学习资料面板：列表 + 详情两态。
 * - 列表：每一行是一次学习资料（当前会话里 AI 展示过的全部资料）
 * - 详情：点开后展示该份资料，可「返回列表」
 */
const MaterialsPanel = forwardRef<MaterialsPanelHandle, Props>(function MaterialsPanel(
  { materials, selectedId, onOpen, onBack, onPageEvent, onCollapse },
  ref
) {
  const selected = materials.find((m) => m.id === selectedId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  const pendingRef = useRef(new Map<string, PendingExec>());
  const throttlerRef = useRef(new EventThrottler());
  const onPageEventRef = useRef(onPageEvent);
  onPageEventRef.current = onPageEvent;
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
      if (!data || typeof data.type !== "string" || !data.type.startsWith("page:")) return;

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

  useImperativeHandle(ref, () => ({ exec }), [exec]);

  // 详情视图
  if (selected) {
    // 兜底：内容为空时显示提示，避免空 srcDoc iframe 白屏（display_content 文件读取竞态、
    // IPC 截断等边缘场景曾触发）；同时清洗后端偶发的 \r 与首尾空白。
    const cleanHtml = (selected.content ?? "").replace(/\r/g, "").trim();
    if (!cleanHtml) {
      return (
        <div className="content-panel">
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
      <div className="content-panel" onClick={closeLookup}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
          {onCollapse && (
            <IconButton icon={PanelRightClose} title="收起学习资料" onClick={onCollapse} className="material-collapse-btn" />
          )}
        </div>
        {selected.title && <h2 className="material-title">{selected.title}</h2>}
        {selected.format === "html" ? (
          <HtmlFrame
            html={injectBridge(cleanHtml)}
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
    <div className="content-panel">
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

import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import IconButton from "./IconButton";
import { Search, Volume2, X } from "lucide-react";
import { lookupText, canLookupSelection, type LookupEntry } from "../lib/dictionary";

/** ISSUE-017：查词浮层状态（视口坐标 + 选中文本 + 查询结果） */
export interface LookupState {
  /** 浮层锚点（视口坐标） */
  x: number;
  y: number;
  /** 选中的原始文本 */
  text: string;
  entries: LookupEntry[];
}

const OVERLAY_W = 250;
const MARGIN = 8;
/** 悬浮图标直径（选词后先出图标，点击才展开弹框） */
const BUBBLE = 36;

/** 多音字 pinyin 拆成读音数组（空格分隔） */
function readingsOf(en: LookupEntry): string[] {
  return (en.pinyin || "").split(/\s+/).filter(Boolean);
}

/** 按条目/读音数估算浮层高度，用于 clamp 防溢出 */
function estimateHeight(entries: LookupEntry[]): number {
  return 44 + entries.reduce((h, en) => h + 10 + 28 * Math.max(1, readingsOf(en).length), 0);
}

function clampPos(x: number, y: number, estH: number) {
  return {
    x: Math.min(Math.max(MARGIN, x), window.innerWidth - OVERLAY_W - MARGIN),
    y: Math.min(Math.max(MARGIN, y), window.innerHeight - estH - MARGIN),
  };
}

/**
 * 浮层定位用高度：先按 estimateHeight 给初始位置，挂载后实测实际高度再精确 clamp
 * （大字号档位/多音字多行时估算偏差可达数十 px，实测兜底防溢出视口底部）。
 */
function useMeasuredClamp(state: LookupState, ref: RefObject<HTMLDivElement | null>) {
  const estH = estimateHeight(state.entries);
  const [measuredH, setMeasuredH] = useState<number | null>(null);
  useLayoutEffect(() => {
    setMeasuredH(null); // 新浮层先回到估算位，避免用上一个浮层的高度
    const el = ref.current;
    if (el) setMeasuredH(el.offsetHeight);
  }, [state, ref]);
  const { x, y } = clampPos(state.x, state.y, measuredH ?? estH);
  return { x, y };
}

/**
 * ISSUE-017 优化（2026-09-27）：选中文本后先在选中点旁显示悬浮小图标（不直接弹框，避免打断阅读），
 * 点击图标才展开查词弹框。「点了才查」也让错题本上报成为更强的主动信号。
 * mousedown/click 均 stopPropagation：不触发父级的「点外部关闭」逻辑。
 */
export const WordLookupBubble = forwardRef<HTMLButtonElement, {
  /** 图标锚点（视口坐标，内部自行 clamp 防出屏） */
  x: number;
  y: number;
  onOpen: () => void;
}>(function WordLookupBubble({ x, y, onOpen }, ref) {
  const left = Math.min(Math.max(MARGIN, x), window.innerWidth - BUBBLE - MARGIN);
  const top = Math.min(Math.max(MARGIN, y), window.innerHeight - BUBBLE - MARGIN);
  return (
    <button
      ref={ref}
      type="button"
      className="word-lookup-bubble"
      style={{ left, top }}
      title="查看读音"
      aria-label="查看选中字词的读音"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
    >
      <Search size={20} strokeWidth={2.5} />
    </button>
  );
});

/**
 * ISSUE-017 查词弹框 / ISSUE-031 优化：只显示「字 + 分行拼音 + 朗读」，去掉释义。
 * - 拼音字号与字同大（var(--material-font) 随资料字号联动，聊天等无该变量时回退 22px）；
 * - 多音字多个读音分行展示（视觉信息）；🔊 每个词条一个、朗读字词本身——
 *   2026-09-27 修正：原设计「每个读音播拼音串」中文 TTS 会按英文读，且 edge-tts 无法指定多音字读音；
 * - 头部「朗读选中文本」按钮播放整段选中文本；
 * - fixed 定位在选中坐标旁；点击浮层内部不关闭（stopPropagation），外部/Esc 关闭由父级处理。
 */
export const WordLookupOverlay = forwardRef<HTMLDivElement, {
  state: LookupState;
  onSpeak: (text: string) => void;
  onClose: () => void;
  /** ISSUE-114 C2：查词自动上报（查=不会的最强信号）。传了就在浮层展示时上报一次。 */
  onReport?: (text: string, pinyin: string, meaning: string) => void;
}>(function WordLookupOverlay({ state, onSpeak, onClose, onReport }, ref) {
  // 内部 ref 供实测高度用（forwardRef 的 ref 可能不传——MaterialsPanel 就没传，直接读 ref.current 会白屏）；
  // 外部转发的 ref（聊天区外部点击关闭判定用）经回调合并挂载。
  const innerRef = useRef<HTMLDivElement | null>(null);
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      innerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) (ref as RefObject<HTMLDivElement | null>).current = node;
    },
    [ref]
  );
  const { x, y } = useMeasuredClamp(state, innerRef);
  const reportedKey = `${state.text}@${state.x},${state.y}`;
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onReport || !state.text.trim()) return;
    if (lastReportedRef.current === reportedKey) return; // 同一浮层实例不重复上报
    lastReportedRef.current = reportedKey;
    const pinyin = state.entries.map((e) => e.pinyin).filter(Boolean).join(" ");
    const meaning = state.entries.map((e) => e.meaning).filter(Boolean).join("；");
    onReport(state.text.trim(), pinyin, meaning);
  }, [reportedKey]);
  return (
    <div
      ref={setRootRef}
      className="word-lookup-overlay"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="字词读音"
    >
      <div className="word-lookup-head">
        <span className="word-lookup-selected">{state.text}</span>
        <div className="word-lookup-head-actions">
          {state.text && (
            <IconButton
              icon={Volume2}
              title="朗读选中文本"
              size={16}
              onClick={() => onSpeak(state.text)}
              className="word-lookup-play-all"
            />
          )}
          <IconButton icon={X} title="关闭" size={16} onClick={onClose} className="word-lookup-close" />
        </div>
      </div>
      <div className="word-lookup-items">
        {state.entries.map((en, i) => {
          const readings = readingsOf(en);
          return (
            <div className="word-lookup-item" key={`${en.text}-${i}`}>
              <span className="word-lookup-item-word">{en.text}</span>
              {/* 🔊 朗读字词本身：拼音串喂给中文 TTS 会按英文读（2026-09-27 用户反馈），
                  edge-tts 也无法指定多音字读哪个音 → 读音按钮只放一个、播汉字原文，拼音仅作展示 */}
              <IconButton
                icon={Volume2}
                title={`朗读「${en.text}」`}
                size={16}
                onClick={() => onSpeak(en.text)}
                className="word-lookup-item-speak"
              />
              <div className="word-lookup-readings">
                {readings.length > 0 ? (
                  readings.map((py, j) => (
                    <div className="word-lookup-reading" key={`${py}-${j}`}>
                      <span className="word-lookup-item-py">{py}</span>
                    </div>
                  ))
                ) : (
                  <span className="word-lookup-item-py word-lookup-py-none">暂无读音</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});

/**
 * 在 React DOM 容器内捕获中文选区 → 两段式查词：先出悬浮图标（anchor），点击图标展开弹框（open）。
 * 与资料 iframe 的 page-bridge 通道不同，这里直接监听 document 的 mouseup 取 window.getSelection()。
 * 返回 anchor（图标锚点+查询结果）、open（弹框是否展开）、openPopup/close、onSpeak 与
 * overlayRef（挂到弹框根节点用于点击外部关闭判定）。
 */
export function useWordLookup(
  containerRef: RefObject<HTMLElement | null>,
  onSpeak: (text: string) => void
) {
  const [anchor, setAnchor] = useState<LookupState | null>(null);
  const [open, setOpen] = useState(false);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onSpeakRef = useRef(onSpeak);
  onSpeakRef.current = onSpeak;

  const close = useCallback(() => {
    setAnchor(null);
    setOpen(false);
  }, []);
  const openPopup = useCallback(() => setOpen(true), []);

  // 捕获选区：仅在容器内、含中文且不超长时出图标（口径与 iframe 桥一致，canLookupSelection）
  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!canLookupSelection(text)) return;
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (container && !container.contains(range.commonAncestorContainer)) return;
      const entries = lookupText(text);
      if (!entries.length) return;
      const rect = range.getBoundingClientRect();
      setAnchor({ x: rect.left, y: rect.bottom + 8, text, entries });
      setOpen(false); // 新选区回到图标态（防溢出由 Bubble/弹框各自 clamp）
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [containerRef]);

  // 点图标/弹框以外、或 Esc → 收起（图标与弹框内部均 stopPropagation，不会触发）
  useEffect(() => {
    if (!anchor) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (open && overlayRef.current && overlayRef.current.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, open, close]);

  return { anchor, open, openPopup, close, onSpeak: (t: string) => onSpeakRef.current(t), overlayRef };
}

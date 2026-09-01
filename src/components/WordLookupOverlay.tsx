import { forwardRef, useCallback, useEffect, useRef, useState, type RefObject } from "react";
import IconButton from "./IconButton";
import { Volume2, X } from "lucide-react";
import { lookupText, type LookupEntry } from "../lib/dictionary";

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
 * ISSUE-017 查词浮层 / ISSUE-031 优化：只显示「字 + 分行拼音 + 每音独立朗读 + 整段朗读」，去掉释义。
 * - 拼音字号与字同大（var(--material-font) 随资料字号联动，聊天等无该变量时回退 22px）；
 * - 多音字多个读音分行，每个读音各有 🔊（onSpeak 传入该读音拼音串以播对应音）；
 * - 头部「朗读选中文本」按钮播放整段选中文本；
 * - fixed 定位在选中坐标旁；点击浮层内部不关闭（stopPropagation），外部/Esc 关闭由父级处理。
 */
export const WordLookupOverlay = forwardRef<HTMLDivElement, {
  state: LookupState;
  onSpeak: (text: string) => void;
  onClose: () => void;
}>(function WordLookupOverlay({ state, onSpeak, onClose }, ref) {
  const estH = estimateHeight(state.entries);
  const { x, y } = clampPos(state.x, state.y, estH);
  return (
    <div
      ref={ref}
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
              <div className="word-lookup-readings">
                {readings.length > 0 ? (
                  readings.map((py, j) => (
                    <div className="word-lookup-reading" key={`${py}-${j}`}>
                      <span className="word-lookup-item-py">{py}</span>
                      <IconButton
                        icon={Volume2}
                        title={`朗读「${en.text}」读音 ${py}`}
                        size={16}
                        onClick={() => onSpeak(py)}
                        className="word-lookup-item-speak"
                      />
                    </div>
                  ))
                ) : (
                  <span className="word-lookup-item-py word-lookup-py-none">·</span>
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
 * 在 React DOM 容器内捕获中文选区 → 触发查词浮层。
 * 与资料 iframe 的 page-bridge 通道不同，这里直接监听 document 的 mouseup 取 window.getSelection()。
 * 返回浮层 state、onSpeak、close 与 overlayRef（挂到浮层根节点用于点击外部关闭判定）。
 */
export function useWordLookup(
  containerRef: RefObject<HTMLElement | null>,
  onSpeak: (text: string) => void
) {
  const [state, setState] = useState<LookupState | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const onSpeakRef = useRef(onSpeak);
  onSpeakRef.current = onSpeak;

  const close = useCallback(() => setState(null), []);

  // 捕获选区：仅在容器内、含中文时弹浮层
  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!text || !/[一-龥]/.test(text)) return;
      const range = sel.getRangeAt(0);
      const container = containerRef.current;
      if (container && !container.contains(range.commonAncestorContainer)) return;
      const entries = lookupText(text);
      if (!entries.length) return;
      const rect = range.getBoundingClientRect();
      const estH = estimateHeight(entries);
      const { x, y } = clampPos(rect.left, rect.bottom + 8, estH);
      setState({ x, y, text, entries });
    };
    document.addEventListener("mouseup", onUp);
    return () => document.removeEventListener("mouseup", onUp);
  }, [containerRef]);

  // 点击浮层外部 / Esc 关闭（浮层内部 stopPropagation，不会触发）
  useEffect(() => {
    if (!state) return;
    const onDocDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (overlayRef.current && overlayRef.current.contains(t)) return;
      setState(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setState(null);
    };
    document.addEventListener("mousedown", onDocDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [state]);

  return { state, onSpeak: (t: string) => onSpeakRef.current(t), close, overlayRef };
}

// 逐字着色展示发音评测结果：绿=读对、橙=待加强、红=读错、黄=声调、灰删除线=漏读、橙波浪=重读。
// 点字词可按评测返回的 start/end 时间回放对应片段（需要整段录音的 data URL 或按需加载）。
import { useRef, useState } from "react";
import {
  SPEECH_LEGEND,
  SPEECH_TONE_STYLE,
  buildSpeechTokens,
  summarizeSpeechWords,
  type SpeechProvider,
  type SpeechWordLike,
} from "../lib/speech-text";

export type { SpeechWordLike };

interface SpeechTextProps {
  refText: string;
  words?: SpeechWordLike[];
  /** dp_type/MatchTag 语义按 provider 区分（智聆 dp_type=3 是错读） */
  provider?: SpeechProvider;
  /** 整段录音（data URL / blob URL）；没有则点读时调 onNeedAudio 现取 */
  audioSrc?: string | null;
  onNeedAudio?: () => Promise<string | null | undefined>;
  showLegend?: boolean;
  showSummary?: boolean;
  fontSize?: number;
  audioQuality?: { tipId?: number };
}

const TIP_TEXT: Record<number, string> = {
  10000: "没有录到声音",
  10004: "录音音量偏小，离麦克风有点远",
  10005: "离麦克风太近，声音有截幅",
  10006: "环境比较吵，语音不够清晰",
  10008: "音量过大，出现了截幅",
};

export default function SpeechText({
  refText,
  words,
  provider,
  audioSrc,
  onNeedAudio,
  showLegend = true,
  showSummary = false,
  fontSize = 15,
  audioQuality,
}: SpeechTextProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedSrcRef = useRef("");
  const stopAtRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(-1);

  if (!refText) return null;

  const hasWords = !!words?.length;
  const tokens = buildSpeechTokens(refText, words, provider);
  const canPlay = !!(audioSrc || onNeedAudio);
  const summary = showSummary ? summarizeSpeechWords(words, provider) : null;
  const tipId = audioQuality?.tipId;

  async function ensureAudio(): Promise<string> {
    if (audioSrc) return audioSrc;
    if (loadedSrcRef.current) return loadedSrcRef.current;
    try {
      const got = await onNeedAudio?.();
      if (got) loadedSrcRef.current = got;
      return got || "";
    } catch {
      return "";
    }
  }

  async function play(index: number) {
    const w = tokens[index]?.word;
    if (!w || w.startMs == null || !canPlay) return;
    const el = audioRef.current;
    if (!el) return;
    const src = await ensureAudio();
    if (!src) return;
    if (loadedSrcRef.current !== src) {
      loadedSrcRef.current = src;
      el.src = src;
      await new Promise<void>((resolve) => {
        const done = () => {
          el.removeEventListener("loadedmetadata", done);
          el.removeEventListener("error", done);
          resolve();
        };
        el.addEventListener("loadedmetadata", done);
        el.addEventListener("error", done);
        el.load();
      });
    }
    const start = Math.max(0, w.startMs / 1000);
    const end = w.endMs != null && w.endMs > w.startMs ? w.endMs / 1000 : start + 0.6;
    stopAtRef.current = end;
    try {
      el.currentTime = start;
    } catch {
      /* 元数据未就绪时忽略，play 仍会从头播 */
    }
    setPlaying(index);
    try {
      await el.play();
    } catch {
      setPlaying(-1);
    }
  }

  function handleTimeUpdate() {
    const el = audioRef.current;
    const stop = stopAtRef.current;
    if (!el || stop == null) return;
    if (el.currentTime >= stop) {
      el.pause();
      stopAtRef.current = null;
      setPlaying(-1);
    }
  }

  return (
    <div>
      <div style={{ fontSize, lineHeight: 2, letterSpacing: "0.02em", wordBreak: "break-word" }}>
        {tokens.map((t, i) => {
          if (!t.word) return <span key={i}>{t.text}</span>;
          const st = SPEECH_TONE_STYLE[t.tone];
          const playable = t.playable && canPlay;
          return (
            <span
              key={i}
              title={t.title || undefined}
              onClick={playable ? () => void play(i) : undefined}
              style={{
                ...st,
                cursor: playable ? "pointer" : "default",
                background: playing === i ? "#fff3bf" : (st.background as string | undefined),
                borderRadius: 3,
                padding: "0 0.5px",
              }}
            >
              {t.text}
              {t.word.isPause ? (
                <span style={{ fontSize: "0.65em", color: "#98a2b3", verticalAlign: "super" }}>⏸</span>
              ) : null}
            </span>
          );
        })}
      </div>

      {showSummary && summary && hasWords && (
        <div style={{ marginTop: 4, fontSize: 12, color: "#777777" }}>
          {[
            summary.ok ? `读对 ${summary.ok}` : "",
            summary.mid ? `待加强 ${summary.mid}` : "",
            summary.bad ? `读错 ${summary.bad}` : "",
            summary.tone ? `声调 ${summary.tone}` : "",
            summary.missing ? `漏读 ${summary.missing}` : "",
            summary.repeat ? `重读 ${summary.repeat}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      )}

      {showLegend && hasWords && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10, marginTop: 6, fontSize: 11, color: "#777777" }}>
          {SPEECH_LEGEND.map((x) => (
            <span key={x.tone} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  display: "inline-block",
                  background: SPEECH_TONE_STYLE[x.tone].color as string,
                }}
              />
              {x.label}
            </span>
          ))}
          {canPlay && <span>· 点字词可回放</span>}
        </div>
      )}

      {tipId && TIP_TEXT[tipId] ? (
        <div style={{ marginTop: 4, fontSize: 12, color: "#b9770a" }}>🎙 {TIP_TEXT[tipId]}</div>
      ) : null}

      <audio
        ref={audioRef}
        onTimeUpdate={handleTimeUpdate}
        onEnded={() => setPlaying(-1)}
        preload="none"
        style={{ display: "none" }}
      />
    </div>
  );
}

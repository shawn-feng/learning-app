import { useEffect, useRef, useState } from "react";
import { Mic, Play, RotateCcw, Square } from "lucide-react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import { useVolumeThreshold } from "../hooks/useVolumeThreshold";
import {
  createVolumeMeter,
  measureBlobVolumeNorm,
  volumeBarColor,
  volumeVerdict,
  type VolumeMeter,
} from "../lib/audio-volume";

/**
 * ISSUE-189：孩子端「声音检测」弹框（左侧图标栏入口）。
 *
 * 为什么要有：孩子声音小是 ASR 识别不准 / 朗读评分失真的头号原因（ISSUE-183 对考核已做前置校验，
 * 但孩子平时不知道自己"有多小"）。这里让孩子录一段、实时看音量条、录完直接给结论（达标/还差一点/太小），
 * 达标线就是聊天语音输入送 ASR 前的那条线（ISSUE-191 起按**当前孩子**取：家长在「设置 → 发音评测」
 * 里给孩子单独配的阈值，未单独设置回退家长默认线；useVolumeThreshold 读取，与考核 iframe 同源），
 * 所以「这里达标 = 录音能用」；家长设 0（关闭）时只显示音量、不做判定。
 *
 * 纯本地：只用 getUserMedia + decodeAudioData，不调 ASR / 不落盘 / 不上传，家长关了语音输入也能用。
 */
type Phase = "idle" | "recording" | "measuring" | "done";

export default function VolumeCheckModal({ childId, onClose }: { childId: string; onClose: () => void }) {
  const { recording, start, stop, streamRef } = useAudioRecorder();
  // 达标线 = 该孩子的阈值（0=不校验 → 只显示音量，不做达标判定）
  const minNorm = useVolumeThreshold(childId);
  const [phase, setPhase] = useState<Phase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [norm, setNorm] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);

  const meterRef = useRef<VolumeMeter | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const valueRef = useRef<HTMLSpanElement | null>(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  const recStartRef = useRef(0);
  // 同步标记：点停止早于 getUserMedia 完成时，不要再把音量表挂上去
  const activeRef = useRef(false);
  // 同步标记：getUserMedia 未返回前重复点「开始录音」不重复开表/计时
  const startingRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  const verdict = norm === null ? null : minNorm > 0 ? volumeVerdict(norm, minNorm) : null;
  const isRecording = phase === "recording" || recording;

  function paint(n: number) {
    const fill = fillRef.current;
    if (fill) {
      fill.style.width = `${Math.max(2, n)}%`;
      fill.style.background = volumeBarColor(n, minNorm);
    }
    const value = valueRef.current;
    if (value) value.textContent = String(n);
  }

  function stopMeter() {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    meterRef.current?.close();
    meterRef.current = null;
  }

  function startMeter() {
    const stream = streamRef.current;
    if (!stream || meterRef.current) return;
    const meter = createVolumeMeter(stream);
    meterRef.current = meter;
    const tick = () => {
      const current = meterRef.current;
      if (!current) return;
      paint(current.getNorm());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }

  function stopPlayback() {
    audioRef.current?.pause();
    audioRef.current = null;
    setPlaying(false);
  }

  function clearAudio() {
    stopPlayback();
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setAudioUrl(null);
  }

  async function handleStart() {
    if (phase === "measuring" || startingRef.current) return;
    startingRef.current = true;
    // 重新开始前先收尾上一次的表/计时（再测一次 / 连点场景）
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    stopMeter();
    setError("");
    setNorm(null);
    setPhase("idle");
    clearAudio();
    paint(0);
    activeRef.current = true;
    try {
      await start();
      // 点停止早于 getUserMedia 完成：录音已取消，不要再起表/计时
      if (!activeRef.current) return;
      setPhase("recording");
      recStartRef.current = Date.now();
      setElapsed(0);
      timerRef.current = window.setInterval(() => {
        setElapsed(Math.floor((Date.now() - recStartRef.current) / 1000));
      }, 500);
      startMeter();
    } catch {
      activeRef.current = false;
      setPhase("idle");
      setError("打不开麦克风：请检查电脑/浏览器有没有拦住麦克风权限");
    } finally {
      startingRef.current = false;
    }
  }

  async function handleStop() {
    activeRef.current = false;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = 0;
    }
    stopMeter();
    const blob = await stop();
    setPhase("idle");
    if (!blob || blob.size < 2000) {
      setError("录得太短啦——至少要说完一句话（1 秒以上）再停下");
      return;
    }
    setPhase("measuring");
    const measured = await measureBlobVolumeNorm(blob);
    if (measured === null) {
      setPhase("idle");
      setError("这段录音分析不了音量，请再录一次");
      return;
    }
    setNorm(measured);
    paint(measured);
    const url = URL.createObjectURL(blob);
    audioUrlRef.current = url;
    setAudioUrl(url);
    setPhase("done");
  }

  function togglePlayback() {
    if (!audioUrl) return;
    if (playing) {
      stopPlayback();
      return;
    }
    const audio = new Audio(audioUrl);
    audioRef.current = audio;
    audio.onended = () => {
      setPlaying(false);
      audioRef.current = null;
    };
    audio.onerror = () => {
      setPlaying(false);
      audioRef.current = null;
    };
    setPlaying(true);
    void audio.play().catch(() => {
      setPlaying(false);
      audioRef.current = null;
    });
  }

  // 关闭/卸载：停表、停播放、释放麦克风与临时 URL（不留「幽灵录音」）
  useEffect(() => {
    return () => {
      activeRef.current = false;
      if (timerRef.current) clearInterval(timerRef.current);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      meterRef.current?.close();
      meterRef.current = null;
      audioRef.current?.pause();
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal volume-check-modal" onClick={(e) => e.stopPropagation()}>
        <h2>声音检测</h2>
        <p className="volume-check-intro">
          说话声音太小，AI 会听不清、朗读评分也会吃亏。先在这里
          <b> 大声说一句话</b>（比如「今天的天气真好」），看看声音够不够大。
        </p>
        {minNorm === 0 && (
          <p className="volume-check-note">
            家长暂时没有设置达标线（音量校验已关闭），这里只显示你的音量大小。
          </p>
        )}

        <div className="volume-check-meter">
          <div className="volume-check-track-wrap">
            <div className="volume-check-track">
              <div className="volume-check-fill" ref={fillRef} />
            </div>
            {minNorm > 0 && (
              <div className="volume-check-line" style={{ left: `${minNorm}%` }}>
                <span>达标线 {minNorm}</span>
              </div>
            )}
          </div>
          <div className="volume-check-scale">
            <span>🔈 {minNorm > 0 ? "太小" : "小声"}</span>
            <span>🔊 {minNorm > 0 ? "够大" : "大声"}</span>
          </div>
        </div>

        <div className={`volume-check-status${phase === "recording" ? " recording" : ""}`}>
          {phase === "recording" ? (
            <>
              🎙️ 录音中 {elapsed}s · 当前音量 <span className="volume-check-live-value" ref={valueRef}>0</span>
            </>
          ) : phase === "measuring" ? (
            "⏳ 正在分析这段录音的音量…"
          ) : phase === "done" ? (
            "检测完成，看看下面的结果吧"
          ) : (
            "点一次开始，再点一次停止"
          )}
        </div>

        <button
          className={`volume-check-btn${isRecording ? " recording" : ""}`}
          onClick={isRecording ? handleStop : handleStart}
          disabled={phase === "measuring"}
        >
          {isRecording ? (
            <>
              <Square size={18} /> 停止检测
            </>
          ) : (
            <>
              <Mic size={20} /> 开始录音
            </>
          )}
        </button>

        {error && <div className="volume-check-error">{error}</div>}

        {phase === "done" && norm !== null && minNorm > 0 && verdict && (
          <div className={`volume-check-verdict ${verdict.level}`}>
            <div className="volume-check-verdict-headline">
              {verdict.level === "ok" ? "✅ 声音够大！" : verdict.level === "close" ? "🙂 还差一点点" : "🔈 声音太小啦"}
            </div>
            <div className="volume-check-verdict-text">{verdict.text}</div>
            {verdict.level === "ok" ? (
              <div className="volume-check-verdict-tip">以后按住麦克风说话，就这样大声说，AI 就能听清啦。</div>
            ) : (
              <div className="volume-check-verdict-tip">
                试试靠近麦克风、张大嘴巴说，或者换一个安静一点的地方再测一次。
              </div>
            )}
          </div>
        )}

        {phase === "done" && norm !== null && minNorm === 0 && (
          <div className="volume-check-verdict neutral">
            <div className="volume-check-verdict-headline">本次音量 {norm}</div>
            <div className="volume-check-verdict-text">家长没有设置达标线，这里不做达标判定。</div>
            <div className="volume-check-verdict-tip">
              如果 AI 经常听不清你说话，可以请家长在「设置 → 发音评测」里打开「录音最低平均音量」。
            </div>
          </div>
        )}

        {phase === "done" && (
          <div className="volume-check-actions">
            {audioUrl && (
              <button onClick={togglePlayback}>
                {playing ? (
                  <>
                    <Square size={14} /> 停止播放
                  </>
                ) : (
                  <>
                    <Play size={14} /> 听听刚才的录音
                  </>
                )}
              </button>
            )}
            <button onClick={handleStart}>
              <RotateCcw size={14} /> 再测一次
            </button>
          </div>
        )}

        <div className="modal-actions">
          <button className="cancel" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

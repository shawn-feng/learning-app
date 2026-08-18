import { useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAudioRecorder } from "../hooks/useAudioRecorder";

export interface ToolCallState {
  id: string;
  name: string;
  argsPreview?: string;
  status: "running" | "done" | "error";
  resultPreview?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "ai";
  text: string;
  // 语音识别的原始录音（base64，webm/opus），可点击播放
  audio?: string;
  // 工作态：思考过程 + 工具调用（正式消息到达前显示）
  thinking?: string;
  tools?: ToolCallState[];
  working?: boolean;
}

interface Props {
  messages: ChatMessage[];
  onSend: (text: string, audio?: string) => void;
  disabled?: boolean;
  aiEmoji?: string;
  rate?: string;
}

// 工具调用的图标与动词展示
const TOOL_META: Record<string, { icon: string; verb: string }> = {
  read: { icon: "📖", verb: "读取文件" },
  write: { icon: "✏️", verb: "写入文件" },
  edit: { icon: "🔧", verb: "编辑文件" },
  display_content: { icon: "🎨", verb: "展示内容" },
  get_date: { icon: "📅", verb: "获取日期时间" },
  bash: { icon: "💻", verb: "执行命令" },
  grep: { icon: "🔍", verb: "搜索" },
  ls: { icon: "📂", verb: "列出目录" },
};

function toolMeta(name: string) {
  return TOOL_META[name] || { icon: "🔧", verb: name };
}

// 思考过程 + 工具调用详情（工作态与展开态共用）
function TraceDetails({ m }: { m: ChatMessage }) {
  return (
    <>
      {m.thinking && (
        <div className="think-item">
          <span className="think-icon">💭</span>
          <span className="think-body">
            <span className="think-verb">思考</span>
            <span className="think-text">{m.thinking}</span>
          </span>
        </div>
      )}
      {m.tools && m.tools.length > 0 && (
        <div className="tool-list">
          {m.tools.map((t) => {
            const meta = toolMeta(t.name);
            return (
              <div key={t.id} className={`tool-item ${t.status}`}>
                <span className="tool-icon">{meta.icon}</span>
                <span className="tool-body">
                  <span className="tool-verb">{meta.verb}</span>
                  {t.argsPreview && <span className="tool-arg">{t.argsPreview}</span>}
                  {t.status !== "running" && t.resultPreview && (
                    <span className="tool-result" title={t.resultPreview}>
                      {t.resultPreview}
                    </span>
                  )}
                </span>
                <span className="tool-status">
                  {t.status === "running" ? "⏳" : t.status === "error" ? "❌" : "✅"}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default function ChatWindow({ messages, onSend, disabled, aiEmoji, rate = "-30%" }: Props) {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  // 识别后未发送的录音（base64，webm/opus），在输入框上方预览播放
  const [pendingAudio, setPendingAudio] = useState("");
  // 正在播放用户语音气泡的消息 id
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);
  // 展开显示「思考过程 + 工具调用」的消息 id 集合
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const { recording, start, stop } = useAudioRecorder();

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    window.api.voiceConfigGet().then((r: any) => {
      if (r?.success) setVoiceEnabled(r.config.enabled);
    });
  }, []);

  function handleSend() {
    const text = input.trim();
    if (!text || disabled) return;
    const audio = pendingAudio || undefined;
    onSend(text, audio);
    setInput("");
    setPendingAudio("");
  }

  // base64（webm/opus）→ 播放。返回停止函数；endCallback 用于重置播放状态。
  function playAudioBase64(b64: string, endCallback: () => void) {
    audioRef.current?.pause(); // 停掉正在播放的（TTS 朗读或上一段语音）
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const blob = new Blob([bytes], { type: "audio/webm" });
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        endCallback();
        URL.revokeObjectURL(url);
      };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      void audio.play().catch(cleanup);
    } catch {
      endCallback();
    }
  }

  // 输入框上方预览：播放/停止刚识别的录音
  function togglePendingAudio() {
    if (playingAudioId === "__pending__") {
      audioRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }
    setPlayingAudioId("__pending__");
    playAudioBase64(pendingAudio, () => setPlayingAudioId(null));
  }

  // 播放用户消息气泡里附带的语音原文
  function toggleMessageAudio(m: ChatMessage) {
    if (playingAudioId === m.id) {
      audioRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }
    setPlayingAudioId(m.id);
    playAudioBase64(m.audio || "", () => setPlayingAudioId(null));
  }

  async function handlePressStart() {
    if (!voiceEnabled || disabled || transcribing) return;
    setVoiceError("");
    try {
      await start();
    } catch (e: any) {
      setVoiceError("无法访问麦克风");
    }
  }

  async function handlePressEnd() {
    const blob = await stop();
    // 无活跃录音（已停止过/从未开始）：静默返回，不提示
    if (!blob) return;
    if (blob.size < 200) {
      // 空/极短的 webm 容器（无音频帧），ffmpeg 无法解析
      setVoiceError("录音太短，请按住说完整的一句话再松手");
      return;
    }
    setTranscribing(true);
    try {
      const buf = await blob.arrayBuffer();
      const r = await window.api.voiceTranscribe(buf);
      if (r.success) {
        setInput((prev) => (prev ? prev + r.text : r.text));
        if (r.audio) setPendingAudio(r.audio);
      } else {
        // 显示具体错误原因（识别失败/无语音/服务不可用等），便于排查
        setVoiceError(r.error || "没听清，再试一次");
      }
    } catch (e: any) {
      setVoiceError("识别失败");
    } finally {
      setTranscribing(false);
    }
  }

  async function handleSpeak(m: ChatMessage) {
    if (speakingId === m.id) {
      audioRef.current?.pause();
      setSpeakingId(null);
      return;
    }
    audioRef.current?.pause();
    setSpeakingId(m.id);
    try {
      const r = await window.api.voiceTts(m.text, { rate });
      if (r.success && r.audio) {
        const blob = new Blob([r.audio], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          setSpeakingId(null);
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          setSpeakingId(null);
          URL.revokeObjectURL(url);
        };
        await audio.play();
      } else {
        setSpeakingId(null);
      }
    } catch (e: any) {
      setSpeakingId(null);
    }
  }

  function toggleTrace(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const inputPlaceholder = transcribing
    ? "识别中…"
    : recording
    ? "录音中… 松开结束"
    : "输入你的想法...";

  return (
    <div className="chat-window">
      <div className="chat-messages" ref={messagesRef}>
        {messages.length === 0 && (
          <div style={{ textAlign: "center", color: "#aaa", marginTop: 60 }}>
            你好！我是你的学习伙伴，想学什么都可以告诉我 😊
          </div>
        )}
        {messages.map((m) => {
          const hasTrace = !!(m.thinking || (m.tools && m.tools.length > 0));
          const traceOpen = expandedIds.has(m.id);
          return (
            <div key={m.id} className={`message ${m.role}`}>
              {m.role === "ai" && aiEmoji && (
                <span style={{ fontSize: 22, marginRight: 8, alignSelf: "flex-end" }}>{aiEmoji}</span>
              )}
              {m.role === "ai" && m.working ? (
                <div className="bubble working-bubble">
                  <div className="working-header">
                    <span className="working-spinner" />
                    <span className="working-label">
                      {m.tools && m.tools.length > 0 ? "正在使用工具…" : "正在思考…"}
                    </span>
                  </div>
                  <TraceDetails m={m} />
                </div>
              ) : m.role === "ai" ? (
                <>
                  <div className="bubble bubble-md">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        a: ({ node: _node, ...props }) => (
                          <a {...props} target="_blank" rel="noreferrer noopener" />
                        ),
                      }}
                    >
                      {m.text}
                    </ReactMarkdown>
                  </div>
                  {hasTrace && (
                    <button
                      className={`trace-btn ${traceOpen ? "active" : ""}`}
                      onClick={() => toggleTrace(m.id)}
                      title={traceOpen ? "收起思考过程" : "查看思考过程"}
                    >
                      🧠
                    </button>
                  )}
                  <button
                    className={`speak-btn ${speakingId === m.id ? "speaking" : ""}`}
                    onClick={() => handleSpeak(m)}
                    title="朗读"
                  >
                    {speakingId === m.id ? "⏹" : "🔊"}
                  </button>
                  {traceOpen && hasTrace && (
                    <div className="trace-detail">
                      <TraceDetails m={m} />
                    </div>
                  )}
                </>
              ) : (
                <>
                  <div className="bubble">{m.text}</div>
                  {m.audio && (
                    <button
                      className={`speak-btn ${playingAudioId === m.id ? "speaking" : ""}`}
                      onClick={() => toggleMessageAudio(m)}
                      title="播放语音"
                    >
                      {playingAudioId === m.id ? "⏹" : "🎤"}
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {voiceError && <div style={{ padding: "0 12px 4px", color: "#e53e3e", fontSize: 12 }}>{voiceError}</div>}

      {pendingAudio && (
        <div className="voice-preview">
          <span>🎤 已识别语音</span>
          <button
            className="voice-preview-play"
            onClick={togglePendingAudio}
            title="播放/停止录音"
          >
            {playingAudioId === "__pending__" ? "⏹ 停止" : "🔊 播放"}
          </button>
          <button
            className="voice-preview-clear"
            onClick={() => setPendingAudio("")}
            title="移除录音"
          >
            ✕
          </button>
        </div>
      )}

      <div className="chat-input">
        {voiceEnabled && (
          <button
            className={`mic-button ${recording ? "recording" : ""}`}
            onMouseDown={handlePressStart}
            onMouseUp={handlePressEnd}
            onMouseLeave={handlePressEnd}
            onTouchStart={handlePressStart}
            onTouchEnd={handlePressEnd}
            disabled={disabled || transcribing}
            title="按住说话"
          >
            🎤
          </button>
        )}
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={inputPlaceholder}
          rows={1}
          style={{ minHeight: 44 }}
        />
        <button onClick={handleSend} disabled={disabled}>
          {disabled ? "..." : "发送"}
        </button>
      </div>
    </div>
  );
}

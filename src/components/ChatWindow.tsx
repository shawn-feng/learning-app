import { useState, useRef, useEffect } from "react";
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
  // 工作态：思考过程 + 工具调用（正式消息到达前显示）
  thinking?: string;
  tools?: ToolCallState[];
  working?: boolean;
}

interface Props {
  messages: ChatMessage[];
  onSend: (text: string) => void;
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
  get_date: { icon: "📅", verb: "获取日期" },
  bash: { icon: "💻", verb: "执行命令" },
  grep: { icon: "🔍", verb: "搜索" },
  ls: { icon: "📂", verb: "列出目录" },
};

function toolMeta(name: string) {
  return TOOL_META[name] || { icon: "🔧", verb: name };
}

export default function ChatWindow({ messages, onSend, disabled, aiEmoji, rate = "-30%" }: Props) {
  const [input, setInput] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [speakingId, setSpeakingId] = useState<string | null>(null);
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
    onSend(text);
    setInput("");
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
    if (!recording) return;
    const blob = await stop();
    if (blob.size === 0) return;
    setTranscribing(true);
    try {
      const buf = await blob.arrayBuffer();
      const r = await window.api.voiceTranscribe(buf);
      if (r.success) {
        setInput((prev) => (prev ? prev + r.text : r.text));
      } else {
        setVoiceError("没听清，再试一次");
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
        {messages.map((m) => (
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

                {m.thinking && <div className="thinking-block">{m.thinking}</div>}

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
              </div>
            ) : (
              <div className="bubble">{m.text}</div>
            )}
            {m.role === "ai" && !m.working && (
              <button
                className={`speak-btn ${speakingId === m.id ? "speaking" : ""}`}
                onClick={() => handleSpeak(m)}
                title="朗读"
              >
                {speakingId === m.id ? "⏹" : "🔊"}
              </button>
            )}
          </div>
        ))}
      </div>

      {voiceError && <div style={{ padding: "0 12px 4px", color: "#e53e3e", fontSize: 12 }}>{voiceError}</div>}

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

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
  // 语音录音落盘后的相对路径（历史恢复的消息无 audio base64，靠此读取播放）
  audioPath?: string;
  // 工作态：思考过程 + 工具调用（正式消息到达前显示）
  thinking?: string;
  tools?: ToolCallState[];
  working?: boolean;
  // 消息发送时间（用户可见的时间戳，形如 HH:mm）
  time?: string;
  // 用户上传的图片附件（dataURL 预览 + 发送给视觉模型识别）
  attachments?: ImageAttachment[];
  // 用户上传的文本类文件（txt/md），气泡内显示文件名、可点击用本地程序打开
  textFiles?: TextFileAttachment[];
}

/** 用户上传的图片附件：dataURL 用于本会话预览与发送；path 为落盘后的相对路径（data/ 下） */
export interface ImageAttachment {
  dataUrl: string; // data:image/...;base64,...
  mime: string;
  name: string;
  path?: string;
}

/** 用户上传的文本类文件（txt/md）：直接读取全文，随消息一起进上下文 */
export interface TextFileAttachment {
  name: string;
  content: string;
  path?: string;
}

/** handleSend 的扩展选项：图片 / 文本文件随文本一起发出 */
export interface SendOptions {
  audio?: string;
  images?: ImageAttachment[];
  textFiles?: TextFileAttachment[];
}

// 消息时间戳（HH:mm）——各消息构造点统一调用，避免散落
export function nowTime(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Props {
  messages: ChatMessage[];
  onSend: (text: string, opts?: SendOptions) => void;
  disabled?: boolean;
  aiEmoji?: string;
  rate?: string;
  childId: string;
  /** 输入区上方的一次性提示（如「已切到视觉模型」），显示后由父组件负责清除 */
  notice?: string | null;
}

interface HistorySessionMeta {
  file: string;
  sessionId: string;
  createdAt: string;
  messageCount: number;
}

interface HistoryView {
  file: string;
  createdAt: string;
  messages: { role: "user" | "ai"; text: string; time?: string }[];
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

export default function ChatWindow({ messages, onSend, disabled, aiEmoji, rate = "+0%", childId, notice }: Props) {
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

  // 待发送附件：图片（dataURL 预览）+ 文本文件（文件名+全文）
  const [pendingImages, setPendingImages] = useState<ImageAttachment[]>([]);
  const [pendingTextFiles, setPendingTextFiles] = useState<TextFileAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState("");

  // 历史会话浏览（归档调阅，只读）
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sessions, setSessions] = useState<HistorySessionMeta[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [viewing, setViewing] = useState<HistoryView | null>(null);
  const [historyError, setHistoryError] = useState("");

  function formatHistoryDate(iso: string): string {
    if (!iso) return "未知时间";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "未知时间";
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  async function openHistory() {
    setHistoryOpen(true);
    setHistoryError("");
    setHistoryLoading(true);
    setViewing(null);
    try {
      const r: any = await window.api.piListSessions(childId);
      if (r?.success) setSessions(r.sessions || []);
      else setHistoryError(r?.error || "加载历史失败");
    } catch (e: any) {
      setHistoryError("加载历史失败");
    } finally {
      setHistoryLoading(false);
    }
  }

  async function selectSession(file: string) {
    setHistoryError("");
    const meta = sessions.find((s) => s.file === file);
    setViewing({ file, createdAt: meta?.createdAt ?? "", messages: [] });
    try {
      const r: any = await window.api.piGetSessionMessages(childId, file);
      if (r?.success) {
        setViewing({ file, createdAt: meta?.createdAt ?? "", messages: r.messages || [] });
      } else {
        setHistoryError(r?.error || "读取会话失败");
      }
    } catch (e: any) {
      setHistoryError("读取会话失败");
    }
  }

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
    // 允许「只发图片/文本文件、不带文字」也发送
    if ((!text && pendingImages.length === 0 && pendingTextFiles.length === 0) || disabled) return;
    const audio = pendingAudio || undefined;
    const opts: SendOptions = {};
    if (audio) opts.audio = audio;
    if (pendingImages.length) opts.images = pendingImages;
    if (pendingTextFiles.length) opts.textFiles = pendingTextFiles;
    onSend(text, opts);
    setInput("");
    setPendingAudio("");
    setPendingImages([]);
    setPendingTextFiles([]);
  }

  // ---- 文件上传（ISSUE-008）----
  function readFileAsDataURL(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  function readFileAsText(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as string);
      r.onerror = () => reject(r.error);
      r.readAsText(file);
    });
  }

  // 落盘上传文件到 data/children/<childId>/uploads/（失败不阻断，仅提示）
  async function persistUpload(file: File): Promise<string | undefined> {
    try {
      const buf = await file.arrayBuffer();
      const r: any = await window.api.saveUpload(childId, file.name, file.type || "application/octet-stream", buf);
      return r?.success ? (r.path as string) : undefined;
    } catch {
      return undefined;
    }
  }

  // 点击气泡里的附件：调用本地默认程序打开落盘文件（仅当已落盘，path 存在）
  async function openUploaded(relPath: string) {
    try {
      const r: any = await window.api.openUpload(childId, relPath);
      if (!r?.success) setFileError(r?.error || "打开文件失败");
    } catch {
      setFileError("打开文件失败");
    }
  }

  function handleFileButton() {
    fileInputRef.current?.click();
  }

  async function transcribeAudioFile(file: File) {
    setFileError("");
    try {
      const buf = await file.arrayBuffer();
      // 顺带落盘原始录音（失败不阻断转写）
      void persistUpload(file);
      const r: any = await window.api.voiceTranscribe(buf);
      if (r.success) {
        setInput((prev) => (prev ? prev + r.text : r.text));
      } else {
        setFileError(r.error || "音频识别失败");
      }
    } catch (e: any) {
      setFileError("音频识别失败");
    }
  }

  async function handleFilesSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setFileError("");
    for (const f of files) {
      if (f.type.startsWith("image/")) {
        try {
          const dataUrl = await readFileAsDataURL(f);
          // 落盘持久化（失败不阻断，仍可用 dataURL 预览/发送）
          const saved = await persistUpload(f).catch(() => undefined);
          setPendingImages((p) => [...p, { dataUrl, mime: f.type, name: f.name, path: saved }]);
        } catch (err: any) {
          setFileError(`读取图片失败：${f.name}${err?.name ? `（${err.name}）` : ""}`);
        }
      } else if (f.type.startsWith("audio/")) {
        await transcribeAudioFile(f);
      } else if (f.type === "text/plain" || /\.(txt|md)$/i.test(f.name)) {
        try {
          const content = await readFileAsText(f);
          const saved = await persistUpload(f).catch(() => undefined);
          setPendingTextFiles((p) => [...p, { name: f.name, content, path: saved }]);
        } catch (err: any) {
          setFileError(`读取文件失败：${f.name}${err?.name ? `（${err.name}）` : ""}`);
        }
      } else {
        setFileError(`暂不支持的文件类型：${f.name}`);
      }
    }
    // ⚠️ 必须在全部文件读取完成后再清空：提前置空 value 会使 File 对象脱离底层句柄，
    // 在 Chromium/Electron 下 FileReader 读取它报 NotFoundError（「找不到文件」）。
    e.target.value = "";
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

  // 播放用户消息气泡里附带的语音原文（实时消息用 base64；历史恢复的消息读落盘文件）
  async function toggleMessageAudio(m: ChatMessage) {
    if (playingAudioId === m.id) {
      audioRef.current?.pause();
      setPlayingAudioId(null);
      return;
    }
    setPlayingAudioId(m.id);
    if (m.audio) {
      playAudioBase64(m.audio, () => setPlayingAudioId(null));
      return;
    }
    if (m.audioPath) {
      try {
        const r: any = await window.api.readUpload(childId, m.audioPath);
        if (r?.success && r.data) {
          playAudioBase64(r.data, () => setPlayingAudioId(null));
        } else {
          setPlayingAudioId(null);
          setFileError(r?.error || "读取录音失败");
        }
      } catch {
        setPlayingAudioId(null);
      }
    }
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
    : "输入你的想法...（以 / 开头可触发命令，如 /help）";

  return (
    <div className="chat-window">
      <div className="chat-toolbar">
        <button
          className="history-toggle-btn"
          onClick={historyOpen ? () => setHistoryOpen(false) : openHistory}
          title="显示/隐藏历史会话"
        >
          📜 {historyOpen ? "关闭历史" : "历史会话"}
        </button>
      </div>

      {historyOpen && (
        <div className="history-panel">
          <div className="history-list">
            <div className="history-list-title">历史会话（重置前的归档）</div>
            {historyLoading && <div className="history-empty">加载中…</div>}
            {!historyLoading && sessions.length === 0 && (
              <div className="history-empty">暂无历史会话</div>
            )}
            {!historyLoading &&
              sessions.map((s) => (
                <button
                  key={s.file}
                  className={`history-item ${viewing?.file === s.file ? "active" : ""}`}
                  onClick={() => selectSession(s.file)}
                >
                  <span className="history-item-date">{formatHistoryDate(s.createdAt)}</span>
                  <span className="history-item-count">{s.messageCount} 条</span>
                </button>
              ))}
          </div>
          <div className="history-view">
            {historyError && <div className="history-error">{historyError}</div>}
            {!viewing && !historyError && (
              <div className="history-empty">← 选择左侧一个历史会话查看（只读）</div>
            )}
            {viewing && (
              <>
                <div className="history-view-title">
                  {formatHistoryDate(viewing.createdAt)} · 只读归档
                </div>
                {viewing.messages.length === 0 && (
                  <div className="history-empty">该会话没有可读消息</div>
                )}
                {viewing.messages.map((m, i) => (
                  <div key={i} className={`message ${m.role}`}>
                    {m.role === "ai" && aiEmoji && (
                      <span style={{ fontSize: 22, marginRight: 8, alignSelf: "flex-end" }}>
                        {aiEmoji}
                      </span>
                    )}
                    <div className={`bubble ${m.role === "ai" ? "bubble-md" : ""}`}>
                      {m.text}
                      {m.time && <div className="msg-time">{m.time}</div>}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

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
                  {m.time && <div className="msg-time">{m.time}</div>}
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
                    {m.time && <div className="msg-time">{m.time}</div>}
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
                  <div className="bubble">
                    {m.text}
                    {m.attachments && m.attachments.length > 0 && (
                      <div className="bubble-attachments">
                        {m.attachments.map((a, i) => (
                          <div key={i} className="bubble-file">
                            {a.dataUrl ? (
                              <img
                                src={a.dataUrl}
                                alt={a.name}
                                className="bubble-image"
                                onClick={() => a.path && openUploaded(a.path)}
                              />
                            ) : (
                              // 历史恢复的图片附件无 dataUrl，显示占位图标（仍可点击打开）
                              <span
                                className="bubble-file-thumb"
                                title={a.path ? "点击用本地程序打开" : "未保存到本地"}
                                onClick={() => a.path && openUploaded(a.path)}
                              >
                                🖼️
                              </span>
                            )}
                            <span
                              className="bubble-file-name"
                              title={a.path ? "点击用本地程序打开" : "未保存到本地"}
                              onClick={() => a.path && openUploaded(a.path)}
                            >
                              📎 {a.name}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {m.textFiles && m.textFiles.length > 0 && (
                      <div className="bubble-files">
                        {m.textFiles.map((t, i) => (
                          <div
                            key={i}
                            className={`bubble-file-row ${t.path ? "clickable" : ""}`}
                            title={t.path ? "点击用本地程序打开" : "未保存到本地"}
                            onClick={() => t.path && openUploaded(t.path)}
                          >
                            📄 {t.name}
                          </div>
                        ))}
                      </div>
                    )}
                    {m.time && <div className="msg-time">{m.time}</div>}
                  </div>
                  {(m.audio || m.audioPath) && (
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
      {fileError && <div style={{ padding: "0 12px 4px", color: "#e53e3e", fontSize: 12 }}>{fileError}</div>}
      {notice && <div className="chat-notice">{notice}</div>}

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

      {pendingImages.length > 0 && (
        <div className="attachment-preview">
          {pendingImages.map((img, i) => (
            <div key={i} className="attachment-thumb">
              <img src={img.dataUrl} alt={img.name} title={img.name} />
              <button
                className="attachment-remove"
                onClick={() => setPendingImages((p) => p.filter((_, j) => j !== i))}
                title="移除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {pendingTextFiles.length > 0 && (
        <div className="attachment-preview">
          {pendingTextFiles.map((t, i) => (
            <div key={i} className="attachment-file">
              <span title={t.name}>📄 {t.name}</span>
              <button
                className="attachment-remove"
                onClick={() => setPendingTextFiles((p) => p.filter((_, j) => j !== i))}
                title="移除"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="chat-input">
        <button
          className="upload-button"
          onClick={handleFileButton}
          disabled={disabled}
          title="上传文件（图片→识别 / 音频→转写 / txt·md→读取）"
        >
          📎
        </button>
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
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,audio/*,text/plain,.txt,.md"
          style={{ display: "none" }}
          onChange={handleFilesSelected}
        />
      </div>
    </div>
  );
}

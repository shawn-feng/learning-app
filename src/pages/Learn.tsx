import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { PanelLeftClose, PanelLeftOpen, Bot, Gauge, Settings, KeyRound, LogOut, BookOpen, BarChart3 } from "lucide-react";
import ChatWindow, { type ChatMessage, type ToolCallState, type SendOptions, type ImageAttachment, nowTime } from "../components/ChatWindow";
import MaterialsPanel, { type Material } from "../components/MaterialsPanel";
import LearningDashboard from "../components/LearningDashboard";
import ModelSelector from "../components/ModelSelector";

interface Props {
  child: any;
  onExit: () => void;
}

const AI_EMOJIS = ["🤖", "🦊", "🐱", "🐶", "🦉", "🐲", "🦄", "🌟", "🎓", "📚"];

// 朗读语速档位（对齐 wowenglish 偏好，默认 1.0x 正常语速）
const RATE_OPTIONS = [
  { label: "慢", value: "-50%", display: "0.5x" },
  { label: "标准", value: "-30%", display: "0.7x" },
  { label: "正常", value: "+0%", display: "1.0x" },
  { label: "快", value: "+30%", display: "1.3x" },
];

// 左侧展示页配置（可扩展：新增展示页只需在此追加一项 + 对应渲染组件）
type PanelViewKey = "materials" | "progress";
const PANEL_VIEWS: Array<{ key: PanelViewKey; icon: LucideIcon; label: string; desc: string }> = [
  { key: "materials", icon: BookOpen, label: "学习资料", desc: "AI 老师展示的课文、卡片、练习" },
  { key: "progress", icon: BarChart3, label: "学习进度看板", desc: "各学习主题的进度总览" },
];

let msgCounter = 0;
function nextId() {
  return `msg-${Date.now()}-${msgCounter++}`;
}

// 学习资料到达时间标签（MM-DD HH:mm）
function nowLabel() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 从会话历史文本中还原附件（与 handleSend 的附件标记格式一一对应）。
 * 发送时只把「【附件类型：文件名|相对路径】」存进会话历史，全文不进上下文；
 * 退出重进时据此把标记剥离、还原为附件条目（无 dataUrl/content，仅文件名 + 路径可点击打开）。
 * 同时剥离所有 [内部指令]（如语音识别误差前缀）——它们只发给 AI，不显示给孩子。
 */
function restoreAttachments(text: string): {
  text: string;
  attachments?: ImageAttachment[];
  textFiles?: TextFileAttachment[];
  audioPath?: string;
} {
  const attachments: ImageAttachment[] = [];
  const textFiles: TextFileAttachment[] = [];
  let audioPath: string | undefined;
  const cleaned = text
    // 先剥离 [内部指令文字]（语音误差前缀等），再处理附件标记
    .replace(/\[[^\]]*\]/g, "")
    .replace(/【附件音频：([^|】]+)\|([^】]+)】/g, (_m, _name: string, p: string) => {
      if (p && p !== "未保存") audioPath = p;
      return "";
    })
    .replace(/【附件图片：([^|】]+)\|([^】]+)】/g, (_m, name: string, p: string) => {
      if (p && p !== "未保存") attachments.push({ name, mime: "", dataUrl: "", path: p });
      return "";
    })
    .replace(/【附件文件：([^|】]+)\|([^】]+)】/g, (_m, name: string, p: string) => {
      if (p && p !== "未保存") textFiles.push({ name, content: "", path: p });
      return "";
    });
  return {
    text: cleaned.trim(),
    attachments: attachments.length ? attachments : undefined,
    textFiles: textFiles.length ? textFiles : undefined,
    audioPath,
  };
}

/** base64（webm/opus）→ ArrayBuffer（用于落盘） */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export default function Learn({ child, onExit }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const childIdRef = useRef(child.childId);
  // 输入区上方一次性提示（视觉模型切换等）
  const [visionNotice, setVisionNotice] = useState("");
  // 当前正在工作的 AI 消息 id（思考/工具/正式回复都更新到同一气泡）
  const workingIdRef = useRef<string | null>(null);
  // 学习资料保留数量上限（家长可配置），追加材料时按此截断
  const materialsLimitRef = useRef(20);

  // 左侧展示页切换
  const [view, setView] = useState<PanelViewKey>("materials");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const currentView = PANEL_VIEWS.find((v) => v.key === view) || PANEL_VIEWS[0];

  // Sidebar collapse
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // TTS 语速（默认正常 1.0x）
  const [rate, setRate] = useState("+0%");

  // AI Agent settings
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiName, setAiName] = useState(child.aiName);
  const [aiEmoji, setAiEmoji] = useState(child.aiEmoji || "🤖");
  const [aiPersonality, setAiPersonality] = useState(child.aiPersonality);
  const [aiSettingsMsg, setAiSettingsMsg] = useState("");

  // Change password
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changePwdMsg, setChangePwdMsg] = useState("");

  useEffect(() => {
    setAiName(child.aiName);
    setAiEmoji(child.aiEmoji || "🤖");
    setAiPersonality(child.aiPersonality);
  }, [child.aiName, child.aiEmoji, child.aiPersonality]);

  useEffect(() => {
    childIdRef.current = child.childId;
    window.api.piStartChild(child.childId).then((r: any) => {
      if (r?.success) {
        if (Array.isArray(r.history) && r.history.length > 0) {
          setMessages(
            r.history.map((m: any) => {
              const restored = restoreAttachments(typeof m.text === "string" ? m.text : "");
              return {
                id: nextId(),
                role: m.role === "user" ? "user" : "ai",
                text: restored.text,
                // 附件只还原在用户消息上
                attachments: m.role === "user" ? restored.attachments : undefined,
                textFiles: m.role === "user" ? restored.textFiles : undefined,
                audioPath: m.role === "user" ? restored.audioPath : undefined,
                time: m.time || nowLabel(),
                // ISSUE-018: 恢复 AI 消息的思考过程与工具调用记录（与实时气泡一致，点 🧠 展开查看）
                thinking: m.role === "ai" ? m.thinking : undefined,
                tools: m.role === "ai" ? m.tools : undefined,
              };
            })
          );
        }
        // 恢复学习资料列表（退出再进入不丢失；主进程已按 limit 截断）。
        // 自动打开最新一份由下方统一的 materials 监听 effect 处理（ISSUE-014），这里只负责回填。
        if (Array.isArray(r.materials)) {
          setMaterials(r.materials);
        }
        if (typeof r.materialsLimit === "number" && r.materialsLimit > 0) {
          materialsLimitRef.current = r.materialsLimit;
        }
      } else {
        console.error("Failed to start session:", r?.error);
      }
    });
  }, [child.childId]);

  // 更新当前工作气泡（按 id 定位）
  const patchWorking = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const id = workingIdRef.current;
    if (!id) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  // 思考增量（已由主进程节流）
  const handleThinking = useCallback((data: { childId: string; delta: string }) => {
    if (data.childId !== childIdRef.current) return;
    patchWorking((m) => ({ ...m, thinking: (m.thinking || "") + data.delta }));
  }, [patchWorking]);

  // 工具开始调用
  const handleToolStart = useCallback((data: any) => {
    if (data.childId !== childIdRef.current) return;
    const call: ToolCallState = {
      id: data.toolCallId || `tool-${Date.now()}`,
      name: data.toolName,
      argsPreview: data.argsPreview,
      status: "running",
    };
    patchWorking((m) => ({ ...m, tools: [...(m.tools || []), call] }));
  }, [patchWorking]);

  // ISSUE-014（核心修复）：AI 展示新材料（display_content）或恢复历史后，自动打开最新一份资料。
  // ⚠️ 不能像旧实现那样在 setMaterials 的 updater 里给外部变量赋值、再同步读取——React 18 中
  // updater 异步执行（render 阶段才跑），同步检查时变量必然还是 null，导致「自动弹开」从未生效
  // （会话中第二份资料到达时左侧停留在上一份）。统一监听 materials 变化，渲染后最新状态已就绪，
  // 自动选中末尾（最新）一条；去重时 updater 返回原引用、effect 不触发，用户返回列表也不被打断。
  useEffect(() => {
    if (materials.length === 0) return;
    setSelectedMaterialId(materials[materials.length - 1].id);
  }, [materials]);

  // 工具结束调用 + 学习资料列表更新
  const handleToolEnd = useCallback((data: any) => {
    if (data.childId !== childIdRef.current) return;
    if (data.toolName === "display_content") {
      const panel = data.result?.details?.panelContent;
      if (panel) {
        const filePath = panel.filePath;
        setMaterials((prev) => {
          // 去重：同一份资料（同一 filePath）已在面板里，则不再重复添加，
          // 避免「每步都重发学习资料」导致面板堆积重复。
          if (filePath && prev.some((m) => m.filePath === filePath)) {
            return prev;
          }
          const id = nextId();
          const next = [
            ...prev,
            {
              id,
              format: "html" as const,
              content: panel.content,
              title: panel.title,
              time: nowLabel(),
              filePath,
            },
          ];
          const lim = materialsLimitRef.current;
          return lim > 0 ? next.slice(-lim) : next;
        });
        // 自动打开由上方 materials 监听 effect 统一处理（新条目追加后自动选中）
      }
    }
    patchWorking((m) => ({
      ...m,
      tools: (m.tools || []).map((t) =>
        t.id === data.toolCallId
          ? {
              ...t,
              status: data.isError ? "error" : "done",
              resultPreview: data.resultPreview,
            }
          : t
      ),
    }));
  }, [patchWorking]);

  // 正式回复到达 —— 在同一个气泡里替换为正式消息
  const handleReply = useCallback((data: { childId: string; text: string }) => {
    if (data.childId !== childIdRef.current) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id
            ? { ...m, text: data.text, working: false }
            : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: data.text, time: nowTime() }];
    });
    setBusy(false);
  }, []);

  const handleReplyEnd = useCallback(() => {
    workingIdRef.current = null;
    setBusy(false);
  }, []);

  const handleReplyError = useCallback((data: { childId: string; error: string }) => {
    if (data.childId !== childIdRef.current) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id
            ? { ...m, text: `⚠️ ${data.error}`, working: false }
            : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: `⚠️ ${data.error}`, time: nowTime() }];
    });
    setBusy(false);
  }, []);

  // 定时任务触发的会话重置：清空当前孩子的会话与资料面板
  const handleSessionReset = useCallback((data: { childId: string }) => {
    if (data.childId !== childIdRef.current) return;
    setMessages([
      { id: nextId(), role: "ai", text: "🔄 会话已被自动重置（定时任务），我们重新开始吧！", time: nowTime() },
    ]);
    setMaterials([]);
    setSelectedMaterialId(null);
    workingIdRef.current = null;
    setBusy(false);
  }, []);

  // 图片上传时主进程自动切到视觉模型 → 输入区上方提示一次（6 秒后自动消失）
  const handleVisionSwitched = useCallback((data: { childId: string; modelId: string }) => {
    if (data.childId !== childIdRef.current) return;
    setVisionNotice("🖼️ 已自动切换到视觉模型来识别图片");
    window.setTimeout(() => setVisionNotice(""), 6000);
  }, []);

  useEffect(() => {
    window.api.onPiReply(handleReply);
    window.api.onPiReplyEnd(handleReplyEnd);
    window.api.onPiReplyError(handleReplyError);
    window.api.onPiThinking(handleThinking);
    window.api.onPiToolStart(handleToolStart);
    window.api.onPiToolEnd(handleToolEnd);
    window.api.onPiSessionReset(handleSessionReset);
    window.api.onPiVisionModelSwitched(handleVisionSwitched);
    return () => {
      window.api.piRemoveListeners();
    };
  }, [handleReply, handleReplyEnd, handleReplyError, handleThinking, handleToolStart, handleToolEnd, handleSessionReset, handleVisionSwitched]);

  // 向聊天追加一条 AI 消息（命令反馈 / 系统提示用）
  function addAiMessage(text: string) {
    setMessages((prev) => [...prev, { id: nextId(), role: "ai", text, time: nowTime() }]);
    setBusy(false);
    workingIdRef.current = null;
  }

  // 命令清单（以 / 开头触发，为后续更多命令预留）
  const COMMANDS: Record<string, { desc: string }> = {
    reset: { desc: "重置会话：清空当前对话和学习资料面板，重新开始" },
    help: { desc: "查看可用命令" },
  };

  function showHelp() {
    const lines = ["📖 可用命令："];
    for (const [name, info] of Object.entries(COMMANDS)) {
      lines.push(`  /${name} —— ${info.desc}`);
    }
    addAiMessage(lines.join("\n"));
  }

  // 处理 /reset 命令：清空会话上下文与学习资料面板
  async function runResetCommand() {
    setBusy(true);
    try {
      const r = await window.api.piReset(child.childId);
      if (r?.success) {
        setMessages([
          { id: nextId(), role: "ai", text: "✅ 会话已重置，我们重新开始吧！有什么想学的吗？😊", time: nowTime() },
        ]);
        setMaterials([]);
        setSelectedMaterialId(null);
        workingIdRef.current = null;
        setBusy(false);
      } else {
        addAiMessage(`⚠️ 重置失败：${r?.error || "未知错误"}`);
      }
    } catch (e: any) {
      addAiMessage(`⚠️ 重置失败：${e?.message || "网络错误"}`);
    }
  }

  // 命令解析：以 / 开头的输入走命令分支，否则作为普通消息发送
  async function handleCommand(raw: string) {
    const parts = raw.slice(1).split(/\s+/).filter(Boolean);
    const name = (parts[0] || "").toLowerCase();
    switch (name) {
      case "reset":
        await runResetCommand();
        break;
      case "help":
        showHelp();
        break;
      default:
        addAiMessage(`❓ 未知命令「/${name}」。输入 /help 查看可用命令。`);
    }
  }

  async function handleSend(text: string, opts?: SendOptions) {
    const trimmed = text.trim();
    // 命令拦截：以 / 开头即触发命令（为后续更多命令预留），不发送给 AI
    if (trimmed.startsWith("/")) {
      await handleCommand(trimmed);
      return;
    }
    const images = opts?.images || [];
    const textFiles = opts?.textFiles || [];
    // 语音输入：先把录音落盘（历史恢复时据此播放），失败不影响发送。
    // 多段（ISSUE-021）由主进程 voice:merge 拼接成单个 WAV；单段沿用原 saveUpload。
    let audioPath: string | undefined;
    let audioData: string | undefined;
    if (opts?.audios && opts.audios.length) {
      if (opts.audios.length === 1) {
        audioData = opts.audios[0];
        try {
          const buf = base64ToArrayBuffer(opts.audios[0]);
          const r: any = await window.api.saveUpload(child.childId, "语音录音.webm", "audio/webm", buf);
          if (r?.success) audioPath = r.path as string;
        } catch {
          /* 落盘失败不影响发送 */
        }
      } else {
        try {
          const r: any = await window.api.voiceMerge(child.childId, opts.audios);
          if (r?.success) {
            audioPath = r.path as string;
            audioData = r.data as string;
          }
        } catch {
          /* 合并失败不影响发送（可降级为不带录音） */
        }
      }
    } else if (opts?.audio) {
      // 兼容旧调用方单段路径
      audioData = opts.audio;
      try {
        const buf = base64ToArrayBuffer(opts.audio);
        const r: any = await window.api.saveUpload(child.childId, "语音录音.webm", "audio/webm", buf);
        if (r?.success) audioPath = r.path as string;
      } catch {
        /* 落盘失败不影响发送 */
      }
    }
    const userMsg: ChatMessage = {
      id: nextId(),
      role: "user",
      text,
      audio: audioData,
      audioPath,
      attachments: images.length ? images : undefined,
      textFiles: textFiles.length ? textFiles : undefined,
      time: nowTime(),
    };
    const workingMsg: ChatMessage = {
      id: nextId(),
      role: "ai",
      text: "",
      thinking: "",
      tools: [],
      working: true,
      time: nowTime(),
    };
    workingIdRef.current = workingMsg.id;
    setMessages((prev) => [...prev, userMsg, workingMsg]);
    setBusy(true);
    try {
      // 拼接发给 AI 的正文：语音注明识别误差来源；附件用可逆标记（文件名|相对路径），
      // 文件全文不进 prompt（避免全文被存进会话历史、退出重进时原文显示在气泡里）；
      // AI 需要内容时用 read 工具读 uploads 目录下的落盘文件。
      // 标记格式同时是前端「历史恢复还原附件」的依据，改动需与 restoreAttachments 同步。
      const parts: string[] = [];
      // 语音输入：prompt 里注明识别误差来源（[] 内容恢复时不显示）
      if (audioData) {
        parts.push(
          "[语音识别输入，可能存在同音字/断句等识别错误，请结合上下文理解并推理出正确内容]"
        );
      }
      parts.push(text);
      // save_upload 返回 children/<childId>/uploads/xx（相对 data/），AI 的 cwd 是 childDir，
      // 转为相对 childDir 的 uploads/xx 路径（未落盘时为「未保存」）。
      // 注意：这里只放附件标记，不放任何给 AI 的指令文字——指令文字会随消息存进会话历史、
      // 退出重进时原样显示在气泡里；附件处理规则已写在 AGENTS.md（LEARNING_NAV_INSTRUCTIONS）。
      const toRel = (p?: string) => (p ? p.replace(/^children\/[^/]+\//, "") : "未保存");
      if (audioData) {
        const audioName = audioPath ? audioPath.split("/").pop() || "语音录音" : "语音录音";
        parts.push(`【附件音频：${audioName}|${toRel(audioPath)}】`);
      }
      for (const img of images) {
        parts.push(`【附件图片：${img.name}|${toRel(img.path)}】`);
      }
      for (const f of textFiles) {
        parts.push(`【附件文件：${f.name}|${toRel(f.path)}】`);
      }
      const promptText = parts.join("\n");
      // dataURL → SDK ImageContent（剥离前缀，内联 base64 发送，不落盘）
      const sdkImages = images.map((img) => {
        const comma = img.dataUrl.indexOf(",");
        return {
          type: "image" as const,
          mimeType: img.mime,
          data: comma >= 0 ? img.dataUrl.slice(comma + 1) : img.dataUrl,
        };
      });
      const result = await window.api.piPrompt(
        child.childId,
        promptText,
        sdkImages.length ? sdkImages : undefined
      );
      if (!result.success) {
        // 若 pi:reply_error 已处理则 workingIdRef 已清空，跳过
        const id = workingIdRef.current;
        if (id) {
          workingIdRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? { ...m, text: `⚠️ ${result.error || "发送失败"}`, working: false }
                : m
            )
          );
          setBusy(false);
        }
      }
    } catch (e: any) {
      const id = workingIdRef.current;
      if (id) {
        workingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, text: `⚠️ ${e.message || "网络错误"}`, working: false }
              : m
          )
        );
        setBusy(false);
      }
    }
  }

  function handleExit() {
    window.api.piDispose(child.childId);
    onExit();
  }

  async function handleSaveAiSettings() {
    setAiSettingsMsg("");
    try {
      const result = await window.api.childUpdateProfile(child.childId, {
        aiName,
        aiEmoji,
        aiPersonality,
      });
      if (result.success) {
        child.aiName = aiName;
        child.aiEmoji = aiEmoji;
        child.aiPersonality = aiPersonality;
        setAiSettingsMsg("已保存");
        setShowAiSettings(false);
      } else {
        setAiSettingsMsg(result.error || "保存失败");
      }
    } catch (e: any) {
      setAiSettingsMsg(e.message || "保存失败");
    }
  }

  async function handleChangePassword() {
    setChangePwdMsg("");
    if (!oldPassword || !newPassword) {
      setChangePwdMsg("请填写旧密码和新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePwdMsg("两次输入的新密码不一致");
      return;
    }
    const result = await window.api.childChangePassword(child.childId, oldPassword, newPassword);
    if (result.success) {
      setChangePwdMsg("密码已修改");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowChangePassword(false);
    } else {
      setChangePwdMsg(result.error || "修改失败");
    }
  }

  return (
    <div className="learn-page">
      <div className="learn-main">
        <div className={`learn-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

          <div className="sidebar-profile">
            <div className="sidebar-avatar" title={child.name}>{child.avatar}</div>
            {!sidebarCollapsed && (
              <>
                <div className="sidebar-name">{child.name}</div>
                <div className="sidebar-ai">
                  {aiEmoji} {aiName}
                </div>
                <div className="sidebar-sub">我的学习伙伴</div>
              </>
            )}
          </div>

          <div
            className="view-switcher"
            onMouseEnter={() => setViewMenuOpen(true)}
            onMouseLeave={() => setViewMenuOpen(false)}
          >
            <button
              className={`sidebar-btn view-switcher-btn ${viewMenuOpen ? "open" : ""}`}
              title="切换展示页"
            >
              <currentView.icon size={18} className="sidebar-btn-icon" />
              {!sidebarCollapsed && <span className="view-switcher-caret">▾</span>}
            </button>

            {viewMenuOpen && (
              <div className="view-switcher-popover">
                <div className="view-switcher-title">切换展示页</div>
                {PANEL_VIEWS.map((v) => (
                  <button
                    key={v.key}
                    className={`view-option ${view === v.key ? "active" : ""}`}
                    onClick={() => {
                      setView(v.key);
                      setViewMenuOpen(false);
                    }}
                  >
                    <span className="view-option-icon"><v.icon size={18} /></span>
                    <span className="view-option-body">
                      <span className="view-option-label">{v.label}</span>
                      <span className="view-option-desc">{v.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-model">
            {sidebarCollapsed && (
              <button
                className="sidebar-icon-btn"
                title="模型"
                onClick={() => setSidebarCollapsed(false)}
              >
                <Bot size={20} />
              </button>
            )}
            {/* 保持 ModelSelector 常驻挂载，折叠时仅用 CSS 隐藏，避免卸载后重新挂载时重置为默认模型 */}
            <div
              className="sidebar-model-body"
              style={{ display: sidebarCollapsed ? "none" : "block", width: "100%" }}
            >
              <div className="sidebar-section-label">模型</div>
              <ModelSelector childId={child.childId} />
            </div>
          </div>

          <div className="sidebar-rate">
            {sidebarCollapsed ? (
              <button
                className="sidebar-icon-btn"
                title={`朗读语速 ${RATE_OPTIONS.find((o) => o.value === rate)?.display || "1.0x"}`}
                onClick={() => setSidebarCollapsed(false)}
              >
                <Gauge size={20} />
              </button>
            ) : (
              <>
                <div className="sidebar-section-label">朗读语速</div>
                <div className="rate-grid">
                  {RATE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`rate-btn ${rate === opt.value ? "active" : ""}`}
                      onClick={() => setRate(opt.value)}
                      title={`${opt.label} ${opt.display}`}
                    >
                      {opt.display}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="sidebar-menu">
            <button
              className="sidebar-btn"
              title="AI 伙伴设置"
              onClick={() => {
                setAiSettingsMsg("");
                setShowAiSettings(true);
              }}
            >
              <Settings size={18} className="sidebar-btn-icon" />
            </button>
            <button
              className="sidebar-btn"
              title="修改密码"
              onClick={() => {
                setChangePwdMsg("");
                setOldPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setShowChangePassword(true);
              }}
            >
              <KeyRound size={18} className="sidebar-btn-icon" />
            </button>
          </div>

          <div className="sidebar-footer">
            <button className="sidebar-btn danger" title="退出" onClick={handleExit}>
              <LogOut size={18} className="sidebar-btn-icon" />
            </button>
          </div>
        </div>

        <div className="learn-body">
          {view === "materials" ? (
            <MaterialsPanel
              materials={materials}
              selectedId={selectedMaterialId}
              onOpen={setSelectedMaterialId}
              onBack={() => setSelectedMaterialId(null)}
            />
          ) : (
            <LearningDashboard childId={child.childId} />
          )}
          <ChatWindow messages={messages} onSend={handleSend} disabled={busy} aiEmoji={aiEmoji} rate={rate} childId={child.childId} notice={visionNotice || null} />
        </div>
      </div>

      {showAiSettings && (
        <div className="modal-overlay" onClick={() => setShowAiSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>AI 伙伴设置</h2>
            {aiSettingsMsg && (
              <div style={{ marginBottom: 12, color: aiSettingsMsg.includes("失败") ? "red" : "#48bb78" }}>
                {aiSettingsMsg}
              </div>
            )}

            <label>AI 伙伴名字</label>
            <input
              value={aiName}
              onChange={(e) => setAiName(e.target.value)}
              placeholder="如：知识狐"
            />

            <label>AI 伙伴 Emoji</label>
            <div className="avatar-picker">
              {AI_EMOJIS.map((e) => (
                <div
                  key={e}
                  className={`avatar-option ${aiEmoji === e ? "selected" : ""}`}
                  onClick={() => setAiEmoji(e)}
                >
                  {e}
                </div>
              ))}
            </div>

            <label>AI 伙伴性格</label>
            <textarea
              value={aiPersonality}
              onChange={(e) => setAiPersonality(e.target.value)}
              placeholder="如：温和耐心，喜欢用故事引导"
              style={{
                width: "100%",
                padding: 10,
                border: "1px solid #ddd",
                borderRadius: 8,
                marginBottom: 12,
                minHeight: 60,
              }}
            />

            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowAiSettings(false)}>
                取消
              </button>
              <button className="confirm" onClick={handleSaveAiSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showChangePassword && (
        <div className="modal-overlay" onClick={() => setShowChangePassword(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>修改密码</h2>
            {changePwdMsg && (
              <div style={{ marginBottom: 12, color: changePwdMsg.includes("已修改") ? "#48bb78" : "red" }}>
                {changePwdMsg}
              </div>
            )}

            <label>旧密码</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="输入当前密码"
            />

            <label>新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="输入新密码"
            />

            <label>确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
            />

            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowChangePassword(false)}>
                取消
              </button>
              <button className="confirm" onClick={handleChangePassword}>
                确认修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

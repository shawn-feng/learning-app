import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { PanelLeftClose, PanelLeftOpen, PanelRightOpen, PanelRightClose, Bot, Gauge, Type, CalendarClock, Settings, KeyRound, LogOut, BookOpen, BarChart3, MessageSquare } from "lucide-react";
import ChatWindow, { type ChatMessage, type ToolCallState, type SendOptions, type ImageAttachment, nowTime } from "../components/ChatWindow";
import MaterialsPanel, { type Material } from "../components/MaterialsPanel";
import LearningDashboard from "../components/LearningDashboard";
import ModelSelector from "../components/ModelSelector";
import { useChatPanel } from "../hooks/useChatPanel";
import type { MaterialsPanelHandle, PageAction, PageEvent, PageExecResultUplink } from "../lib/page-bridge";

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

// ISSUE-023：孩子聊天字号档位（默认 30px = ISSUE-009 放大一倍档；16~64px 均可，离散档位低龄友好）
const FONT_OPTIONS = [
  { label: "小", px: 22, display: "22" },
  { label: "中", px: 30, display: "30" },
  { label: "大", px: 38, display: "38" },
  { label: "特大", px: 46, display: "46" },
];
const DEFAULT_FONT_PX = 30;

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

// ISSUE-019：课程提醒铃声——Web Audio 合成「叮—咚」双音（无需捆绑音频资源文件，打包无忧）
function playChime() {
  try {
    const Ctor: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const now = ctx.currentTime;
    const notes = [
      { f: 880, t: 0, d: 0.35 }, // A5 叮
      { f: 1174.66, t: 0.28, d: 0.5 }, // D6 咚
    ];
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = n.f;
      gain.gain.setValueAtTime(0.0001, now + n.t);
      gain.gain.exponentialRampToValueAtTime(0.6, now + n.t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.t + n.d);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d + 0.05);
    }
    window.setTimeout(() => {
      ctx.close().catch(() => {});
    }, 1500);
  } catch {
    /* 无音频设备 / 被策略拒绝时静默（横幅仍会显示） */
  }
}

// ISSUE-019：课程提醒语音播报——与资料/聊天同一条 edge-tts 链路（音色一致）。
// 横幅常驻期间会循环播报（15s 间隔），用锁防上一轮未播完时下一轮重复合成/重叠。
let reminderSpeaking = false;
async function speakReminder(text: string): Promise<void> {
  if (reminderSpeaking) return;
  reminderSpeaking = true;
  const release = () => {
    reminderSpeaking = false;
  };
  try {
    const r = await window.api.voiceTts(text, {});
    if (!r.success || !r.audio) {
      release();
      return;
    }
    const blob = new Blob([r.audio], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => {
      URL.revokeObjectURL(url);
      release();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      release();
    };
    await audio.play();
  } catch {
    release();
  }
}

/** ISSUE-019：按提醒方式播报一次（铃声 + 语音），横幅首次与循环共用 */
function playReminderAlert(mode: "both" | "chime" | "voice", type: "start" | "end", label: string): void {
  if (mode === "both" || mode === "chime") playChime();
  if (mode === "both" || mode === "voice") {
    const text =
      type === "start"
        ? label
          ? `${label}上课时间到啦，请开始学习吧！`
          : "上课时间到啦，请开始学习吧！"
        : label
          ? `${label}下课啦，休息一下吧！`
          : "下课啦，休息一下吧！";
    void speakReminder(text);
  }
}

/** ISSUE-019：孩子左侧边栏「今日课程」——实时时钟 + 当天课程时间段（上课-下课）。
 *  独立组件：每秒时钟只重渲染自身，避免整个 Learn 每帧 diff；
 *  配置经 scheduler:config:get 取当前孩子的 classTimes（家长在定时任务里配置）。 */
function SidebarClassSchedule({
  childId,
  collapsed,
  onExpand,
}: {
  childId: string;
  collapsed: boolean;
  onExpand: () => void;
}) {
  const [classTimes, setClassTimes] = useState<{ start: string; end: string; label?: string }[]>([]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    window.api
      .schedulerConfigGet()
      .then((res: any) => {
        if (!alive || !res?.success) return;
        const cfg = res.configs?.[childId];
        setClassTimes(Array.isArray(cfg?.classTimes) ? cfg.classTimes : []);
      })
      .catch(() => {
        /* 取配置失败保持空 */
      });
    return () => {
      alive = false;
    };
  }, [childId]);

  // 当前时间：每秒刷新（独立组件内，不会拖累父组件）
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);

  if (collapsed) {
    return (
      <button className="sidebar-icon-btn" title="今日课程安排" onClick={onExpand}>
        <CalendarClock size={20} />
      </button>
    );
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return (
    <>
      <div className="sidebar-section-label">今日课程</div>
      <div className="sidebar-clock">{clock}</div>
      {classTimes.length === 0 ? (
        <div className="sidebar-class-empty">今天没有课程安排</div>
      ) : (
        classTimes.map((ct, i) => (
          <div className="sidebar-class-row" key={i}>
            <span className="sidebar-class-time">
              {ct.start} - {ct.end}
            </span>
            {ct.label && <span className="sidebar-class-label">{ct.label}</span>}
          </div>
        ))
      )}
    </>
  );
}

export default function Learn({ child, onExit }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const childIdRef = useRef(child.childId);
  // ISSUE-019：课程时间段提醒横幅（上课/下课；顶部 1/3 区域，常驻到点击关闭；含提醒方式）
  const [classReminder, setClassReminder] = useState<{
    type: "start" | "end";
    label: string;
    mode: "both" | "chime" | "voice";
  } | null>(null);
  // 输入区上方一次性提示（视觉模型切换等）
  const [visionNotice, setVisionNotice] = useState("");
  // 当前正在工作的 AI 消息 id（思考/工具/正式回复都更新到同一气泡）
  const workingIdRef = useRef<string | null>(null);
  // 学习资料保留数量上限（家长可配置），追加材料时按此截断
  const materialsLimitRef = useRef(20);
  // 资料面板句柄（iframe 互动上报 + 下行指令执行）
  const materialsPanelRef = useRef<MaterialsPanelHandle | null>(null);

  // 左侧展示页切换
  const [view, setView] = useState<PanelViewKey>("materials");
  // ISSUE-020：浮层关闭用 ~180ms 延时（鼠标从按钮穿越缝隙到浮层有容错时间），按钮也可点击切换
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const viewSwitcherRef = useRef<HTMLDivElement | null>(null);
  const viewMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const currentView = PANEL_VIEWS.find((v) => v.key === view) || PANEL_VIEWS[0];

  // Sidebar collapse
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  // ISSUE-008/016：中间展示区可折叠（收起后聊天区占更多空间），学习资料/学习进度等所有展示页通用；
  // display_content 时自动展开（见下方 materials 监听 effect）
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  // 右侧聊天面板：可折叠 + 拖拽调宽（宽度/折叠状态持久化，与家长端互不干扰）
  const chat = useChatPanel("child", 440);

  // TTS 语速（默认正常 1.0x）
  const [rate, setRate] = useState("+0%");

  // ISSUE-023：孩子聊天字号（默认 30px；按 childId 持久化，跨刷新保留）
  const [fontSize, setFontSize] = useState(DEFAULT_FONT_PX);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`chat:${child.childId}:fontSize`);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= 16 && n <= 64) setFontSize(n);
      }
    } catch {
      /* localStorage 不可用则保持默认 */
    }
  }, [child.childId]);
  const handleFontSize = (px: number) => {
    setFontSize(px);
    try {
      localStorage.setItem(`chat:${child.childId}:fontSize`, String(px));
    } catch {
      /* 持久化失败不影响本次生效 */
    }
  };

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

  // ISSUE-020：点击浮层外部关闭「切换展示页」菜单（真下拉语义，低龄孩子更易选中）
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (viewSwitcherRef.current && !viewSwitcherRef.current.contains(e.target as Node)) {
        setViewMenuOpen(false);
      }
    };
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  // ISSUE-020：卸载时清理浮层关闭延时定时器
  useEffect(() => {
    return () => {
      if (viewMenuTimerRef.current) clearTimeout(viewMenuTimerRef.current);
    };
  }, []);

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
    // ISSUE-008/016：AI 展示新材料（display_content）时自动展开展示区（即便当前折叠）
    setPanelCollapsed(false);
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
          const lim = materialsLimitRef.current;
          // ISSUE-021：同 path 重发 → 就地替换内容/标题/时间并**移到列表末尾（最新位置）**，
          // 返回新数组引用 → 下方 materials 监听 effect 触发 → 自动重新选中该项。
          // ⚠️ 绝不能用「完全重复就不显示」：即使内容 100% 相同，最近一次 display_content
          // 的那份也必须重新选中并显示在最新位置（用户 2026-08-31 明确约束）。
          // 去重仅用于避免同一轮内多份同 path 堆积成 N 条。
          if (filePath && prev.some((m) => m.filePath === filePath)) {
            const updated = prev.map((m) =>
              m.filePath === filePath
                ? { ...m, content: panel.content, title: panel.title || m.title, time: nowLabel() }
                : m
            );
            const moved = updated.filter((m) => m.filePath !== filePath).concat(updated.filter((m) => m.filePath === filePath));
            return lim > 0 ? moved.slice(-lim) : moved;
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

  // 停止当前轮的 agent 运行（发送按钮变为停止按钮后点击触发）：
  // 前端立即收尾工作气泡（避免后续 pi:reply/error 事件追加多余气泡），再通知主进程 abort。
  const handleStop = useCallback(async () => {
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setBusy(false);
    if (id) {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, text: "⏹ 已停止", working: false } : m))
      );
    }
    try {
      await window.api.piAbort(child.childId);
    } catch {
      /* abort 失败忽略（prompt 可能已结束） */
    }
  }, [child.childId]);

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

  // ISSUE-019：课程时间段提醒（家长在定时任务里按孩子配置；到点主进程广播）
  const handleClassReminder = useCallback(
    (data: { childId: string; type: "start" | "end"; label: string; mode?: "both" | "chime" | "voice" }) => {
      if (data.childId !== childIdRef.current) return;
      const mode = data.mode || "both";
      setClassReminder({ type: data.type, label: data.label, mode });
      // 首次立即播报（铃声/语音）；横幅常驻期间由下方 effect 每 15s 循环重复
      playReminderAlert(mode, data.type, data.label);
    },
    []
  );

  // ⚠️ 提醒横幅【不自动消失】——一直显示到孩子点击才关闭（用户 2026-08-31 要求；
  // 横幅内已注明「点击关闭提示」，点击任意处 setClassReminder(null)）
  // 横幅常驻期间，铃声/语音每 15 秒循环重复播报，直到点击关闭（effect cleanup 停止）
  useEffect(() => {
    if (!classReminder) return;
    const timer = window.setInterval(() => {
      playReminderAlert(classReminder.mode, classReminder.type, classReminder.label);
    }, 15000);
    return () => window.clearInterval(timer);
  }, [classReminder]);

  // 图片上传时主进程自动切到视觉模型 → 输入区上方提示一次（6 秒后自动消失）
  const handleVisionSwitched = useCallback((data: { childId: string; modelId: string }) => {
    if (data.childId !== childIdRef.current) return;
    setVisionNotice("🖼️ 已自动切换到视觉模型来识别图片");
    window.setTimeout(() => setVisionNotice(""), 6000);
  }, []);

  // iframe 互动事件上报（fire-and-forget，失败静默——agent 感知是增强而非必需）
  const handlePageEvent = useCallback((evt: PageEvent) => {
    window.api.pageEvent(childIdRef.current, evt).catch(() => {});
  }, []);

  // 主进程下发的页面指令（agent 调 page_action/page_inspect）→ 面板执行 → 回执
  const handlePageExec = useCallback(
    async (data: { childId: string; requestId: string; action: string; params: any }) => {
      if (data.childId !== childIdRef.current) return;
      const panel = materialsPanelRef.current;
      const result: PageExecResultUplink = panel
        ? await panel.exec(data.action as PageAction, data.params || {})
        : { ok: false, error: "当前没有打开的学习资料页面" };
      try {
        await window.api.pageExecResult(childIdRef.current, data.requestId, result);
      } catch {
        /* 回执失败忽略（主进程侧有超时兜底） */
      }
    },
    []
  );

  useEffect(() => {
    window.api.onPiReply(handleReply);
    window.api.onPiReplyEnd(handleReplyEnd);
    window.api.onPiReplyError(handleReplyError);
    window.api.onPiThinking(handleThinking);
    window.api.onPiToolStart(handleToolStart);
    window.api.onPiToolEnd(handleToolEnd);
    window.api.onPiSessionReset(handleSessionReset);
    window.api.onPiVisionModelSwitched(handleVisionSwitched);
    window.api.onClassReminder(handleClassReminder);
    window.api.onPageExec(handlePageExec);
    return () => {
      window.api.piRemoveListeners();
    };
  }, [handleReply, handleReplyEnd, handleReplyError, handleThinking, handleToolStart, handleToolEnd, handleSessionReset, handleVisionSwitched, handleClassReminder, handlePageExec]);

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
      // ISSUE-015：孩子在页面上的操作不再自动注入 agent，随本轮消息附带一段说明（发送后清空）
      try {
        const pending = await window.api.pageTakePending(child.childId);
        if (pending?.text) {
          parts.push(`\n[页面操作] 这部分是孩子在页面上的操作：${pending.text}`);
        }
      } catch {
        // 取页面操作失败不影响发送
      }
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
            ref={viewSwitcherRef}
            className="view-switcher"
            onMouseEnter={() => {
              // 进入即取消待执行的关闭延时，避免鼠标穿越缝隙时误关
              if (viewMenuTimerRef.current) {
                clearTimeout(viewMenuTimerRef.current);
                viewMenuTimerRef.current = null;
              }
              setViewMenuOpen(true);
            }}
            onMouseLeave={() => {
              // ISSUE-020：不直接关闭，延时 ~180ms——鼠标在按钮→浮层间的微小缝隙/慢移时给容错
              if (viewMenuTimerRef.current) clearTimeout(viewMenuTimerRef.current);
              viewMenuTimerRef.current = setTimeout(() => setViewMenuOpen(false), 180);
            }}
          >
            <button
              className={`sidebar-btn view-switcher-btn ${viewMenuOpen ? "open" : ""}`}
              title="切换展示页"
              onClick={() => setViewMenuOpen((v) => !v)}
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

          {/* ISSUE-023：聊天字号调节（与「朗读语速」并列；仅孩子聊天 .bubble-md-child 生效，家长端不受影响） */}
          <div className="sidebar-font">
            {sidebarCollapsed ? (
              <button
                className="sidebar-icon-btn"
                title={`聊天字号 ${fontSize}px`}
                onClick={() => setSidebarCollapsed(false)}
              >
                <Type size={20} />
              </button>
            ) : (
              <>
                <div className="sidebar-section-label">聊天字号</div>
                <div className="rate-grid">
                  {FONT_OPTIONS.map((opt) => (
                    <button
                      key={opt.px}
                      className={`rate-btn ${fontSize === opt.px ? "active" : ""}`}
                      onClick={() => handleFontSize(opt.px)}
                      title={`${opt.label} ${opt.display}px`}
                    >
                      {opt.display}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* ISSUE-019：今日课程——实时时钟 + 当天课程时间段（家长在定时任务里配置） */}
          <div className="sidebar-class-times">
            <SidebarClassSchedule
              childId={child.childId}
              collapsed={sidebarCollapsed}
              onExpand={() => setSidebarCollapsed(false)}
            />
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
          {panelCollapsed ? (
            // ISSUE-008/016：展示区折叠（任意展示页通用）；折叠时显示窄条展开按钮，聊天区占满
            <div
              className="material-collapsed-bar"
              title="展开展示区"
              onClick={() => setPanelCollapsed(false)}
            >
              <PanelRightOpen size={18} />
            </div>
          ) : view === "materials" ? (
            <MaterialsPanel
              ref={materialsPanelRef}
              materials={materials}
              selectedId={selectedMaterialId}
              onOpen={setSelectedMaterialId}
              onBack={() => setSelectedMaterialId(null)}
              onPageEvent={handlePageEvent}
              onCollapse={() => setPanelCollapsed(true)}
            />
          ) : (
            // ISSUE-016：学习进度等其它展示页同样可折叠（悬浮折叠按钮，不侵入组件内部布局）
            <div className="panel-collapse-host">
              <button
                className="panel-collapse-fab"
                title="收起展示区"
                onClick={() => setPanelCollapsed(true)}
              >
                <PanelRightClose size={16} />
              </button>
              <LearningDashboard childId={child.childId} />
            </div>
          )}
          <div
            className="learn-chat"
            style={
              // ISSUE-008/016：展示区折叠时聊天区占满剩余空间（flex:1）；展开时保持可拖拽宽度。
              // 聊天面板自身折叠（chat.collapsed）优先：任何情况下都显示 44px 窄条。
              // ISSUE-023：孩子聊天字号经 CSS 变量下传（仅本容器内 .bubble-md-child 生效）
              (chat.collapsed
                ? { width: 44, minWidth: 44, flex: "0 0 auto" }
                : {
                    flex: panelCollapsed ? "1 1 auto" : "0 0 auto",
                    width: panelCollapsed ? "auto" : chat.width,
                    minWidth: panelCollapsed ? 0 : undefined,
                    "--child-chat-font": `${fontSize}px`,
                  }) as React.CSSProperties
            }
          >
            {chat.collapsed ? (
              <div
                className="chat-collapsed-bar"
                title="展开聊天"
                onClick={() => chat.setCollapsed(false)}
              >
                <MessageSquare size={20} />
              </div>
            ) : (
              <>
                <div className="chat-resize-handle" onPointerDown={chat.startDrag} title="拖动调整聊天宽度" />
                <button
                  className="chat-collapse-btn"
                  title="折叠聊天"
                  onClick={() => chat.setCollapsed(true)}
                >
                  »
                </button>
                <ChatWindow
                  messages={messages}
                  onSend={handleSend}
                  disabled={busy}
                  running={busy}
                  onStop={handleStop}
                  aiEmoji={aiEmoji}
                  rate={rate}
                  childId={child.childId}
                  notice={visionNotice || null}
                />
              </>
            )}
          </div>
        </div>
      </div>

      {/* ISSUE-019：上课/下课提醒横幅——顶部 1/3 区域，固定定位覆盖所有子视图；
          一直显示直到孩子点击关闭（用户 2026-08-31 要求，不自动消失） */}
      {classReminder && (
        <div className="class-reminder-banner" onClick={() => setClassReminder(null)}>
          <div className="class-reminder-inner">
            <div className="class-reminder-icon">{classReminder.type === "start" ? "⏰" : "🎉"}</div>
            <div className="class-reminder-title">
              {classReminder.type === "start" ? "上课时间到！" : "下课啦！"}
            </div>
            {classReminder.label && <div className="class-reminder-label">{classReminder.label}</div>}
            <div className="class-reminder-sub">
              {classReminder.type === "start" ? "请开始学习吧 📚" : "休息一下，放松放松 ☕"}
            </div>
            <div className="class-reminder-dismiss">👆 点击关闭提示</div>
          </div>
        </div>
      )}

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

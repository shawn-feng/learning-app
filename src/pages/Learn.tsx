import { useState, useEffect, useRef, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { PanelRightOpen, PanelRightClose, Bot, Gauge, Type, TextSelect, CalendarClock, Settings, KeyRound, LogOut, BookOpen, BarChart3, MessageSquare, ClipboardList, ClipboardCheck, Bell } from "lucide-react";
import ChatWindow, { type ChatMessage, type ToolCallState, type SendOptions, type ImageAttachment, nowTime } from "../components/ChatWindow";
import MaterialsPanel, { type Material } from "../components/MaterialsPanel";
import LearningDashboard from "../components/LearningDashboard";
import ModelSelector from "../components/ModelSelector";
import TodoModal from "../components/TodoModal";
import MyRemindersModal from "../components/MyRemindersModal";
import ExamView from "../components/ExamView";
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

// ISSUE-030：孩子「资料字号」档位（默认 16px = 列表现状基准；复用 FONT_OPTIONS 范式，
// 去掉 46 避免资料列表过度膨胀，档位统一作用于列表/正文/markdown/HTML 资料，按 childId 持久化）
const MAT_FONT_OPTIONS = [
  { label: "小", px: 16, display: "16" },
  { label: "中", px: 22, display: "22" },
  { label: "大", px: 30, display: "30" },
  { label: "特大", px: 38, display: "38" },
];
const DEFAULT_MAT_FONT_PX = 16;

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

/** ISSUE-019/047：按提醒方式播报一次（铃声 + 语音），横幅首次与循环共用。
 *  type=custom 为 ISSUE-047 孩子端自建提醒——直接播报 label（提醒内容），不附加课程前缀。 */
function playReminderAlert(mode: "both" | "chime" | "voice", type: "start" | "end" | "custom", label: string): void {
  if (mode === "both" || mode === "chime") playChime();
  if (mode === "both" || mode === "voice") {
    const text =
      type === "custom"
        ? label || "定时提醒时间到啦！"
        : type === "start"
          ? label
            ? `${label}上课时间到啦，请开始学习吧！`
            : "上课时间到啦，请开始学习吧！"
          : label
            ? `${label}下课啦，休息一下吧！`
            : "下课啦，休息一下吧！";
    void speakReminder(text);
  }
}

/** ISSUE-019/026/059：今日课程——实时时钟 + 当天课程时间段（按星期映射取生效模板）。
 *  ISSUE-026 起弹框内全量展示（不再有折叠分支）；独立组件每秒时钟只重渲染自身；
 *  配置经 scheduler:config:get 取当前孩子的 classTemplates/classWeek，按今天星期解析生效模板的时间段。 */
function SidebarClassSchedule({ childId }: { childId: string }) {
  const [classTimes, setClassTimes] = useState<{ start: string; end: string; label?: string }[]>([]);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    window.api
      .schedulerConfigGet()
      .then((res: any) => {
        if (!alive || !res?.success) return;
        const cfg = res.configs?.[childId];
        // ISSUE-059：按今天星期几取生效模板的时间段（周末可指向不同模板或「不提醒」）
        const week = (cfg?.classWeek || {}) as { [d: number]: string | null };
        const day = new Date().getDay();
        const tplId = week[day] ?? null;
        const tpl = (cfg?.classTemplates || []).find((t: any) => t.id === tplId);
        setClassTimes(tpl ? (tpl.times || []) : []);
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
  const [stopping, setStopping] = useState(false); // ISSUE-068：停止中锁，保持发送禁用直到 SDK 真正 idle
  const childIdRef = useRef(child.childId);
  // ISSUE-029 任务2：当前课程子会话（英语课）。空串 = 主会话；`english:<title>` = 英语课按课隔离子会话
  const [currentCourseKey, setCurrentCourseKey] = useState("");
  const courseKeyRef = useRef("");
  const courseTitle = currentCourseKey
    ? currentCourseKey.slice(currentCourseKey.indexOf(":") + 1) || currentCourseKey
    : "";
  // ISSUE-061：场景对话模式——场景页（pi-scenario）就绪后聊天/语音球消息路由到独立 scene 会话，
  // 孩子课程会话挂起待命；显示场景横条，「结束场景对话」触发转交总结后回到课程会话。
  const [sceneMode, setSceneMode] = useState(false);
  const sceneModeRef = useRef(false);
  const applySceneMode = useCallback((on: boolean) => {
    sceneModeRef.current = on;
    setSceneMode(on);
  }, []);
  // ISSUE-061：场景对话的会话 key —— 优先用当前课程子会话（courseKeyRef）；
  // 孩子在主会话直接打开场景资料（未进课程）时，从资料 filePath/title 派生
  // `<topic>:<title>` 作为 scene 会话隔离 key（不切换课程会话，只建 scene 会话）。
  const sceneFallbackKeyRef = useRef("");
  // ISSUE-019：课程时间段提醒横幅（上课/下课；顶部 1/3 区域，常驻到点击关闭；含提醒方式）
  const [classReminder, setClassReminder] = useState<{
    type: "start" | "end" | "custom";
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
  const currentView = PANEL_VIEWS.find((v) => v.key === view) || PANEL_VIEWS[0];

  // ISSUE-026：孩子端左侧边栏常驻折叠（图标栏），所有功能交互统一走弹框
  const [showView, setShowView] = useState(false); // 切换展示页
  const [showModel, setShowModel] = useState(false); // 模型
  const [showRate, setShowRate] = useState(false); // 朗读语速
  const [showFont, setShowFont] = useState(false); // 聊天字号
  const [showClass, setShowClass] = useState(false); // 今日课程
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

  // ISSUE-030：孩子「资料字号」（默认 16px = 列表现状基准；按 childId 持久化，跨刷新保留）
  const [matFontSize, setMatFontSize] = useState(DEFAULT_MAT_FONT_PX);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(`chat:${child.childId}:matFontSize`);
      if (saved) {
        const n = Number(saved);
        if (Number.isFinite(n) && n >= 12 && n <= 64) setMatFontSize(n);
      }
    } catch {
      /* localStorage 不可用则保持默认 */
    }
  }, [child.childId]);
  const handleMatFontSize = (px: number) => {
    setMatFontSize(px);
    try {
      localStorage.setItem(`chat:${child.childId}:matFontSize`, String(px));
    } catch {
      /* 持久化失败不影响本次生效 */
    }
  };
  const [showMatFont, setShowMatFont] = useState(false); // 资料字号弹框

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
  // ISSUE-025：今日计划（Todolist）弹框
  const [showTodo, setShowTodo] = useState(false);
  // ISSUE-047 方案A：孩子端「我的提醒」弹框（独立于计划；提醒不一定是"要做的事"）
  const [showReminders, setShowReminders] = useState(false);
  // 学习考核（EXAM-REQUIREMENTS.md）：锁定考试视图开关（true 时全屏覆盖，考试中不可退出）
  const [examOpen, setExamOpen] = useState(false);
  // 待考核科目数（周期到点标红提醒，不强制打断；0 = 无）
  const [examPendingCount, setExamPendingCount] = useState(0);

  useEffect(() => {
    setAiName(child.aiName);
    setAiEmoji(child.aiEmoji || "🤖");
    setAiPersonality(child.aiPersonality);
  }, [child.aiName, child.aiEmoji, child.aiPersonality]);

  // 学习考核：周期到点「待考核」角标（服务端按 assess_method 周期算；失败静默，不影响学习）
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r: any = await window.api.examPending(child.childId);
        if (alive) setExamPendingCount(r?.success ? Number(r.data?.count) || 0 : 0);
      } catch {
        if (alive) setExamPendingCount(0);
      }
    })();
    return () => {
      alive = false;
    };
  }, [child.childId]);

  useEffect(() => {
    childIdRef.current = child.childId;
    courseKeyRef.current = currentCourseKey;
    // ISSUE-029 任务2：currentCourseKey 变化即切换会话——英语课=按课隔离子会话（干净窗口、
    // 主进程先 dispose 旧子会话再创建），空串=主会话（continueRecent 带原中文课历史）。
    // 切换时先清空旧消息/资料，防跨会话残留（随后 pi:start_child 回填新会话 history）。
    setMessages([]);
    setMaterials([]);
    setSelectedMaterialId(null);
    window.api.piStartChild(child.childId, currentCourseKey || undefined).then((r: any) => {
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
          // MATERIAL 保鲜：恢复展示的共享 html 可能是旧缓存（服务端文件已更新，尤其场景课）。
          // 后台逐份刷新为最新内容 → 左侧资料/场景自动载入新版本，无需 agent 重新 display。
          void refreshStaleMaterials(r.materials);
        }
        if (typeof r.materialsLimit === "number" && r.materialsLimit > 0) {
          materialsLimitRef.current = r.materialsLimit;
        }
        // ISSUE-029 任务2：进入英语子会话后自动注入开场教学指令——复用 handleSend 完整流程
        // （hiddenUser 不渲染孩子气泡，但创建工作气泡），thinking/工具调用实时可见，
        // 孩子能看到 AI 正在准备课程，不再面对空白界面等待。
        if (currentCourseKey) {
          const courseTitle = currentCourseKey.slice(currentCourseKey.indexOf(":") + 1);
          void handleSend(`[进入英语课:${courseTitle}] 我准备好了，请开始本课的英文教学。`, {
            hiddenUser: true,
          });
        }
      } else {
        console.error("Failed to start session:", r?.error);
      }
    });
  }, [child.childId, currentCourseKey]);

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
    // 场景课恢复路径：自动打开的资料若本身就是场景页（内容含 pi-scenario 标记），
    // 同样激活场景模式（不进课程也能与场景对话）。不设 sceneOpenedTurnRef——没有本轮的
    // 课程 agent 收尾可衔接，仅保证下一条消息路由到 scene 会话。
    const last = materials[materials.length - 1];
    if (
      last &&
      last.format === "html" &&
      typeof last.content === "string" &&
      last.content.includes("pi-scenario")
    ) {
      activateSceneFromTool(last.filePath, last.title);
    }
  }, [materials]);

  // 工具结束调用 + 学习资料列表更新
  const handleToolEnd = useCallback((data: any) => {
    if (data.childId !== childIdRef.current) return;
    if (data.toolName === "display_content") {
      const panel = data.result?.details?.panelContent;
      if (panel) {
        // 场景课全托管：display_content 工具级判定（主进程已按 HTML 标记/主题名单给出 panel.isScene，
        // 渲染层再按内容标记兜底）。命中即置交棒标记并**立即激活场景会话**——不再等 iframe 的
        // scene.ready（app 内沙箱 iframe 正文脚本可能不执行，曾导致永不跳转）。
        const isScene =
          panel.isScene === true ||
          (typeof panel.content === "string" && panel.content.includes("pi-scenario"));
        if (isScene) {
          sceneOpenedTurnRef.current = true;
          activateSceneFromTool(panel.filePath, panel.title);
        }
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
    // ISSUE-029 任务2：英语课「举手标记」检测——剥除标记后展示；若在主会话收到标记，
    // 自动切入对应英语子会话（切换由基础设施完成；子会话打开后会自动注入开场教学指令）。
    const hand = data.text.match(/\[进入英语课[:：]([^\]]+)\]/);
    const display = hand ? data.text.replace(/\[进入英语课[:：][^\]]+\]/g, "").trim() : data.text;
    if (hand && !courseKeyRef.current) {
      const courseName = hand[1].trim();
      if (courseName) setCurrentCourseKey(`english:${courseName}`);
    }
    if (!display) return; // 回复只剩标记（如刚切会话的过渡轮）则不渲染空气泡
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id
            ? { ...m, text: display, working: false }
            : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: display, time: nowTime() }];
    });
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

  // ---- ISSUE-061：场景对话（scene agent）----
  // 场景页（pi-scenario）就绪 → 切场景模式：聊天/语音球消息路由到独立 scene 会话。
  // 会话 key 优先课程子会话；主会话直接打开的场景资料用 filePath 前段 topic + 资料标题派生，
  // 保证「不进课程也能用语音球和场景对话」（2026-09-07 实测语音识别成功但无反应=被 courseKey 门槛静默丢弃）。
  // 场景会话激活的共用实现：
  //  - 工具级路径（display_content 返回场景页 → handleToolEnd 调用，不依赖 iframe 就绪）
  //  - 页面就绪路径（iframe scene.ready → handleSceneActive 调用，兜底）
  // 无课程会话时按资料 filePath/title 派生 `<topic>:<title>` 作 scene 会话 key；
  // 派生不出（资料缺 filePath/标题）则不激活并明确提示。
  function activateSceneFromTool(filePath: string | undefined, title: string | undefined) {
    const ck = courseKeyRef.current;
    if (!ck) {
      const fp = String(filePath || "").replace(/^materials\//, "");
      const topic = fp ? fp.split("/")[0] : "";
      const t = String(title || "").trim();
      console.warn("[Learn-scene] 工具激活：无课程会话，尝试按资料派生", { fp, topic, title: t });
      sceneFallbackKeyRef.current = topic && t ? `${topic}:${t}` : "";
      if (!sceneFallbackKeyRef.current) {
        console.warn("[Learn-scene] fallback key 为空 → 场景模式未激活", { fp, title: t });
        applySceneMode(false);
        return;
      }
    }
    applySceneMode(true);
    // 场景就绪：后台预建场景会话/预热（每场景课程首次触发一次），HTML 会显示「正在准备…」
    const key = resolveSceneKey();
    if (key && scenePreparedForRef.current !== key) {
      scenePreparedForRef.current = key;
      void prepareSceneFlow(key);
    }
    // 场景历史回填：场景对话独立持久在 scene jsonl（主/课程会话 history 不含），激活场景会话时
    // 把历史拉回聊天框——否则每次重进孩子模式，之前的场景对话在 UI 上「消失」（agent 记忆仍在）。
    if (key) void restoreSceneHistory(key);
  }

  // 场景会话历史 → 聊天框（scene:history）。仅当该场景确有历史时才替换当前消息，
  // 保持聊天框 = 场景对话的完整视角（与 piStartChild 恢复主会话 history 的体验对齐）。
  const sceneHistLoadingRef = useRef("");
  async function restoreSceneHistory(key: string) {
    if (!key || sceneHistLoadingRef.current === key) return;
    sceneHistLoadingRef.current = key;
    try {
      const r: any = await window.api.sceneHistory(childIdRef.current, key);
      if (r?.success && Array.isArray(r.history) && r.history.length) {
        setMessages(
          r.history.map((m: any) => ({
            id: nextId(),
            role: m.role === "user" ? "user" : "ai",
            text: typeof m.text === "string" ? m.text : "",
            time: m.time || nowLabel(),
          }))
        );
      }
    } catch (e) {
      console.warn("[Learn-scene] 恢复场景历史失败", e);
    } finally {
      sceneHistLoadingRef.current = "";
    }
  }

  function handleSceneActive() {
    const sel = materials.find((m) => m.id === selectedMaterialId);
    activateSceneFromTool(sel?.filePath, sel?.title);
  }

  // 场景对话目标会话 key（课程会话优先，其次按资料派生的场景会话）
  const resolveSceneKey = useCallback(
    () => courseKeyRef.current || sceneFallbackKeyRef.current || "",
    []
  );

  // 场景「准备」（每个场景课程首次就绪触发一次）：预建 scene 会话+取课文+预热 TTS。
  // 期间 HTML 显示「正在准备场景伙伴…」；就绪后聊天给一条引导（孩子能感知后端在准备）。
  const scenePreparedForRef = useRef("");
  // ISSUE-061 全托管：场景课由学习 agent 打开后，课程轮结束即让场景伙伴开场接管
  const sceneOpenedTurnRef = useRef(false); // 本工作轮学习 agent 是否刚打开过场景资料
  const sceneIntroDoneRef = useRef<Set<string>>(new Set());
  const lastAskTextRef = useRef(""); // 最近一次孩子向学习 agent 发送的文本（交棒开场时引用）

  // 共享 html 资料保鲜：恢复后逐份拉服务端最新内容就地替换（scene/课程 html 更新后左侧自动刷新）
  async function refreshStaleMaterials(mats: Material[]) {
    const targets = mats.filter(
      (m) =>
        m.format === "html" &&
        m.filePath &&
        !m.filePath.startsWith("outputs/") &&
        /^[^/]+\/.+\.(html|htm)$/i.test(String(m.filePath).replace(/^materials\//, ""))
    );
    for (const m of targets) {
      try {
        const r: any = await window.api.materialsRefresh(m.filePath);
        if (r?.success && typeof r.content === "string" && r.content !== m.content) {
          setMaterials((prev) => prev.map((x) => (x.id === m.id ? { ...x, content: r.content, time: nowLabel() } : x)));
        }
      } catch {
        /* 单份刷新失败跳过 */
      }
    }
  }

  // 场景伙伴自动开场：只建一个工作气泡并 scenePrompt（不依赖语音球），角色用英文台词接孩子的话
  const launchSceneIntro = useCallback(
    async (ck: string) => {
      if (!ck || sceneIntroDoneRef.current.has(ck)) return;
      if (workingIdRef.current) return; // 课程 agent 轮还在收尾，等 reply_end 重入
      sceneIntroDoneRef.current.add(ck);
      const id = nextId();
      workingIdRef.current = id;
      setMessages((prev) => [...prev, { id, role: "ai" as const, text: "", working: true, time: nowTime() }]);
      setBusy(true);
      materialsPanelRef.current?.sceneAgentBusy(true);
      const ask = (lastAskTextRef.current || "").slice(0, 140);
      const promptText = ask
        ? `[开场] 孩子刚才请求学习本课，原话：「${ask}」。现在场景资料已打开，请你作为场景伙伴正式开场：让在场角色用英语向孩子问好并邀请他开口（一两句英文台词 + 配 1~2 个场景动作即可），然后等待孩子说话。`
        : "[开场] 孩子打开了本课场景资料。请你作为场景伙伴开场欢迎孩子，并邀请他用英语对话（一两句英文台词 + 简单动作即可），然后等待孩子说话。";
      const result = await window.api.scenePrompt(child.childId, ck, promptText);
      if (!result.success && workingIdRef.current === id) {
        workingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, text: `⚠️ 场景伙伴暂时没准备好：${result.error || "请稍后再试"}`, working: false }
              : m
          )
        );
        setBusy(false);
        materialsPanelRef.current?.sceneAgentBusy(false);
      }
    },
    []
  );
  const prepareSceneFlow = useCallback(
    async (ck: string) => {
      materialsPanelRef.current?.scenePreparing(true);
      try {
        await window.api.scenePrepare(childIdRef.current, ck);
      } catch {
        /* 准备失败不阻断：首次说话时仍会自动建会话 */
      }
      materialsPanelRef.current?.scenePreparing(false);
      addAiMessage("🎭 场景伙伴已就绪！按住 🎤 语音球说话，或用键盘打字，用英语和角色聊天吧～");
    },
    []
  );

  // 学习 agent 回复收尾（pi:reply_end）
  const handleReplyEnd = useCallback(() => {
    workingIdRef.current = null;
    setStopping(false);
    setBusy(false);
    // 场景课全托管：本工作轮学习 agent 刚打开过场景资料 → 课程收尾后由场景伙伴开场接管
    if (sceneOpenedTurnRef.current && sceneModeRef.current) {
      sceneOpenedTurnRef.current = false;
      const ck = resolveSceneKey();
      if (ck) void launchSceneIntro(ck);
    }
  }, [launchSceneIntro, resolveSceneKey]);

  // 场景语音球：录音结束（voice/scene 已由主进程落盘）+ ASR 文本 → 场景会话
  const handleSceneVoice = useCallback(
    async (text: string, buf: ArrayBuffer) => {
      const ck = resolveSceneKey();
      if (!ck) {
        addAiMessage("🎭 还没找到可对话的场景，请让学习伙伴先打开场景资料，或从课程入口进入本课。");
        return;
      }
      if (workingIdRef.current) return; // 上一轮还在进行，忽略本轮
      let audioRel = "";
      try {
        const r: any = await window.api.sceneVoiceSave(childIdRef.current, buf);
        if (r?.success) audioRel = (r.rel as string) || "";
      } catch {
        /* 落盘失败不阻断 */
      }
      const userMsg: ChatMessage = {
        id: nextId(),
        role: "user",
        text,
        audioPath: "", // 场景语音回放 v1 不做（文件在 voice/scene/，后续挑选分析用）
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
      // ISSUE-061：场景页显示「角色回应中…」直到本轮回复到达
      materialsPanelRef.current?.sceneAgentBusy(true);
      const attach = audioRel ? `\n【附件音频：${audioRel.split("/").pop()}|${audioRel}】` : "";
      const promptText =
        `[语音识别输入，可能存在同音字/断句等识别错误，请结合上下文理解并推理出正确内容]\n${text}${attach}`;
      const markError = (errText: string) => {
        const id = workingIdRef.current;
        workingIdRef.current = null;
        setMessages((prev) => {
          if (id && prev.some((m) => m.id === id)) {
            return prev.map((m) => (m.id === id ? { ...m, text: `⚠️ ${errText}`, working: false } : m));
          }
          return [...prev, { id: nextId(), role: "ai", text: `⚠️ ${errText}`, time: nowTime() }];
        });
        setBusy(false);
        materialsPanelRef.current?.sceneAgentBusy(false);
      };
      try {
        const result: any = await window.api.scenePrompt(childIdRef.current, ck, promptText);
        if (!result?.success) markError(result?.error || "发送失败");
      } catch (e: any) {
        markError(e?.message || "网络错误");
      }
    },
    []
  );

  // scene:reply —— 填到工作气泡（与 handleReply 同款，但不做「举手切课程」标记解析）
  const handleSceneReply = useCallback((data: { childId: string; courseKey: string; text: string }) => {
    if (data.childId !== childIdRef.current) return;
    const text = (data.text || "").trim();
    if (!text) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) => (m.id === id ? { ...m, text, working: false } : m));
      }
      return [...prev, { id: nextId(), role: "ai", text, time: nowTime() }];
    });
    setBusy(false);
    materialsPanelRef.current?.sceneAgentBusy(false);
  }, []);

  const handleSceneReplyEnd = useCallback((data: { childId: string }) => {
    if (data.childId !== childIdRef.current) return;
    workingIdRef.current = null;
    setStopping(false);
    setBusy(false);
    materialsPanelRef.current?.sceneAgentBusy(false);
  }, []);

  const handleSceneReplyError = useCallback((data: { childId: string; error: string }) => {
    if (data.childId !== childIdRef.current) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id ? { ...m, text: `⚠️ ${data.error}`, working: false } : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: `⚠️ ${data.error}`, time: nowTime() }];
    });
    setBusy(false);
    setStopping(false);
    materialsPanelRef.current?.sceneAgentBusy(false);
  }, []);

  // 「结束场景对话」：立即切回课程会话 UI，主进程把场景记录转交课程 agent 收尾总结
  const handleEndScene = useCallback(async () => {
    const ck = resolveSceneKey();
    applySceneMode(false);
    sceneFallbackKeyRef.current = ""; // 结束场景对话后清除按资料派生的 key（避免误沿用）
    if (!ck) return;
    try {
      await window.api.sceneTransfer(childIdRef.current, ck);
    } catch {
      /* 转交失败不阻断（场景 jsonl 仍是真源） */
    }
    try {
      await window.api.sceneStop(childIdRef.current, ck);
    } catch {
      /* 忽略 */
    }
  }, [applySceneMode]);


  // 停止当前轮的 agent 运行（发送按钮变为停止按钮后点击触发）：
  // 前端立即收尾工作气泡（避免后续 pi:reply/error 事件追加多余气泡），再通知主进程 abort。
  const handleStop = useCallback(async () => {
    const id = workingIdRef.current;
    workingIdRef.current = null;
    // ISSUE-068：进入「停止中」——保持发送禁用，直到 pi:reply_end（SDK 真正 idle）才解禁，
    // 避免「已停止」UI 抢先解禁、在底层流未终止的窗口内误发新消息命中 SDK 重入守卫。
    setStopping(true);
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
    // 安全兜底：极端竞态/崩溃导致 reply_end 未到达时，5s 后强制解禁，避免按钮卡死
    setTimeout(() => {
      setStopping(false);
      setBusy(false);
    }, 5000);
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
    (data: { childId: string; type: "start" | "end" | "custom"; label: string; mode?: "both" | "chime" | "voice" }) => {
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

  // 主进程下发的页面指令（agent 调 page_action/page_inspect/scene_command）→ 面板执行 → 回执
  const handlePageExec = useCallback(
    async (data: { childId: string; requestId: string; action: string; params: any }) => {
      if (data.childId !== childIdRef.current) return;
      const panel = materialsPanelRef.current;
      // ISSUE-061：action=scene → 场景页下行指令（面板直接 postMessage 给场景页，不走桥白名单）
      let result: PageExecResultUplink;
      if (data.action === "scene") {
        const { command, ...rest } = data.params || {};
        result = panel
          ? await panel.scene(String(command ?? ""), rest)
          : { ok: false, error: "当前没有打开的学习资料页面" };
      } else {
        result = panel
          ? await panel.exec(data.action as PageAction, data.params || {})
          : { ok: false, error: "当前没有打开的学习资料页面" };
      }
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
    // ISSUE-061：场景会话（scene agent）回复事件
    window.api.onSceneReply(handleSceneReply);
    window.api.onSceneReplyEnd(handleSceneReplyEnd);
    window.api.onSceneReplyError(handleSceneReplyError);
    return () => {
      window.api.piRemoveListeners();
    };
  }, [handleReply, handleReplyEnd, handleReplyError, handleThinking, handleToolStart, handleToolEnd, handleSessionReset, handleVisionSwitched, handleClassReminder, handlePageExec, handleSceneReply, handleSceneReplyEnd, handleSceneReplyError]);

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
    // 记录最近一次孩子向学习 agent 说的话（场景交棒开场用）；新轮开始清掉上一轮的“打开过场景”标记
    lastAskTextRef.current = trimmed;
    sceneOpenedTurnRef.current = false;
    // ISSUE-061：场景对话模式（场景页就绪）→ 聊天消息也路由到独立 scene 会话。
    // 会话 key = 课程子会话优先，未进课程时用当前场景资料派生的 key（resolveSceneKey）。
    const sceneTargetKey = resolveSceneKey();
    const useScene = sceneModeRef.current && !!sceneTargetKey;
    const images = opts?.images || [];
    const textFiles = opts?.textFiles || [];
    // 语音输入：先把录音落盘（历史恢复时据此播放），失败不影响发送。
    // 多段（ISSUE-021）由主进程 voice:merge 拼接成单个 WAV；单段沿用原 saveUpload。
    // 场景模式下单段语音改落 voice/scene 目录（与场景语音球一致，便于挑选分析）。
    let audioPath: string | undefined;
    let audioData: string | undefined;
    if (opts?.audios && opts.audios.length) {
      if (opts.audios.length === 1) {
        audioData = opts.audios[0];
        try {
          const buf = base64ToArrayBuffer(opts.audios[0]);
          const r: any = useScene
            ? await window.api.sceneVoiceSave(child.childId, buf)
            : await window.api.saveUpload(child.childId, "语音录音.webm", "audio/webm", buf);
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
    // ISSUE-029 任务2：hiddenUser（英语子会话自动开场）不渲染孩子气泡，但工作气泡照常创建
    // ——thinking/工具调用事件渲染到工作气泡，孩子能看到 AI 正在准备课程，不再面对空白界面。
    setMessages((prev) => [...prev, ...(opts?.hiddenUser ? [] : [userMsg]), workingMsg]);
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
      if (useScene) materialsPanelRef.current?.sceneAgentBusy(true); // 场景页「角色回应中…」
      const result = useScene
        ? await window.api.scenePrompt(child.childId, sceneTargetKey, promptText)
        : await window.api.piPrompt(
            child.childId,
            promptText,
            sdkImages.length ? sdkImages : undefined,
            courseKeyRef.current || undefined
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
          if (useScene) materialsPanelRef.current?.sceneAgentBusy(false);
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
        if (useScene) materialsPanelRef.current?.sceneAgentBusy(false);
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
        {/* ISSUE-026：孩子端左侧边栏常驻折叠（图标栏），功能交互统一弹框 */}
        <div className="learn-sidebar collapsed">
          <div className="sidebar-profile">
            <div className="sidebar-avatar" title={child.name}>{child.avatar}</div>
          </div>

          <div className="sidebar-actions">
            <button
              className="sidebar-icon-btn"
              title="切换展示页"
              onClick={() => setShowView(true)}
            >
              <currentView.icon size={18} />
            </button>

            <button
              className="sidebar-icon-btn"
              title="模型"
              onClick={() => setShowModel(true)}
            >
              <Bot size={20} />
            </button>

            <button
              className="sidebar-icon-btn"
              title={`朗读语速 ${RATE_OPTIONS.find((o) => o.value === rate)?.display || "1.0x"}`}
              onClick={() => setShowRate(true)}
            >
              <Gauge size={20} />
            </button>

            <button
              className="sidebar-icon-btn"
              title={`聊天字号 ${fontSize}px`}
              onClick={() => setShowFont(true)}
            >
              <Type size={20} />
            </button>

            <button
              className="sidebar-icon-btn"
              title={`资料字号 ${matFontSize}px`}
              onClick={() => setShowMatFont(true)}
            >
              <TextSelect size={20} />
            </button>

            <button
              className="sidebar-icon-btn"
              title="今日课程安排"
              onClick={() => setShowClass(true)}
            >
              <CalendarClock size={20} />
            </button>

            {/* ISSUE-047 方案A：我的提醒（孩子自建定时提醒，独立于今日计划） */}
            <button
              className="sidebar-icon-btn"
              title="我的提醒"
              onClick={() => setShowReminders(true)}
            >
              <Bell size={20} />
            </button>
          </div>

          <div className="sidebar-menu">
            <button
              className="sidebar-btn"
              title={examPendingCount > 0 ? `学习考核（${examPendingCount} 科待考核）` : "学习考核"}
              onClick={() => {
                setExamPendingCount(0);
                setExamOpen(true);
              }}
              style={{ position: "relative" }}
            >
              <ClipboardCheck size={18} className="sidebar-btn-icon" />
              {examPendingCount > 0 && (
                <span
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    background: "#e74c3c",
                    color: "#fff",
                    borderRadius: 999,
                    fontSize: 10,
                    lineHeight: "16px",
                    minWidth: 16,
                    height: 16,
                    textAlign: "center",
                    padding: "0 4px",
                    fontWeight: 700,
                  }}
                >
                  {examPendingCount}
                </span>
              )}
            </button>
            <button
              className="sidebar-btn"
              title="今日计划（Todolist）"
              onClick={() => setShowTodo(true)}
            >
              <ClipboardList size={18} className="sidebar-btn-icon" />
            </button>
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
              matFontSize={matFontSize}
              onSceneActive={handleSceneActive}
              onSceneVoice={handleSceneVoice}
              onSceneMicNotice={(msg) => addAiMessage(`🎤 ${msg}`)}
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
                {/* ISSUE-029 任务2：英语课子会话模式横条——显示当前课程 + 退出回主会话 */}
                {currentCourseKey && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 12px",
                      background: "#E6F1FB",
                      borderBottom: "1px solid #B5D4F4",
                      flex: "0 0 auto",
                    }}
                  >
                    <span style={{ fontWeight: 500, fontSize: 13, color: "#0C447C", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {"🌍 英语课 · " + courseTitle}
                    </span>
                    <button
                      onClick={() => {
                        void handleEndScene(); // 结束场景对话（若有）+ 转交总结
                        setCurrentCourseKey("");
                      }}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#185FA5",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 500,
                        flex: "0 0 auto",
                      }}
                      title="退出英语课，回到主会话"
                    >
                      退出英语课 ✕
                    </button>
                  </div>
                )}
                {/* ISSUE-061：场景对话模式横条——语音球/聊天消息走独立场景角色；可一键结束并转交总结 */}
                {sceneMode && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 12px",
                      background: "#F1EDFB",
                      borderBottom: "1px solid #D8CCF2",
                      flex: "0 0 auto",
                    }}
                  >
                    <span style={{ fontWeight: 600, fontSize: 13, color: "#534AB7", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      🎭 场景英语对话中
                    </span>
                    <button
                      onClick={() => void handleEndScene()}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: "#534AB7",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 500,
                        flex: "0 0 auto",
                      }}
                      title="结束场景对话：把本次场景对话记录转交课程助手收尾总结"
                    >
                      结束场景对话 ✕
                    </button>
                  </div>
                )}
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
                  disabled={busy || stopping}
                  running={busy || stopping}
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
            <div className="class-reminder-icon">
              {classReminder.type === "start" ? "⏰" : classReminder.type === "end" ? "🎉" : "🔔"}
            </div>
            <div className="class-reminder-title">
              {classReminder.type === "start"
                ? "上课时间到！"
                : classReminder.type === "end"
                  ? "下课啦！"
                  : classReminder.label || "定时提醒"}
            </div>
            {classReminder.type === "custom" && classReminder.label && (
              <div className="class-reminder-label">{classReminder.label}</div>
            )}
            <div className="class-reminder-sub">
              {classReminder.type === "start"
                ? "请开始学习吧 📚"
                : classReminder.type === "end"
                  ? "休息一下，放松放松 ☕"
                  : "⏰ 这是你设置的定时提醒 · 点击关闭"}
            </div>
            <div className="class-reminder-dismiss">👆 点击关闭提示</div>
          </div>
        </div>
      )}

      {showTodo && (
        <TodoModal
          childId={child.childId}
          onClose={() => setShowTodo(false)}
          // ISSUE-029 任务2：今日计划里的英语课项点击「进入课程」→ 切到英语子会话
          onStartCourse={(courseKey) => {
            setShowTodo(false);
            setCurrentCourseKey(courseKey);
          }}
        />
      )}

      {/* ISSUE-047 方案A：我的提醒（独立弹框，不放今日计划里） */}
      {showReminders && <MyRemindersModal childId={child.childId} onClose={() => setShowReminders(false)} />}

      {/* ISSUE-026：切换展示页弹框（替代原 popover；点选项切换 view 后关闭） */}
      {showView && (
        <div className="modal-overlay" onClick={() => setShowView(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>切换展示页</h2>
            <div className="view-options-modal">
              {PANEL_VIEWS.map((v) => (
                <button
                  key={v.key}
                  className={`view-option ${view === v.key ? "active" : ""}`}
                  onClick={() => {
                    setView(v.key);
                    setShowView(false);
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
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowView(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ISSUE-026：模型弹框——⚠️ ModelSelector 必须常驻挂载（卸载重挂会重新拉模型并切回默认），
          因此本弹框恒在 DOM（display 控制显隐），组件不卸载 */}
      <div
        className="modal-overlay"
        style={{ display: showModel ? "flex" : "none" }}
        onClick={() => setShowModel(false)}
      >
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>选择模型</h2>
          <div className="sidebar-section-label">模型</div>
          <ModelSelector childId={child.childId} />
          <div className="modal-actions">
            <button className="cancel" onClick={() => setShowModel(false)}>关闭</button>
          </div>
        </div>
      </div>

      {/* ISSUE-026：朗读语速弹框 */}
      {showRate && (
        <div className="modal-overlay" onClick={() => setShowRate(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>朗读语速</h2>
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
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowRate(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ISSUE-026：聊天字号弹框 */}
      {showFont && (
        <div className="modal-overlay" onClick={() => setShowFont(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>聊天字号</h2>
            <div className="rate-grid">
              {FONT_OPTIONS.map((opt) => (
                <button
                  key={opt.px}
                  className={`rate-btn ${fontSize === opt.px ? "active" : ""}`}
                  onClick={() => handleFontSize(opt.px)}
                  title={`${opt.label} ${opt.display}px`}
                >
                  {opt.display}px
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowFont(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ISSUE-030：资料字号弹框（与聊天字号并列，复用 rate-grid 范式；按 childId 持久化，作用域仅孩子端学习资料） */}
      {showMatFont && (
        <div className="modal-overlay" onClick={() => setShowMatFont(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>资料字号</h2>
            <div className="rate-grid">
              {MAT_FONT_OPTIONS.map((opt) => (
                <button
                  key={opt.px}
                  className={`rate-btn ${matFontSize === opt.px ? "active" : ""}`}
                  onClick={() => handleMatFontSize(opt.px)}
                  title={`${opt.label} ${opt.display}px`}
                >
                  {opt.display}px
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowMatFont(false)}>关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ISSUE-026：今日课程弹框（实时时钟 + 当天课程时间段） */}
      {showClass && (
        <div className="modal-overlay" onClick={() => setShowClass(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>今日课程</h2>
            <SidebarClassSchedule childId={child.childId} />
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowClass(false)}>关闭</button>
            </div>
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
      {examOpen && (
        <ExamView
          childId={child.childId}
          onExit={() => {
            setExamOpen(false);
            // 考核完成/退出后刷新待考核角标（排期状态可能已变化）
            window.api
              .examPending(child.childId)
              .then((r: any) => setExamPendingCount(r?.success ? Number(r.data?.count) || 0 : 0))
              .catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

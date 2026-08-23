import fs from "fs";
import path from "path";
import cron from "node-cron";
import { BrowserWindow } from "electron";
import { getTaskStatePath, getSchedulerConfigPath, getChildDir } from "./config";
import { listChildren } from "./child-auth";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { kbInsertTool, kbQueryTool, kbUpdateTool } from "./custom-tools";
import { RECORDING_PROMPT, RECORDING_SYSTEM_PROMPT } from "./recording-prompt";
import { runStudyTracker, formatLocalDate, type StudyTrackerResult } from "./study-tracker";
import { resetChildSession } from "./pi-session";
import { logRound } from "./token-stats";

export interface TaskState {
  children: Record<
    string,
    {
      recording: { lastRun: string };
      "study-tracker": { lastRun: string };
      "session-reset": { lastRun: string };
      "auto-new-session": { lastRun: string };
    }
  >;
}

// 每个孩子独立的定时任务配置。默认（未配置）全部关闭。
export interface SchedulerChildConfig {
  recording: { enabled: boolean; intervalHours: number };
  studyTracker: { enabled: boolean; hour: number; minute: number };
  // 会话重置：每天在配置的 hour:minute 清空孩子会话上下文与学习资料（不清除学习进度）
  sessionReset: { enabled: boolean; hour: number; minute: number };
  // 自动新建会话：开关开启后，每天在配置的 hour:minute 新建空会话；且 app 启动时若最后一条
  // 消息不是当天也会新建。与 sessionReset 的区别：本开关同时覆盖「跨天自动开新」与「定点开新」，
  // 由 pi-session 的 shouldAutoNewSession 在开会话时统一裁决，scheduler 仅负责热会话到点重置。
  autoNewSession: { enabled: boolean; hour: number; minute: number };
  // 历史会话归档保留上限：每次会话重置后只保留最近 N 个旧会话文件，更早的清理，避免无限膨胀。
  // 家长可在「定时任务」设置页配置；设置为 0 表示不保留历史归档（仅当前会话）。
  archiveLimit: number;
}

interface SchedulerConfig {
  children: Record<string, SchedulerChildConfig>;
}

export const DEFAULT_CHILD_CONFIG: SchedulerChildConfig = {
  recording: { enabled: false, intervalHours: 1 },
  studyTracker: { enabled: false, hour: 21, minute: 0 },
  sessionReset: { enabled: false, hour: 22, minute: 0 },
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
  archiveLimit: 20,
};

const HOUR_MS = 3600 * 1000;

function loadTaskState(): TaskState {
  const p = getTaskStatePath();
  if (!fs.existsSync(p)) return { children: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { children: {} };
  }
}

function saveTaskState(state: TaskState): void {
  fs.writeFileSync(getTaskStatePath(), JSON.stringify(state, null, 2), "utf-8");
}

function defaultChildTaskState() {
  return {
    recording: { lastRun: "" },
    "study-tracker": { lastRun: "" },
    "session-reset": { lastRun: "" },
    "auto-new-session": { lastRun: "" },
  };
}

export function getChildState(state: TaskState, childId: string) {
  const base = defaultChildTaskState();
  if (!state.children[childId]) {
    state.children[childId] = base;
  } else {
    // 容错：磁盘上已有的 task-state.json 可能缺少后续新增的任务键（如 auto-new-session）。
    // 不补齐会导致 cron 读到 undefined.lastRun 而崩溃。这里对每个任务键做合并，
    // 既保留历史 lastRun，又保证新键存在。
    const existing = state.children[childId];
    state.children[childId] = {
      recording: { ...base.recording, ...existing.recording },
      "study-tracker": { ...base["study-tracker"], ...existing["study-tracker"] },
      "session-reset": { ...base["session-reset"], ...existing["session-reset"] },
      "auto-new-session": { ...base["auto-new-session"], ...existing["auto-new-session"] },
    };
  }
  return state.children[childId];
}

// ---- 定时任务配置读写（家长在设置里管理）----

function loadSchedulerConfig(): SchedulerConfig {
  const p = getSchedulerConfigPath();
  if (!fs.existsSync(p)) return { children: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return { children: {} };
  }
}

function saveSchedulerConfig(config: SchedulerConfig): void {
  fs.writeFileSync(getSchedulerConfigPath(), JSON.stringify(config, null, 2), "utf-8");
}

export function getChildSchedulerConfig(childId: string): SchedulerChildConfig {
  const config = loadSchedulerConfig();
  const c = config.children[childId];
  if (!c) return JSON.parse(JSON.stringify(DEFAULT_CHILD_CONFIG));
  // 合并缺省字段，保证结构完整
  return {
    recording: { ...DEFAULT_CHILD_CONFIG.recording, ...(c.recording || {}) },
    studyTracker: { ...DEFAULT_CHILD_CONFIG.studyTracker, ...(c.studyTracker || {}) },
    sessionReset: { ...DEFAULT_CHILD_CONFIG.sessionReset, ...(c.sessionReset || {}) },
    autoNewSession: { ...DEFAULT_CHILD_CONFIG.autoNewSession, ...(c.autoNewSession || {}) },
    archiveLimit: c.archiveLimit ?? DEFAULT_CHILD_CONFIG.archiveLimit,
  };
}

export function setChildSchedulerConfig(
  childId: string,
  childConfig: SchedulerChildConfig
): SchedulerChildConfig {
  const config = loadSchedulerConfig();
  config.children[childId] = {
    recording: { ...DEFAULT_CHILD_CONFIG.recording, ...(childConfig.recording || {}) },
    studyTracker: { ...DEFAULT_CHILD_CONFIG.studyTracker, ...(childConfig.studyTracker || {}) },
    sessionReset: { ...DEFAULT_CHILD_CONFIG.sessionReset, ...(childConfig.sessionReset || {}) },
    autoNewSession: { ...DEFAULT_CHILD_CONFIG.autoNewSession, ...(childConfig.autoNewSession || {}) },
    archiveLimit:
      typeof childConfig.archiveLimit === "number"
        ? childConfig.archiveLimit
        : DEFAULT_CHILD_CONFIG.archiveLimit,
  };
  saveSchedulerConfig(config);
  return config.children[childId];
}

// ---- 会话与任务执行 ----

export async function createEphemeralSession(childId: string) {
  const childDir = getChildDir(childId);
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();

  // recording 定时任务专用会话：不加载 AGENTS.md（noContextFiles）、不加载任何技能（noSkills），
  // system prompt 用极简记录助手身份——只做「从对话提取信息写入 daily」这一件事。
  // 工具只挂 kb 三件套（写 daily / 更新进度 / 查标签定义），不给 read/write/edit 碰数据文件的机会。
  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    noContextFiles: true,
    noSkills: true,
    systemPromptOverride: () => RECORDING_SYSTEM_PROMPT,
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: loader,
    // 注意：customTools 的 name 必须同时出现在 tools 白名单（agent-session.js 的 isAllowedTool 会过滤），
    // kb 三件套缺一不可（ISSUE-006 教训：漏列白名单 → 工具不注册不激活）。
    tools: ["kb_query", "kb_insert", "kb_update"],
    customTools: [kbQueryTool, kbInsertTool, kbUpdateTool],
  });
  return session;
}

// 读取孩子「今天（本地时区）」的对话文本：遍历 sessions 目录所有 jsonl（含归档），
// 只取 type=message 且 role 为 user / assistant 的条目，content 数组里只保留 type=text 的部分
// （排除 thinking / toolCall，role=toolResult 的条目整体跳过），按时间升序拼成对话记录。
// 旧实现（readRecentConversation）按 user_message / assistant_message 类型判断，与真实
// jsonl 结构（type=message + message.role）不符，实际提取不到内容，这里一并修复。
function readTodayConversation(childId: string): string {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return "";
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const msgs: { ts: number; role: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.name.endsWith(".jsonl")) {
        for (const line of fs.readFileSync(full, "utf-8").split("\n").filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.type !== "message" || !entry.message) continue;
            const ts = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
            if (!Number.isFinite(ts) || ts < todayStart) continue;
            const role = entry.message.role;
            if (role !== "user" && role !== "assistant") continue;
            const content = entry.message.content;
            const parts = Array.isArray(content) ? content : [];
            const texts = parts
              .filter((p: any) => p?.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text.trim())
              .filter(Boolean);
            if (texts.length === 0) continue;
            msgs.push({ ts, role, text: texts.join("\n") });
          } catch {
            // 单行损坏跳过，不影响其余行
          }
        }
      }
    }
  };
  walk(sessionsDir);
  msgs.sort((a, b) => a.ts - b.ts);
  return msgs.map((m) => `${m.role === "user" ? "孩子" : "饺子"}: ${m.text}`).join("\n\n");
}

async function runRecording(childId: string): Promise<void> {
  const conversation = readTodayConversation(childId);
  if (!conversation.trim()) return; // 当天无对话，跳过本次提取（不发请求、不记账）
  const session = await createEphemeralSession(childId);
  try {
    const today = formatLocalDate(new Date());
    const prompt = `${RECORDING_PROMPT}\n\n今天是 ${today}。以下是孩子今天（${today}）的对话记录，请按要求提取信息并写入 daily：\n\n${conversation}`;
    const beforeCount = (session as any).messages?.length ?? 0;
    await session.prompt(prompt);
    // ISSUE-010：定时任务记账（按 childId 隔离）
    logRound({ session, beforeCount, channel: "scheduler", childId, ok: true });
  } finally {
    session.dispose();
  }
}

// study-tracker：纯代码实现（不再作为技能、不调用 AI），从 kb.sqlite 取数判断当日达标情况，
// 结果写入 learning/tracker-latest.md 并广播给渲染窗口（前端无监听时无副作用）。
function runTracker(childId: string): void {
  const childDir = getChildDir(childId);
  const result = runStudyTracker(childDir);
  broadcastStudyTracker(childId, result);
}

function broadcastStudyTracker(childId: string, result: StudyTrackerResult): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send("pi:study_tracker", { childId, result });
    }
  }
}

// 会话重置：清空孩子会话上下文与学习资料面板（不清除学习进度文件）。
// 先销毁内存会话，再清空持久化 sessions 目录；随后广播事件，
// 若家长/孩子正打开该孩子的 Learn 页面，前端会同步清空。
async function runSessionReset(childId: string): Promise<void> {
  const archiveLimit = getChildSchedulerConfig(childId).archiveLimit;
  await resetChildSession(childId, archiveLimit);
  broadcastSessionReset(childId);
}

// 通知所有渲染窗口：某孩子会话已被重置，前端（Learn 页）据此清空状态
function broadcastSessionReset(childId: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send("pi:session_reset", { childId });
    }
  }
}

// 每分钟检查一次：按每个孩子各自的配置决定是否执行。默认未配置的孩子不执行。
export function startScheduler(): void {
  cron.schedule("* * * * *", async () => {
    const state = loadTaskState();
    const children = listChildren();
    const now = new Date();

    for (const child of children) {
      const cc = getChildSchedulerConfig(child.childId);
      const cs = getChildState(state, child.childId);

      // recording：按 intervalHours 间隔执行
      if (cc.recording.enabled) {
        const last = cs.recording.lastRun ? new Date(cs.recording.lastRun).getTime() : 0;
        if (now.getTime() - last >= cc.recording.intervalHours * HOUR_MS) {
          try {
            await runRecording(child.childId);
            cs.recording.lastRun = new Date().toISOString();
            saveTaskState(state);
          } catch (e) {
            console.error(`Recording failed for child ${child.childId}:`, e);
          }
        }
      }

      // study-tracker：每天在配置的 hour:minute 执行一次
      if (cc.studyTracker.enabled) {
        const lastDay = cs["study-tracker"].lastRun
          ? new Date(cs["study-tracker"].lastRun).toDateString()
          : "";
        const isTime =
          now.getHours() === cc.studyTracker.hour &&
          now.getMinutes() === cc.studyTracker.minute;
        if (isTime && lastDay !== now.toDateString()) {
          try {
            runTracker(child.childId);
            cs["study-tracker"].lastRun = new Date().toISOString();
            saveTaskState(state);
          } catch (e) {
            console.error(`Tracker failed for child ${child.childId}:`, e);
          }
        }
      }

      // session-reset：每天在配置的 hour:minute 清空孩子会话（不清除学习进度）
      if (cc.sessionReset.enabled) {
        const lastDay = cs["session-reset"].lastRun
          ? new Date(cs["session-reset"].lastRun).toDateString()
          : "";
        const isTime =
          now.getHours() === cc.sessionReset.hour &&
          now.getMinutes() === cc.sessionReset.minute;
        if (isTime && lastDay !== now.toDateString()) {
          try {
            await runSessionReset(child.childId);
            cs["session-reset"].lastRun = new Date().toISOString();
            saveTaskState(state);
          } catch (e) {
            console.error(`Session reset failed for child ${child.childId}:`, e);
          }
        }
      }

      // auto-new-session：每天在配置的 hour:minute 新建空会话。
      // 冷路径（会话未加载）由 getChildSession 打开时按「最后消息非今天 / 已过设定节点」自动开新会话；
      // 此处仅对「已加载（热）」会话在到点时立即重置，保证活跃对话也被及时清空。
      if (cc.autoNewSession.enabled) {
        const isTime =
          now.getHours() === cc.autoNewSession.hour &&
          now.getMinutes() === cc.autoNewSession.minute;
        const lastDay = cs["auto-new-session"].lastRun
          ? new Date(cs["auto-new-session"].lastRun).toDateString()
          : "";
        if (isTime && lastDay !== now.toDateString()) {
          try {
            await runSessionReset(child.childId);
            cs["auto-new-session"].lastRun = new Date().toISOString();
            saveTaskState(state);
          } catch (e) {
            console.error(`Auto-new-session failed for child ${child.childId}:`, e);
          }
        }
      }
    }
  });
}

// 启动时补跑：仅对已开启对应任务且到期的孩子执行（默认关闭，因此默认不补跑）。
export async function runCatchUp(): Promise<void> {
  const state = loadTaskState();
  const children = listChildren();
  const now = new Date();
  const today = now.toDateString();

  for (const child of children) {
    const cc = getChildSchedulerConfig(child.childId);
    const cs = getChildState(state, child.childId);

    if (cc.recording.enabled) {
      const lastRec = cs.recording.lastRun ? new Date(cs.recording.lastRun).getTime() : 0;
      if (now.getTime() - lastRec >= cc.recording.intervalHours * HOUR_MS) {
        try {
          await runRecording(child.childId);
          cs.recording.lastRun = new Date().toISOString();
        } catch (e) {
          console.error(`Recording catch-up failed for child ${child.childId}:`, e);
        }
      }
    }

    if (cc.studyTracker.enabled) {
      const lastTracker = cs["study-tracker"].lastRun
        ? new Date(cs["study-tracker"].lastRun).toDateString()
        : "";
      if (lastTracker !== today) {
        try {
          runTracker(child.childId);
          cs["study-tracker"].lastRun = new Date().toISOString();
        } catch (e) {
          console.error(`Tracker catch-up failed for child ${child.childId}:`, e);
        }
      }
    }

    if (cc.sessionReset.enabled) {
      const lastReset = cs["session-reset"].lastRun
        ? new Date(cs["session-reset"].lastRun).toDateString()
        : "";
      if (lastReset !== today) {
        try {
          await runSessionReset(child.childId);
          cs["session-reset"].lastRun = new Date().toISOString();
        } catch (e) {
          console.error(`Session-reset catch-up failed for child ${child.childId}:`, e);
        }
      }
    }
  }

  saveTaskState(state);
}

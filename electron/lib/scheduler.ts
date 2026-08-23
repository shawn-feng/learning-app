import fs from "fs";
import path from "path";
import cron from "node-cron";
import { BrowserWindow } from "electron";
import { getTaskStatePath, getSchedulerConfigPath, getChildDir } from "./config";
import { listChildren } from "./child-auth";
import { summarizeDailyConversation, formatLocalDate } from "./daily-summary";
import { resetChildSession } from "./pi-session";

export interface TaskState {
  children: Record<
    string,
    {
      recording: { lastRun: string };
      "session-reset": { lastRun: string };
      "auto-new-session": { lastRun: string };
    }
  >;
}

// 每个孩子独立的定时任务配置。默认（未配置）全部关闭。
export interface SchedulerChildConfig {
  // 每日学习记录总结（recording）：按具体时间点触发（可多个）；onNewSession = 每次新建会话前自动总结
  recording: { enabled: boolean; times: string[]; onNewSession: boolean };
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
  recording: { enabled: false, times: ["21:00"], onNewSession: false },
  sessionReset: { enabled: false, hour: 22, minute: 0 },
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
  archiveLimit: 20,
};

// 旧配置（intervalHours 间隔模式）已废弃：读配置时把缺省 times 补成默认时间点。
export function defaultRecordingTimes(): string[] {
  return [...DEFAULT_CHILD_CONFIG.recording.times];
}

/** HH:mm（本地时区，两位补零），用于时间点匹配。 */
function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}


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
  // 合并缺省字段，保证结构完整；recording.times 兼容旧配置（intervalHours 模式无 times → 补默认时间点）
  const rec = c.recording || {};
  return {
    recording: {
      enabled: rec.enabled ?? DEFAULT_CHILD_CONFIG.recording.enabled,
      times:
        Array.isArray(rec.times) && rec.times.length > 0 ? [...rec.times] : defaultRecordingTimes(),
      onNewSession: rec.onNewSession ?? DEFAULT_CHILD_CONFIG.recording.onNewSession,
    },
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
    recording: {
      enabled: childConfig.recording?.enabled ?? DEFAULT_CHILD_CONFIG.recording.enabled,
      times:
        Array.isArray(childConfig.recording?.times) && childConfig.recording.times.length > 0
          ? [...childConfig.recording.times]
          : defaultRecordingTimes(),
      onNewSession: childConfig.recording?.onNewSession ?? DEFAULT_CHILD_CONFIG.recording.onNewSession,
    },
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

// 每日学习记录总结（recording）：按天汇总今天（本地）的会话——有会话则 AI 提取写 daily，无会话跳过。
// 读取与 ephemeral session 逻辑在 electron/lib/daily-summary.ts（定时 / 会话前 / AI 工具三路共用）。
async function runRecording(childId: string): Promise<void> {
  const childDir = getChildDir(childId);
  await summarizeDailyConversation(childDir, formatLocalDate(new Date()));
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

      // 每日学习记录总结（recording）：按配置的具体时间点（可多个）触发，每个时间点每天只跑一次；
      // 当天无会话时 summarizeDailyConversation 内部跳过（不消耗 token）。
      if (cc.recording.enabled) {
        const nowMin = hhmm(now);
        if (cc.recording.times.includes(nowMin)) {
          const last = cs.recording.lastRun ? new Date(cs.recording.lastRun) : null;
          const alreadyRan =
            last && formatLocalDate(last) === formatLocalDate(now) && hhmm(last) === nowMin;
          if (!alreadyRan) {
            try {
              await runRecording(child.childId);
              cs.recording.lastRun = new Date().toISOString();
              saveTaskState(state);
            } catch (e) {
              console.error(`Recording failed for child ${child.childId}:`, e);
            }
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
      // catch-up：今天已过的配置时间点若还没跑过，补跑最近一个（启动/休眠恢复场景）
      const passed = cc.recording.times.filter((t) => t <= hhmm(now));
      if (passed.length > 0) {
        const latestPoint = passed[passed.length - 1];
        const lastRec = cs.recording.lastRun ? new Date(cs.recording.lastRun) : null;
        const alreadyRan =
          lastRec && formatLocalDate(lastRec) === formatLocalDate(now) && hhmm(lastRec) === latestPoint;
        if (!alreadyRan) {
          try {
            await runRecording(child.childId);
            cs.recording.lastRun = new Date().toISOString();
          } catch (e) {
            console.error(`Recording catch-up failed for child ${child.childId}:`, e);
          }
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

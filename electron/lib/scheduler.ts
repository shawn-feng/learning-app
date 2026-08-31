import fs from "fs";
import path from "path";
import cron from "node-cron";
import { BrowserWindow } from "electron";
import { getTaskStatePath, getSchedulerConfigPath, getChildDir } from "./config";
import { pushConfig } from "./config-sync";
import { listChildren } from "./child-auth";
import { summarizeDailyConversation, formatLocalDate } from "./daily-summary";
import { resetChildSession } from "./pi-session";
import { handleCloudInbox } from "./delivery";

export interface TaskState {
  children: Record<
    string,
    {
      recording: { lastRun: string };
      "auto-new-session": { lastRun: string };
      // ISSUE-041 层 C：家长→孩子事件轮询
      "event-poll": { lastRun: string };
      // ISSUE-019：课程时间段提醒（上课/下课；lastKey 防同日同时间点重复触发）
      "class-reminder": { lastKey: string };
    }
  >;
  // 顶层任务：本地定时备份（ISSUE-041 层 A）
  backup?: { lastRun: string };
}

// 每个孩子独立的定时任务配置。默认（未配置）全部关闭。
export interface SchedulerChildConfig {
  // 每日学习记录总结（recording）：按具体时间点触发（可多个）；onNewSession = 每次新建会话前自动总结
  recording: { enabled: boolean; times: string[]; onNewSession: boolean };
  // 自动新建会话：开关开启后，每天在配置的 hour:minute 新建空会话；且 app 启动时若最后一条
  // 消息不是当天也会新建。由 pi-session 的 shouldAutoNewSession 在开会话时统一裁决，scheduler 仅负责热会话到点重置。
  autoNewSession: { enabled: boolean; hour: number; minute: number };
  // 历史会话归档保留上限：每次会话重置后只保留最近 N 个旧会话文件，更早的清理，避免无限膨胀。
  // 家长可在「定时任务」设置页配置；设置为 0 表示不保留历史归档（仅当前会话）。
  archiveLimit: number;
  // ISSUE-019：课程时间段（可多段，每段 上课时间 start + 下课时间 end + 可选课程名 label）。
  // 到上课/下课时间点，孩子端 app 顶部 1/3 区域弹出提示 + 铃声/语音播报。
  classTimes: ClassTime[];
  // ISSUE-019：课程提醒方式：both=铃声+语音播报 / chime=仅铃声 / voice=仅语音播报
  classAlertMode: "both" | "chime" | "voice";
}

/** ISSUE-019：一段课程时间段（HH:mm，本地时区）。 */
export interface ClassTime {
  /** 上课时间 HH:mm */
  start: string;
  /** 下课时间 HH:mm */
  end: string;
  /** 课程名/标签（可选，如「语文课」；提醒时展示） */
  label?: string;
}

interface SchedulerConfig {
  children: Record<string, SchedulerChildConfig>;
  // 家长会话配置（2026-08-24：家长会话也支持自动新建会话策略，与孩子一致）
  parent?: SchedulerParentConfig;
  // 本地定时备份（2026-08-25：ISSUE-041 层 A，设备级）
  backup?: SchedulerBackupConfig;
  // 云端事件轮询（2026-08-25：ISSUE-041 层 C，设备级）
  eventPoll?: SchedulerEventPollConfig;
}

/** 家长会话（parent / parent-content）配置。目前只有 autoNewSession（自动新建会话策略）。 */
export interface SchedulerParentConfig {
  autoNewSession: { enabled: boolean; hour: number; minute: number };
}

/** 本地定时备份配置（设备级，非 per-child；ISSUE-041 层 A）。destDir 由家长在设置页选定。 */
export interface SchedulerBackupConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  destDir: string;
}

/**
 * 云端事件轮询配置（设备级，ISSUE-041 层 C）。
 * 轮询很轻（一次空 GET），间隔即「家长发课→孩子收到」的延迟上界；
 * 默认 2 分钟（1~60 可调）。除定时轮询外，孩子端打开会话时也会即时轮询一次。
 */
export interface SchedulerEventPollConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export const DEFAULT_PARENT_CONFIG: SchedulerParentConfig = {
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
};

export const DEFAULT_BACKUP_CONFIG: SchedulerBackupConfig = {
  enabled: false,
  hour: 22,
  minute: 30,
  destDir: "",
};

export const DEFAULT_EVENT_POLL_CONFIG: SchedulerEventPollConfig = {
  enabled: true,
  intervalMinutes: 2,
};

export const DEFAULT_CHILD_CONFIG: SchedulerChildConfig = {
  recording: { enabled: false, times: ["21:00"], onNewSession: false },
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
  archiveLimit: 20,
  classTimes: [],
  classAlertMode: "both",
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
    "auto-new-session": { lastRun: "" },
    "event-poll": { lastRun: "" },
    "class-reminder": { lastKey: "" },
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
      "auto-new-session": { ...base["auto-new-session"], ...existing["auto-new-session"] },
      "event-poll": { ...base["event-poll"], ...existing["event-poll"] },
      "class-reminder": { ...base["class-reminder"], ...existing["class-reminder"] },
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
  const p = getSchedulerConfigPath();
  // 防御：未登录时 getParentConfigDir 返回 parents/_guest 且不建目录（设计如此），
  // 但保存必须能落盘——先建父目录再写，避免 ENOENT。
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2), "utf-8");
  // SPLIT M8-C：配置唯一真源在服务端，保存后同步（跨设备 ≤2min 生效）
  void pushConfig("scheduler_config", config).catch(() => {});
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
    autoNewSession: { ...DEFAULT_CHILD_CONFIG.autoNewSession, ...(c.autoNewSession || {}) },
    archiveLimit: c.archiveLimit ?? DEFAULT_CHILD_CONFIG.archiveLimit,
    classTimes: Array.isArray(c.classTimes)
      ? c.classTimes
          .map((t) => ({
            start: String(t?.start ?? ""),
            end: String(t?.end ?? ""),
            label: t?.label ? String(t.label) : undefined,
          }))
          .filter((t) => t.start && t.end)
      : [],
    classAlertMode:
      c.classAlertMode === "chime" || c.classAlertMode === "voice"
        ? c.classAlertMode
        : DEFAULT_CHILD_CONFIG.classAlertMode,
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
    autoNewSession: { ...DEFAULT_CHILD_CONFIG.autoNewSession, ...(childConfig.autoNewSession || {}) },
    archiveLimit:
      typeof childConfig.archiveLimit === "number"
        ? childConfig.archiveLimit
        : DEFAULT_CHILD_CONFIG.archiveLimit,
    classTimes: Array.isArray(childConfig.classTimes)
      ? childConfig.classTimes
          .map((t) => ({
            start: String(t?.start ?? ""),
            end: String(t?.end ?? ""),
            label: t?.label ? String(t.label) : undefined,
          }))
          .filter((t) => t.start && t.end)
      : [],
    classAlertMode:
      childConfig.classAlertMode === "chime" || childConfig.classAlertMode === "voice"
        ? childConfig.classAlertMode
        : DEFAULT_CHILD_CONFIG.classAlertMode,
  };
  saveSchedulerConfig(config);
  return config.children[childId];
}

/** 家长会话配置读取（scheduler-config.json 的 parent 段；未配置/损坏返回默认，全部关闭）。 */
export function getParentSchedulerConfig(): SchedulerParentConfig {
  const config = loadSchedulerConfig();
  const p = config.parent;
  if (!p) return JSON.parse(JSON.stringify(DEFAULT_PARENT_CONFIG));
  return {
    autoNewSession: { ...DEFAULT_PARENT_CONFIG.autoNewSession, ...(p.autoNewSession || {}) },
  };
}

/** 家长会话配置保存（整体替换 parent 段）。 */
export function setParentSchedulerConfig(parentConfig: SchedulerParentConfig): SchedulerParentConfig {
  const config = loadSchedulerConfig();
  config.parent = {
    autoNewSession: { ...DEFAULT_PARENT_CONFIG.autoNewSession, ...(parentConfig.autoNewSession || {}) },
  };
  saveSchedulerConfig(config);
  return config.parent;
}

/** 本地定时备份配置读取（设备级；未配置/损坏返回默认，默认关闭）。 */
export function getBackupSchedulerConfig(): SchedulerBackupConfig {
  const config = loadSchedulerConfig();
  const b = config.backup;
  if (!b) return JSON.parse(JSON.stringify(DEFAULT_BACKUP_CONFIG));
  return {
    enabled: b.enabled ?? DEFAULT_BACKUP_CONFIG.enabled,
    hour: Number.isFinite(b.hour) ? b.hour : DEFAULT_BACKUP_CONFIG.hour,
    minute: Number.isFinite(b.minute) ? b.minute : DEFAULT_BACKUP_CONFIG.minute,
    destDir: typeof b.destDir === "string" ? b.destDir : "",
  };
}

/** 本地定时备份配置保存（整体替换 backup 段）。 */
export function setBackupSchedulerConfig(cfg: SchedulerBackupConfig): SchedulerBackupConfig {
  const config = loadSchedulerConfig();
  config.backup = {
    enabled: cfg.enabled ?? DEFAULT_BACKUP_CONFIG.enabled,
    hour: Number.isFinite(cfg.hour) ? cfg.hour : DEFAULT_BACKUP_CONFIG.hour,
    minute: Number.isFinite(cfg.minute) ? cfg.minute : DEFAULT_BACKUP_CONFIG.minute,
    destDir: typeof cfg.destDir === "string" ? cfg.destDir : "",
  };
  saveSchedulerConfig(config);
  return config.backup;
}

/** 云端事件轮询配置读取（设备级；未配置/损坏返回默认，默认开启 2 分钟）。 */
export function getEventPollConfig(): SchedulerEventPollConfig {
  const config = loadSchedulerConfig();
  const e = config.eventPoll;
  if (!e) return JSON.parse(JSON.stringify(DEFAULT_EVENT_POLL_CONFIG));
  const interval = Number.isFinite(e.intervalMinutes)
    ? Math.min(60, Math.max(1, Math.floor(e.intervalMinutes)))
    : DEFAULT_EVENT_POLL_CONFIG.intervalMinutes;
  return {
    enabled: e.enabled ?? DEFAULT_EVENT_POLL_CONFIG.enabled,
    intervalMinutes: interval,
  };
}

/** 云端事件轮询配置保存（整体替换 eventPoll 段）。 */
export function setEventPollConfig(cfg: SchedulerEventPollConfig): SchedulerEventPollConfig {
  const config = loadSchedulerConfig();
  const interval = Number.isFinite(cfg.intervalMinutes)
    ? Math.min(60, Math.max(1, Math.floor(cfg.intervalMinutes)))
    : DEFAULT_EVENT_POLL_CONFIG.intervalMinutes;
  config.eventPoll = {
    enabled: cfg.enabled ?? DEFAULT_EVENT_POLL_CONFIG.enabled,
    intervalMinutes: interval,
  };
  saveSchedulerConfig(config);
  return config.eventPoll;
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

// ISSUE-019：课程时间段提醒（上课/下课）广播——孩子端 Learn 页收到后显示顶部横幅 + 铃声/语音。
// mode 透传家长配置的提醒方式（both=铃声+语音 / chime=仅铃声 / voice=仅语音），由渲染端决定播报内容。
function broadcastClassReminder(
  childId: string,
  type: "start" | "end",
  label?: string,
  mode: "both" | "chime" | "voice" = "both"
): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      w.webContents.send("class:reminder", { childId, type, label: label || "", mode });
    }
  }
}

// 本地定时备份：设备级，按 backup.hour:minute 每天跑一次（需已选定 destDir）。
// 动态 import backup.ts，避免 electron-vite 把 zip 逻辑打进无关 chunk 时互相耦合。
async function runBackupIfDue(state: TaskState, now: Date): Promise<void> {
  const bc = getBackupSchedulerConfig();
  if (!bc.enabled || !bc.destDir) return;
  const isTime = now.getHours() === bc.hour && now.getMinutes() === bc.minute;
  if (!isTime) return;
  const lastDay = state.backup?.lastRun ? new Date(state.backup.lastRun).toDateString() : "";
  if (lastDay === now.toDateString()) return;
  try {
    const { createBackup } = await import("./backup");
    const r = await createBackup(bc.destDir);
    state.backup = { lastRun: new Date().toISOString() };
    saveTaskState(state);
    console.log(`Scheduled backup done: ${r.file} (${r.count} files)`);
  } catch (e) {
    console.error("Scheduled backup failed:", e);
  }
}

// 每分钟检查一次：按每个孩子各自的配置决定是否执行。默认未配置的孩子不执行。
export function startScheduler(): void {
  cron.schedule("* * * * *", async () => {
    const state = loadTaskState();
    const children = await listChildren();
    const now = new Date();

    // 设备级：本地定时备份（ISSUE-041 层 A）
    await runBackupIfDue(state, now);

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

      // ISSUE-019：课程时间段提醒（上课/下课）——到点广播给孩子端（前端显示顶部 1/3 横幅
      // + 铃声/语音播报）。start/end 各自每天只触发一次（lastKey 防重；key 含日期，跨天自动失效）。
      if (cc.classTimes && cc.classTimes.length > 0) {
        const nowMin = hhmm(now);
        for (const ct of cc.classTimes) {
          if (!ct.start || !ct.end) continue;
          const fire = (type: "start" | "end") => {
            const key = `${now.toDateString()}:${type}:${type === "start" ? ct.start : ct.end}:${ct.label || ""}`;
            if (cs["class-reminder"].lastKey === key) return;
            cs["class-reminder"].lastKey = key;
            try {
              broadcastClassReminder(child.childId, type, ct.label, cc.classAlertMode);
              saveTaskState(state);
            } catch (e) {
              console.error(`Class reminder failed for child ${child.childId}:`, e);
            }
          };
          if (nowMin === ct.start) fire("start");
          if (nowMin === ct.end) fire("end");
        }
      }

      // ISSUE-041 消息交换轮询（设备级配置，默认 2 分钟一次，可关闭）。
      // 云端只做消息交换：拉分配包 → 本地落库合并 → ack；顺带响应家长「请求刷新进度」标记。
      // 云不可达时静默跳过，等下一轮。除定时轮询外，孩子端开会话时也会即时轮询（ipc pi:start_child）。
      {
        const ep = getEventPollConfig();
        if (ep.enabled) {
          const POLL_MS = ep.intervalMinutes * 60_000;
          const lastPoll = cs["event-poll"].lastRun
            ? new Date(cs["event-poll"].lastRun).getTime()
            : 0;
          if (now.getTime() - lastPoll >= POLL_MS) {
            try {
              const r = await handleCloudInbox(child.childId);
              if (r.applied > 0 || r.pushed) {
                console.log(`Cloud inbox handled for child ${child.childId}: applied=${r.applied} pushed=${r.pushed}`);
              }
            } catch (e) {
              console.error(`Cloud inbox poll failed for child ${child.childId}:`, e);
            }
            cs["event-poll"].lastRun = new Date().toISOString();
            saveTaskState(state);
          }
        }
      }
    }
  });
}

// 启动时补跑：仅对已开启对应任务且到期的孩子执行（默认关闭，因此默认不补跑）。
export async function runCatchUp(): Promise<void> {
  const state = loadTaskState();
  const children = await listChildren();
  const now = new Date();
  const today = now.toDateString();

  // 设备级备份 catch-up：今天已过设定时间点且还没跑过 → 补跑一次（休眠恢复/开机场景）
  const bc = getBackupSchedulerConfig();
  if (bc.enabled && bc.destDir) {
    const due = `${String(bc.hour).padStart(2, "0")}:${String(bc.minute).padStart(2, "0")}`;
    if (due <= hhmm(now)) {
      const lastDay = state.backup?.lastRun ? new Date(state.backup.lastRun).toDateString() : "";
      if (lastDay !== today) {
        try {
          const { createBackup } = await import("./backup");
          const r = await createBackup(bc.destDir);
          state.backup = { lastRun: new Date().toISOString() };
          console.log(`Backup catch-up done: ${r.file} (${r.count} files)`);
        } catch (e) {
          console.error("Backup catch-up failed:", e);
        }
      }
    }
  }

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
  }

  saveTaskState(state);
}

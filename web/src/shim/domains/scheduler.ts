/**
 * scheduler 域（Phase 2 实现）——移植 electron/lib/ipc-handlers.ts 的 scheduler:* 通道 +
 * electron/lib/scheduler.ts 的配置/提醒语义：
 *
 * - 配置（schedulerConfigGet/Set / schedulerParentConfigSet）：Electron 存本地
 *   parents/<id>/scheduler-config.json 并 pushConfig("scheduler_config") 同步服务端；
 *   Web 直接以服务端 /config 的 scheduler_config 键为真源（config.ts 的同步缓存承载），
 *   写入 = 读改写 + POST /config/set 整键推送（保留 backup/eventPoll 等其它段落不被覆盖）。
 *   归一化逻辑（缺省合并/课程表模板迁移）逐段移植 getChildSchedulerConfig/
 *   setChildSchedulerConfig/normalizeClassSchedule，保证返回结构一致。
 * - 任务/执行记录/有效配置（schedulerTasks* / schedulerRunsList /
 *   schedulerEffectiveConfigGet）：纯透传 /scheduler/* 路由，返回 {success, tasks|runs|children}。
 * - 提醒（reminderList/reminderCancel）：/scheduler/reminders/list、DELETE /scheduler/tasks/:id。
 * - **提醒轮询（Web 版核心差异）**：Electron 主进程 node-cron 每分钟对全部孩子跑
 *   （自定义提醒拉 /scheduler/reminders?childId= 就地标记 + 本地课程表时间点匹配），
 *   广播 class:reminder。Web 以 60s setInterval 等价实现，只对「当前孩子」
 *   （childSelect/childAuth 成功时经 noteActiveChild 记录——渲染层 Learn 页按
 *   childIdRef 过滤事件，非当前孩子的事件不会被消费，故不空转）。
 *   auto-new-session 热会话重置与云端事件轮询属主进程本地职责（服务端 worker 兜底重任务），
 *   Web 不实现（对齐设计方案 §2 #10「页面存活期等价」）。
 */
import { http, getStoredToken } from "../core/server-fetch";
import { eventBus } from "../core/event-bus";
import {
  ensureConfigSyncStarted,
  getCachedSchedulerConfig,
  loadSchedulerConfigFromServer,
  pushSchedulerConfig,
} from "./config";

// ---------------------------------------------------------------------------
// 类型（对齐 electron/lib/scheduler.ts）
// ---------------------------------------------------------------------------

export interface ClassTime {
  start: string;
  end: string;
  label?: string;
}

export interface ClassTimeTemplate {
  id: string;
  name: string;
  times: ClassTime[];
}

export interface SchedulerChildConfig {
  recording: { enabled: boolean; times: string[]; onNewSession: boolean };
  autoNewSession: { enabled: boolean; hour: number; minute: number };
  archiveLimit: number;
  classTemplates: ClassTimeTemplate[];
  classWeek: { [day: number]: string | null };
  classTimes?: ClassTime[];
  classAlertMode: "both" | "chime" | "voice";
  todo: { enabled: boolean; genTime: string; statTime: string };
}

const DEFAULT_PARENT_CONFIG = {
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
};

const DEFAULT_CHILD_CONFIG: SchedulerChildConfig = {
  recording: { enabled: false, times: ["21:00"], onNewSession: false },
  autoNewSession: { enabled: false, hour: 21, minute: 0 },
  archiveLimit: 20,
  classTemplates: [
    { id: "schoolday", name: "上学日", times: [] },
    { id: "weekend", name: "周末", times: [] },
  ],
  classWeek: { 1: "schoolday", 2: "schoolday", 3: "schoolday", 4: "schoolday", 5: "schoolday", 0: "weekend", 6: "weekend" },
  classAlertMode: "both",
  todo: { enabled: false, genTime: "08:00", statTime: "21:00" },
};

function defaultRecordingTimes(): string[] {
  return [...DEFAULT_CHILD_CONFIG.recording.times];
}

// ---- 课程时间表（模板 + 星期映射）归一（移植 normalizeClassSchedule） ----

function cleanTimes(arr: unknown): ClassTime[] {
  if (!Array.isArray(arr)) return [];
  return (arr as any[])
    .map((t) => ({
      start: String(t?.start ?? ""),
      end: String(t?.end ?? ""),
      label: t?.label ? String(t.label) : undefined,
    }))
    .filter((t) => t.start && t.end);
}

function seedClassTemplates(): ClassTimeTemplate[] {
  return [
    { id: "schoolday", name: "上学日", times: [] },
    { id: "weekend", name: "周末", times: [] },
  ];
}

function seedClassWeek(): { [day: number]: string | null } {
  return { 1: "schoolday", 2: "schoolday", 3: "schoolday", 4: "schoolday", 5: "schoolday", 0: "weekend", 6: "weekend" };
}

function normalizeClassSchedule(c: any): {
  classTemplates: ClassTimeTemplate[];
  classWeek: { [day: number]: string | null };
} {
  const legacy = cleanTimes(c?.classTimes);
  let templates: ClassTimeTemplate[];
  let source: "templates" | "legacy" | "seed";

  if (Array.isArray(c?.classTemplates) && c.classTemplates.length > 0) {
    templates = (c.classTemplates as any[]).map((t, i) => ({
      id: typeof t?.id === "string" && t.id ? t.id : `tpl-${i}-${Date.now()}`,
      name: typeof t?.name === "string" && t.name ? t.name : `模板${i + 1}`,
      times: cleanTimes(t?.times),
    }));
    source = "templates";
  } else if (legacy.length > 0) {
    templates = [{ id: "custom", name: "自定义", times: legacy }];
    source = "legacy";
  } else {
    templates = seedClassTemplates();
    source = "seed";
  }

  const ids = new Set(templates.map((t) => t.id));
  const week: { [day: number]: string | null } = {};
  const fw = c?.classWeek;
  if (source === "legacy") {
    for (let d = 0; d <= 6; d++) week[d] = templates[0].id;
  } else if (source === "seed") {
    Object.assign(week, seedClassWeek());
  } else if (fw && typeof fw === "object") {
    for (let d = 0; d <= 6; d++) {
      const v = fw[d];
      week[d] = typeof v === "string" && ids.has(v) ? v : null;
    }
  } else {
    for (let d = 0; d <= 6; d++) week[d] = templates[0].id;
  }
  return { classTemplates: templates, classWeek: week };
}

/** 归一化孩子配置（移植 getChildSchedulerConfig：缺省合并 + 兼容旧结构）。 */
function normalizeChildConfig(c: any): SchedulerChildConfig {
  if (!c || typeof c !== "object") {
    return JSON.parse(JSON.stringify(DEFAULT_CHILD_CONFIG)) as SchedulerChildConfig;
  }
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
    ...normalizeClassSchedule(c),
    classAlertMode:
      c.classAlertMode === "chime" || c.classAlertMode === "voice"
        ? c.classAlertMode
        : DEFAULT_CHILD_CONFIG.classAlertMode,
    todo: {
      enabled: c.todo?.enabled ?? DEFAULT_CHILD_CONFIG.todo.enabled,
      genTime: /^\d{2}:\d{2}$/.test(c.todo?.genTime ?? "")
        ? c.todo!.genTime
        : DEFAULT_CHILD_CONFIG.todo.genTime,
      statTime: /^\d{2}:\d{2}$/.test(c.todo?.statTime ?? "")
        ? c.todo!.statTime
        : DEFAULT_CHILD_CONFIG.todo.statTime,
    },
  };
}

/** 按今天星期几解析生效课程时间段（移植 getEffectiveClassTimes）。 */
function getEffectiveClassTimes(cfg: SchedulerChildConfig, now: Date): ClassTime[] {
  const day = now.getDay();
  const tplId = cfg.classWeek?.[day] ?? null;
  if (!tplId) return [];
  const tpl = (cfg.classTemplates || []).find((t) => t.id === tplId);
  if (!tpl) return [];
  return cleanTimes(tpl.times);
}

function hhmm(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

// ---------------------------------------------------------------------------
// scheduler_config 读写（服务端 /config 真源）
// ---------------------------------------------------------------------------

/** 取 scheduler_config 整体（缓存缺失时回源拉取）。 */
async function getSchedulerConfigRoot(): Promise<Record<string, unknown>> {
  ensureConfigSyncStarted();
  const cached = getCachedSchedulerConfig();
  if (cached) return cached;
  try {
    return await loadSchedulerConfigFromServer();
  } catch {
    return {}; // 服务端不可达：按空配置（各孩子落默认）返回，对齐 Electron 本地文件缺失行为
  }
}

/** 孩子配置段（Record<childId, any>）。 */
function childrenSection(root: Record<string, unknown>): Record<string, any> {
  const c = root.children;
  return c && typeof c === "object" ? (c as Record<string, any>) : {};
}

// ---------------------------------------------------------------------------
// 当前孩子（提醒轮询范围） + class:reminder 轮询
// ---------------------------------------------------------------------------

let activeChildId: string | null = null;
let reminderTimer: ReturnType<typeof setInterval> | null = null;
/** class-reminder 同日同时间点去重（对齐 TaskState.children[class-reminder].lastKey，Web 内存态）。 */
const classReminderLastKey = new Map<string, string>();

/** 记录当前孩子（children 域 childSelect/childAuth 成功时调用）。 */
export function noteActiveChild(childId: string): void {
  activeChildId = childId || null;
}

/** 当前孩子 id（可能为 null=未选择，提醒轮询空转跳过）。 */
export function getActiveChildId(): string | null {
  return activeChildId;
}

/** 广播课程时间段提醒（对齐 broadcastClassReminder → class:reminder 事件）。 */
function emitClassReminder(
  childId: string,
  type: "start" | "end",
  label: string | undefined,
  mode: "both" | "chime" | "voice"
): void {
  eventBus.emit("class:reminder", { childId, type, label: label || "", mode });
}

/** 广播孩子自建提醒（对齐 broadcastCustomReminder：复用 class:reminder 通道，type="custom"）。 */
function emitCustomReminder(childId: string, text: string, mode: "both" | "chime" | "voice"): void {
  eventBus.emit("class:reminder", { childId, type: "custom", label: text || "", mode });
}

/** 拉取到期提醒（对齐 fetchDueReminders：GET /scheduler/reminders?childId=，服务端就地标记幂等）。 */
async function fetchDueReminders(
  childId: string
): Promise<Array<{ id: string; text: string; voice: boolean }>> {
  const data = await http<{ reminders?: Array<{ id: string; text: string; voice: boolean }> }>(
    `/scheduler/reminders?childId=${encodeURIComponent(childId)}`
  );
  return data?.reminders ?? [];
}

/** 单轮提醒检查（cron "* * * * *" 的 Web 等价：当前孩子 → 自定义提醒拉取 + 课程时间点匹配）。 */
async function reminderTick(): Promise<void> {
  const childId = activeChildId;
  if (!childId || !getStoredToken()) return;

  // ISSUE-047：孩子自建提醒——服务端已按频率就地去重，客户端仅需把结果广播给孩子端
  try {
    const due = await fetchDueReminders(childId);
    for (const r of due) {
      emitCustomReminder(childId, r.text, r.voice ? "both" : "chime");
    }
  } catch (e) {
    console.error(`[web-shim] Fetch due reminders failed for child ${childId}:`, e);
  }

  // ISSUE-019/059：课程时间段提醒（本地配置时间点匹配；配置来自 config-sync 的 scheduler_config）
  const cached = getCachedSchedulerConfig();
  if (!cached) return;
  const cc = normalizeChildConfig(childrenSection(cached)[childId]);
  const effective = getEffectiveClassTimes(cc, new Date());
  if (effective.length === 0) return;
  const now = new Date();
  const nowMin = hhmm(now);
  for (const ct of effective) {
    if (!ct.start || !ct.end) continue;
    const fire = (type: "start" | "end") => {
      const key = `${now.toDateString()}:${type}:${type === "start" ? ct.start : ct.end}:${ct.label || ""}`;
      if (classReminderLastKey.get(childId) === key) return;
      classReminderLastKey.set(childId, key);
      emitClassReminder(childId, type, ct.label, cc.classAlertMode);
    };
    if (nowMin === ct.start) fire("start");
    if (nowMin === ct.end) fire("end");
  }
}

/** 启动 60s 提醒轮询（幂等；由 childSelect/childAuth 惰性触发 + misc.startMiscLoops 显式启动）。 */
export function ensureReminderLoop(): void {
  if (reminderTimer) return;
  reminderTimer = setInterval(() => {
    void reminderTick().catch(() => {});
  }, 60_000);
}

// ---------------------------------------------------------------------------
// window.api 方法
// ---------------------------------------------------------------------------

export const schedulerDomain = {
  /** onClassReminder: (callback) => void（class:reminder 事件订阅，经 eventBus 派发；preload 为 void 返回） */
  onClassReminder: (callback: (data: {
    childId: string;
    type: "start" | "end" | "custom";
    label: string;
    mode?: "both" | "chime" | "voice";
  }) => void): void => {
    eventBus.on("class:reminder", callback);
  },

  /** schedulerConfigGet: () => Promise<{ success: boolean; configs?: Record<string, SchedulerChildConfig>; parent?: unknown; error?: string }> */
  schedulerConfigGet: async (): Promise<{
    success: boolean;
    configs?: Record<string, SchedulerChildConfig>;
    parent?: unknown;
    error?: string;
  }> => {
    try {
      const root = await getSchedulerConfigRoot();
      const sections = childrenSection(root);
      const configs: Record<string, SchedulerChildConfig> = {};
      for (const [childId, cfg] of Object.entries(sections)) {
        configs[childId] = normalizeChildConfig(cfg);
      }
      const parent = root.parent
        ? { autoNewSession: { ...DEFAULT_PARENT_CONFIG.autoNewSession, ...((root.parent as any).autoNewSession || {}) } }
        : JSON.parse(JSON.stringify(DEFAULT_PARENT_CONFIG));
      return { success: true, configs, parent };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerConfigSet: (childId, config) => Promise<{ success: boolean; config?: SchedulerChildConfig; error?: string }> */
  schedulerConfigSet: async (
    childId: string,
    config: any
  ): Promise<{ success: boolean; config?: SchedulerChildConfig; error?: string }> => {
    try {
      const root = await getSchedulerConfigRoot();
      const sections = childrenSection(root);
      sections[childId] = normalizeChildConfig(config);
      root.children = sections;
      await pushSchedulerConfig(root);
      return { success: true, config: sections[childId] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerParentConfigSet: (config) => Promise<{ success: boolean; config?: unknown; error?: string }>（整体替换 parent 段） */
  schedulerParentConfigSet: async (config: any): Promise<{ success: boolean; config?: unknown; error?: string }> => {
    try {
      const root = await getSchedulerConfigRoot();
      root.parent = {
        autoNewSession: { ...DEFAULT_PARENT_CONFIG.autoNewSession, ...(config?.autoNewSession || {}) },
      };
      await pushSchedulerConfig(root);
      return { success: true, config: root.parent };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerTasksList: () => Promise<{ success: boolean; tasks?: unknown[]; error?: string }>（GET /scheduler/tasks） */
  schedulerTasksList: async (): Promise<{ success: boolean; tasks?: unknown[]; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ tasks?: unknown[] }>("/scheduler/tasks");
      return { success: true, tasks: data?.tasks ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerTaskCreate: (payload) => Promise<{ success: boolean; task?: unknown; error?: string }>（POST /scheduler/tasks） */
  schedulerTaskCreate: async (payload: {
    name: string;
    type: string;
    time: string;
    extra?: Record<string, unknown>;
  }): Promise<{ success: boolean; task?: unknown; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ ok: boolean; task?: unknown }>("/scheduler/tasks", {
        method: "POST",
        body: payload,
      });
      return { success: !!data?.ok, task: data?.task };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerTaskUpdate: (id, patch) => Promise<{ success: boolean; error?: string }>（PATCH /scheduler/tasks/:id） */
  schedulerTaskUpdate: async (
    id: string,
    patch: {
      name?: string;
      time?: string;
      enabled?: boolean;
      extra?: Record<string, unknown>;
    }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: patch,
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerTaskDelete: (id) => Promise<{ success: boolean; error?: string }>（DELETE /scheduler/tasks/:id） */
  schedulerTaskDelete: async (id: string): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerTaskAssign: (id, childId, enabled) => Promise<{ success: boolean; error?: string }>（POST /scheduler/tasks/:id/assign） */
  schedulerTaskAssign: async (
    id: string,
    childId: string,
    enabled: boolean
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ ok: boolean }>(`/scheduler/tasks/${encodeURIComponent(id)}/assign`, {
        method: "POST",
        body: { childId, enabled },
      });
      return { success: !!data?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerRunsList: (opts?) => Promise<{ success: boolean; runs?: unknown[]; error?: string }>（GET /scheduler/runs） */
  schedulerRunsList: async (opts?: {
    childId?: string;
    limit?: number;
  }): Promise<{ success: boolean; runs?: unknown[]; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const q = new URLSearchParams();
      if (opts?.childId) q.set("childId", opts.childId);
      if (opts?.limit) q.set("limit", String(opts.limit));
      const data = await http<{ runs?: unknown[] }>(
        `/scheduler/runs${q.toString() ? `?${q}` : ""}`
      );
      return { success: true, runs: data?.runs ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** schedulerEffectiveConfigGet: () => Promise<{ success: boolean; children?: Record<string, unknown>; error?: string }>（GET /scheduler/effective-config） */
  schedulerEffectiveConfigGet: async (): Promise<{
    success: boolean;
    children?: Record<string, unknown>;
    error?: string;
  }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ children?: Record<string, unknown> }>("/scheduler/effective-config");
      return { success: true, children: data?.children ?? {} };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** reminderList: (childId) => Promise<{ success: boolean; reminders?: unknown[]; error?: string }>（GET /scheduler/reminders/list?childId=） */
  reminderList: async (childId: string): Promise<{ success: boolean; reminders?: unknown[]; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ reminders?: unknown[] }>(
        `/scheduler/reminders/list?childId=${encodeURIComponent(childId)}`
      );
      return { success: true, reminders: data?.reminders ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** reminderCancel: (id) => Promise<{ success: boolean; error?: string }>（复用 scheduler:task:delete） */
  reminderCancel: async (id: string): Promise<{ success: boolean; error?: string }> => {
    return schedulerDomain.schedulerTaskDelete(id);
  },
};

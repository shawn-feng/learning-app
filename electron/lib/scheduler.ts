import fs from "fs";
import path from "path";
import cron from "node-cron";
import { getTaskStatePath, getSchedulerConfigPath, getChildDir } from "./config";
import { listChildren } from "./child-auth";
import { getSharedRuntime, getDefaultModel } from "./pi-runtime";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

interface TaskState {
  children: Record<
    string,
    {
      recording: { lastRun: string };
      "study-tracker": { lastRun: string };
    }
  >;
}

// 每个孩子独立的定时任务配置。默认（未配置）全部关闭。
export interface SchedulerChildConfig {
  recording: { enabled: boolean; intervalHours: number };
  studyTracker: { enabled: boolean; hour: number; minute: number };
}

interface SchedulerConfig {
  children: Record<string, SchedulerChildConfig>;
}

export const DEFAULT_CHILD_CONFIG: SchedulerChildConfig = {
  recording: { enabled: false, intervalHours: 1 },
  studyTracker: { enabled: false, hour: 21, minute: 0 },
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

function getChildState(state: TaskState, childId: string) {
  if (!state.children[childId]) {
    state.children[childId] = {
      recording: { lastRun: "" },
      "study-tracker": { lastRun: "" },
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
  };
  saveSchedulerConfig(config);
  return config.children[childId];
}

// ---- 会话与任务执行 ----

export async function createEphemeralSession(childId: string) {
  const childDir = getChildDir(childId);
  const runtime = await getSharedRuntime();
  const model = await getDefaultModel();

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
    model,
    sessionManager: SessionManager.inMemory(),
    tools: ["read", "write", "edit"],
  });
  return session;
}

function readRecentConversation(childId: string): string {
  const childDir = getChildDir(childId);
  const sessionsDir = path.join(childDir, ".pi", "agent", "sessions");
  if (!fs.existsSync(sessionsDir)) return "";

  // Find the most recent session file
  const files: { name: string; time: number }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".jsonl")) {
        files.push({ name: full, time: fs.statSync(full).mtimeMs });
      }
    }
  };
  walk(sessionsDir);

  if (files.length === 0) return "";
  files.sort((a, b) => b.time - a.time);
  const latest = files[0].name;

  const lines = fs.readFileSync(latest, "utf-8").split("\n").filter(Boolean);
  const parts: string[] = [];
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const content = extractText(entry);
      if (content) parts.push(content);
    } catch {
      // skip invalid lines
    }
  }
  return parts.slice(-50).join("\n");
}

function extractText(entry: any): string {
  if (entry.type === "user_message" && entry.message?.content) {
    const c = entry.message.content;
    if (typeof c === "string") return `孩子: ${c}`;
    if (Array.isArray(c)) {
      return `孩子: ${c
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ")}`;
    }
  }
  if (entry.type === "assistant_message" && entry.message?.content) {
    const c = entry.message.content;
    if (typeof c === "string") return `AI: ${c}`;
    if (Array.isArray(c)) {
      return `AI: ${c
        .filter((p: any) => p.type === "text")
        .map((p: any) => p.text)
        .join(" ")}`;
    }
  }
  if (entry.type === "tool_result_message") {
    const toolResults = entry.message?.toolResults;
    if (Array.isArray(toolResults)) {
      return toolResults
        .map((tr: any) => {
          const content = tr.content;
          if (typeof content === "string") return `工具结果: ${content}`;
          if (Array.isArray(content)) {
            return `工具结果: ${content
              .filter((p: any) => p.type === "text")
              .map((p: any) => p.text)
              .join(" ")}`;
          }
          return "";
        })
        .join("\n");
    }
  }
  return "";
}

async function runRecording(childId: string): Promise<void> {
  const conversation = readRecentConversation(childId);
  const session = await createEphemeralSession(childId);
  try {
    const prompt = `/skill:recording\n\n以下是最近的学习会话内容，请从中提取学习总结并更新学习记录文件：\n\n${conversation}`;
    await session.prompt(prompt);
  } finally {
    session.dispose();
  }
}

async function runTracker(childId: string): Promise<void> {
  const session = await createEphemeralSession(childId);
  try {
    await session.prompt("/skill:study-tracker");
  } finally {
    session.dispose();
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
            await runTracker(child.childId);
            cs["study-tracker"].lastRun = new Date().toISOString();
            saveTaskState(state);
          } catch (e) {
            console.error(`Tracker failed for child ${child.childId}:`, e);
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
          await runTracker(child.childId);
          cs["study-tracker"].lastRun = new Date().toISOString();
        } catch (e) {
          console.error(`Tracker catch-up failed for child ${child.childId}:`, e);
        }
      }
    }
  }

  saveTaskState(state);
}

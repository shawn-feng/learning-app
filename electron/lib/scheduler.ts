import fs from "fs";
import path from "path";
import cron from "node-cron";
import { getTaskStatePath, getChildDir } from "./config";
import { listChildren } from "./child-auth";
import { getChildSession } from "./pi-session";
import { getSharedRuntime } from "./pi-runtime";
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildChildSettings } from "./user-init";

interface TaskState {
  children: Record<
    string,
    {
      recording: { lastRun: string };
      "study-tracker": { lastRun: string };
    }
  >;
}

const HOUR_MS = 3600 * 1000;
const RECORDING_INTERVAL_HOURS = 1;
const TRACKER_HOUR = 21;

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

export async function createEphemeralSession(childId: string) {
  const childDir = getChildDir(childId);
  const runtime = await getSharedRuntime();

  const { session } = await createAgentSession({
    cwd: childDir,
    agentDir: path.join(childDir, ".pi", "agent"),
    modelRuntime: runtime,
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

export function startScheduler(): void {
  // Hourly recording check
  cron.schedule("0 * * * *", async () => {
    const state = loadTaskState();
    const children = listChildren();
    const now = Date.now();

    for (const child of children) {
      const cs = getChildState(state, child.childId);
      const last = cs.recording.lastRun ? new Date(cs.recording.lastRun).getTime() : 0;
      if (now - last >= RECORDING_INTERVAL_HOURS * HOUR_MS) {
        try {
          await runRecording(child.childId);
          cs.recording.lastRun = new Date().toISOString();
          saveTaskState(state);
        } catch (e) {
          console.error(`Recording failed for child ${child.childId}:`, e);
        }
      }
    }
  });

  // Daily tracker at 21:00
  cron.schedule(`0 ${TRACKER_HOUR} * * *`, async () => {
    const state = loadTaskState();
    const children = listChildren();

    for (const child of children) {
      const cs = getChildState(state, child.childId);
      try {
        await runTracker(child.childId);
        cs["study-tracker"].lastRun = new Date().toISOString();
        saveTaskState(state);
      } catch (e) {
        console.error(`Tracker failed for child ${child.childId}:`, e);
      }
    }
  });
}

export async function runCatchUp(): Promise<void> {
  const state = loadTaskState();
  const children = listChildren();
  const now = new Date();
  const today = now.toDateString();

  for (const child of children) {
    const cs = getChildState(state, child.childId);

    // Recording catch-up: if recording hasn't run in the last interval, run it
    const lastRec = cs.recording.lastRun ? new Date(cs.recording.lastRun).getTime() : 0;
    if (now.getTime() - lastRec >= RECORDING_INTERVAL_HOURS * HOUR_MS) {
      try {
        await runRecording(child.childId);
        cs.recording.lastRun = new Date().toISOString();
      } catch (e) {
        console.error(`Recording catch-up failed for child ${child.childId}:`, e);
      }
    }

    // Tracker catch-up: if tracker hasn't run today, run it
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

  saveTaskState(state);
}

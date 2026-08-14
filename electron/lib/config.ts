import { app } from "electron";
import path from "path";
import fs from "fs";

let dataDir: string;

export function getDataDir(): string {
  if (!dataDir) {
    if (app?.isPackaged) {
      dataDir = path.join(app.getPath("userData"), "app-data");
    } else {
      dataDir = path.join(process.cwd(), "data");
    }
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, "shared", "skills"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "children"), { recursive: true });
  }
  return dataDir;
}

export function getSharedDir(): string {
  return path.join(getDataDir(), "shared");
}

export function getSkillsDir(): string {
  return path.join(getSharedDir(), "skills");
}

export function getAuthPath(): string {
  return path.join(getSharedDir(), "auth.json");
}

export function getChildrenDir(): string {
  return path.join(getDataDir(), "children");
}

export function getChildDir(childId: string): string {
  return path.join(getChildrenDir(), childId);
}

export function getLicensePath(): string {
  return path.join(getDataDir(), "license.json");
}

export function getTaskStatePath(): string {
  return path.join(getDataDir(), "task-state.json");
}

export function getCloudApiBase(): string {
  return process.env["CLOUD_API_URL"] || "http://localhost:8000";
}

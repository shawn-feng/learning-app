import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getChildDir, getChildrenDir } from "./config";
import { initChildDirectory } from "./user-init";

export interface ChildProfile {
  childId: string;
  name: string;
  avatar: string;
  passwordHash: string;
  age: number;
  grade: string;
  interests: string;
  aiName: string;
  aiEmoji: string;
  aiPersonality: string;
  createdAt: string;
}

export async function addChild(data: {
  name: string;
  avatar: string;
  password: string;
  age: number;
  grade: string;
  interests: string;
  aiName: string;
  aiEmoji: string;
  aiPersonality: string;
}): Promise<ChildProfile> {
  const childId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(data.password, 10);

  const profile: ChildProfile = {
    childId,
    name: data.name,
    avatar: data.avatar,
    passwordHash,
    age: data.age,
    grade: data.grade,
    interests: data.interests,
    aiName: data.aiName,
    aiEmoji: data.aiEmoji || "🤖",
    aiPersonality: data.aiPersonality,
    createdAt: new Date().toISOString(),
  };

  await initChildDirectory(childId, profile);
  return profile;
}

export function listChildren(): ChildProfile[] {
  const childrenDir = getChildrenDir();
  if (!fs.existsSync(childrenDir)) return [];

  const profiles: ChildProfile[] = [];
  for (const entry of fs.readdirSync(childrenDir)) {
    const profilePath = path.join(childrenDir, entry, "profile.json");
    if (fs.existsSync(profilePath)) {
      try {
        profiles.push(JSON.parse(fs.readFileSync(profilePath, "utf-8")));
      } catch {
        // skip invalid profiles
      }
    }
  }
  return profiles;
}

export function getProfile(childId: string): ChildProfile | null {
  const profilePath = path.join(getChildDir(childId), "profile.json");
  if (!fs.existsSync(profilePath)) return null;
  return JSON.parse(fs.readFileSync(profilePath, "utf-8"));
}

export async function authChild(
  childId: string,
  password: string
): Promise<boolean> {
  const profile = getProfile(childId);
  if (!profile) return false;
  return bcrypt.compare(password, profile.passwordHash);
}

export async function resetChildPassword(
  childId: string,
  newPassword: string
): Promise<void> {
  const profile = getProfile(childId);
  if (!profile) throw new Error("Child not found");
  profile.passwordHash = await bcrypt.hash(newPassword, 10);
  fs.writeFileSync(
    path.join(getChildDir(childId), "profile.json"),
    JSON.stringify(profile, null, 2),
    "utf-8"
  );
}

// 孩子自行修改密码：先验证旧密码，通过后再更新
export async function changeChildPassword(
  childId: string,
  oldPassword: string,
  newPassword: string
): Promise<boolean> {
  const ok = await authChild(childId, oldPassword);
  if (!ok) return false;
  await resetChildPassword(childId, newPassword);
  return true;
}

export function updateChildProfile(
  childId: string,
  updates: Partial<Pick<ChildProfile, "aiName" | "aiEmoji" | "aiPersonality">>
): ChildProfile {
  const profile = getProfile(childId);
  if (!profile) throw new Error("Child not found");

  if (updates.aiName !== undefined) profile.aiName = updates.aiName;
  if (updates.aiEmoji !== undefined) profile.aiEmoji = updates.aiEmoji;
  if (updates.aiPersonality !== undefined) profile.aiPersonality = updates.aiPersonality;

  fs.writeFileSync(
    path.join(getChildDir(childId), "profile.json"),
    JSON.stringify(profile, null, 2),
    "utf-8"
  );

  // ISSUE-033：AGENTS 纯 SQLite（data/agents.sqlite）——改 profile 无需刷新任何文件，
  // 孩子开会话时 buildChildPrompt 经 resolveChildAgents 实时取「SQLite 用户版本 / 代码默认」。

  return profile;
}

export function deleteChild(childId: string): void {
  const childDir = getChildDir(childId);
  if (fs.existsSync(childDir)) {
    fs.rmSync(childDir, { recursive: true, force: true });
  }
}

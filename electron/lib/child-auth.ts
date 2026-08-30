import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { getChildDir, getChildrenDir, getServerUrl } from "./config";
import { initChildDirectory } from "./user-init";
import { serverFetch } from "./server-client";
import { currentSessionToken } from "./client-data";

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
  // SPLIT：孩子账户同步到服务端（多设备共享、避免重复创建）。
  // 服务端不可用/未登录时不阻塞本地创建（离线可用；在线后该设备登录即可从服务端看到列表）。
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      await serverFetch<{ child: { id: string } }>("/children", {
        method: "POST",
        body: { id: childId, name: data.name },
        token,
      });
    } catch {
      // 同步失败仅跳过（本地已创建）
    }
  }
  return profile;
}

/** 本地 children 目录扫描（离线/未登录回退）。 */
function readLocalProfiles(): ChildProfile[] {
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

/**
 * 孩子列表（SPLIT：孩子账户唯一真源在服务端，多设备共享避免重复创建）。
 * - 已配置服务端且家长已登录（有 session token）：从 GET /api/v1/children 拉取；
 *   本地已有 profile 的孩子补充完整详情；服务端有、本地没有的孩子（他设备创建）
 *   自动落盘默认 profile（占位详情），保证各设备看到同一份孩子列表。
 * - 未登录 / 服务端不可用：回退本地扫描（离线可用）。
 */
export async function listChildren(): Promise<ChildProfile[]> {
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      const data = await serverFetch<{ children?: Array<{ id: string; name: string; created_at?: string }> }>(
        "/children",
        { token }
      );
      const remote = data?.children;
      if (Array.isArray(remote)) {
        const local = readLocalProfiles();
        const byId = new Map(local.map((p) => [p.childId, p]));
        const out: ChildProfile[] = [];
        for (const c of remote) {
          const lp = byId.get(c.id);
          if (lp) {
            out.push(lp);
            continue;
          }
          // 服务端有、本地无 → 落盘默认 profile（详情可在本设备补录；后续版本支持详情上云）
          const placeholder: ChildProfile = {
            childId: c.id,
            name: c.name,
            avatar: "🧸",
            passwordHash: "",
            age: 0,
            grade: "",
            interests: "",
            aiName: "学习伙伴",
            aiEmoji: "🤖",
            aiPersonality: "温暖、耐心、靠谱。",
            createdAt: c.created_at ?? new Date().toISOString(),
          };
          try {
            const dir = path.join(getChildrenDir(), c.id);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(placeholder, null, 2), "utf-8");
          } catch {
            // 落盘失败不阻塞列表（仅内存返回）
          }
          out.push(placeholder);
        }
        return out;
      }
    } catch {
      // 服务端不可用/会话失效 → 回退本地扫描
    }
  }
  return readLocalProfiles();
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

export async function deleteChild(childId: string): Promise<void> {
  const childDir = getChildDir(childId);
  if (fs.existsSync(childDir)) {
    fs.rmSync(childDir, { recursive: true, force: true });
  }
  // SPLIT：同步删除服务端孩子账户（失败不阻塞本地删除）
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      await serverFetch<{ ok: boolean }>(`/children/${childId}`, { method: "DELETE", token });
    } catch {
      // 同步失败仅跳过
    }
  }
}

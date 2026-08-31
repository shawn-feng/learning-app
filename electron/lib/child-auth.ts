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
  /** 学习进度摘要（ISSUE-001：来自服务端 /children 聚合；离线/未知为 null） */
  progress?: { topics: number; learned: number; total: number; lastUpdated: string } | null;
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
  // SPLIT：孩子账户 + profile（含密码哈希）同步到服务端（多设备共享、避免重复创建）。
  // 服务端不可用/未登录时不阻塞本地创建（离线可用；在线后该设备登录即可从服务端看到列表）。
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      await serverFetch<{ child: { id: string } }>("/children", {
        method: "POST",
        body: { id: childId, name: data.name, profile: childProfilePayload(profile) },
        token,
      });
    } catch {
      // 同步失败仅跳过（本地已创建）
    }
  }
  return profile;
}

/** ChildProfile → 上传服务端的 profile 载荷（全字段，含 passwordHash）。 */
function childProfilePayload(p: ChildProfile): Record<string, unknown> {
  return {
    avatar: p.avatar,
    age: p.age,
    grade: p.grade,
    interests: p.interests,
    aiName: p.aiName,
    aiEmoji: p.aiEmoji,
    aiPersonality: p.aiPersonality,
    passwordHash: p.passwordHash,
    createdAt: p.createdAt,
  };
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
 * 孩子列表（SPLIT：孩子账户 + profile 详情/密码唯一真源在服务端，多设备共享）。
 * - 已配置服务端且家长已登录：从 GET /api/v1/children 拉取（含 profile 详情）；
 *   本地已有完整 profile 的孩子直接用；服务端有、本地无 → 用服务端详情落盘本地缓存；
 *   **本地有详情而服务端无（旧设备孩子未上云）→ 自动 PATCH 上传**（详情+密码哈希一次上云）。
 * - 未登录 / 服务端不可用：回退本地扫描（离线可用）。
 */
export async function listChildren(): Promise<ChildProfile[]> {
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      const data = await serverFetch<{
        children?: Array<{
          id: string;
          name: string;
          created_at?: string;
          profile?: Record<string, unknown>;
          progress?: { topics?: number; learned?: number; total?: number; lastUpdated?: string } | null;
        }>;
      }>("/children", { token });
      const remote = data?.children;
      if (Array.isArray(remote)) {
        const local = readLocalProfiles();
        const byId = new Map(local.map((p) => [p.childId, p]));
        const out: ChildProfile[] = [];
        for (const c of remote) {
          const lp = byId.get(c.id);
          const sp = (c.profile ?? {}) as Partial<ChildProfile>;
          // 进度摘要（ISSUE-001）：服务端聚合值原样透传（null 表示未知）
          const progress = c.progress
            ? {
                topics: Number(c.progress.topics ?? 0),
                learned: Number(c.progress.learned ?? 0),
                total: Number(c.progress.total ?? 0),
                lastUpdated: String(c.progress.lastUpdated ?? ""),
              }
            : null;
          // 服务端有详情 → 合并（以服务端为准）并落盘；本地有而服务端无 → 上传本地（详情/密码上云）
          if (sp.passwordHash || sp.avatar || sp.age) {
            const merged: ChildProfile = {
              childId: c.id,
              name: c.name,
              avatar: String(sp.avatar ?? lp?.avatar ?? "🧸"),
              passwordHash: String(sp.passwordHash ?? lp?.passwordHash ?? ""),
              age: Number(sp.age ?? lp?.age ?? 0),
              grade: String(sp.grade ?? lp?.grade ?? ""),
              interests: String(sp.interests ?? lp?.interests ?? ""),
              aiName: String(sp.aiName ?? lp?.aiName ?? "学习伙伴"),
              aiEmoji: String(sp.aiEmoji ?? lp?.aiEmoji ?? "🤖"),
              aiPersonality: String(sp.aiPersonality ?? lp?.aiPersonality ?? "温暖、耐心、靠谱。"),
              createdAt: String(sp.createdAt ?? lp?.createdAt ?? c.created_at ?? new Date().toISOString()),
              progress,
            };
            try {
              const dir = path.join(getChildrenDir(), c.id);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(path.join(dir, "profile.json"), JSON.stringify(merged, null, 2), "utf-8");
            } catch {
              // 落盘失败不阻塞列表
            }
            out.push(merged);
            continue;
          }
          if (lp) {
            // 本地有完整详情、服务端无详情。
            // ⚠️ 2026-08-31 事故教训（珊珊/闻闻密码哈希被覆盖导致登录失败）：自动上传会把本地
            // passwordHash 覆盖到服务端，若本地哈希已非当前密码则登录全废。双保险：
            // ① 客户端：本地已设置密码（passwordHash 非空）时【绝不自动上传】——只有从未设过
            //    密码的孩子才自动上传详情；本地有密码的孩子照常可用（authChild 服务端失败后回退
            //    本地 bcrypt），家长在详情页显式保存/重置密码时经 syncProfileToServer（forcePassword）
            //    正式上云。
            // ② 服务端：PATCH 无 forcePassword 标志时忽略 passwordHash 字段（防任何路径覆盖）。
            if (!lp.passwordHash) {
              try {
                await serverFetch(`/children/${c.id}`, {
                  method: "PATCH",
                  body: { profile: childProfilePayload(lp) },
                  token,
                });
              } catch {
                // 上传失败不阻塞列表
              }
            }
            out.push(lp);
            continue;
          }
          // 两边都无详情 → 占位
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
  // SPLIT：密码校验以服务端为准（多设备共享同一密码）；服务端不可用/未登录回退本地哈希校验（离线）。
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      const r = await serverFetch<{ ok: boolean }>("/children/auth", {
        method: "POST",
        body: { id: childId, password },
        token,
      });
      return !!r?.ok;
    } catch {
      // 服务端校验失败 → 回退本地
    }
  }
  const profile = getProfile(childId);
  if (!profile || !profile.passwordHash) return false;
  return bcrypt.compare(password, profile.passwordHash);
}

/** 把 profile（含新密码哈希/详情）同步到服务端 PATCH /children/:id。
 *  仅由显式用户操作调用（重置密码/改详情），带 forcePassword 标志允许覆盖密码哈希
 *  （服务端对无标志的 PATCH 忽略 passwordHash，见 server children.ts 事故防护）。 */
async function syncProfileToServer(childId: string, profile: ChildProfile): Promise<void> {
  const token = currentSessionToken();
  if (getServerUrl() && token) {
    try {
      await serverFetch(`/children/${childId}`, {
        method: "PATCH",
        body: { profile: childProfilePayload(profile), forcePassword: true },
        token,
      });
    } catch {
      // 同步失败仅跳过（本地已更新）
    }
  }
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
  await syncProfileToServer(childId, profile);
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
  // 详情同步服务端（多设备共享）
  void syncProfileToServer(childId, profile);

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

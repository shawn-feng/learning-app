/**
 * children 域（Phase 2 实现）——移植 electron/lib/ipc-handlers.ts 的 child:* 通道 +
 * electron/lib/child-auth.ts 的实现语义，映射到 /api/v1/children* 路由：
 *   - childAdd：上限校验（云端 license max_children 优先，对齐 ipc child:add）→
 *     本地生成 UUID + bcrypt 密码哈希（bcryptjs 为纯 JS 实现，浏览器可用；自根
 *     node_modules 解析）→ POST /children {id, name, profile(含 passwordHash)}；
 *     服务端另有 403 兜底校验（双保险与客户端一致）。
 *   - childList：GET /children → 还原 ipc listChildren() 给渲染层的 ChildProfile 结构
 *     （childId/name/avatar/age/grade/interests/ai 字段/createdAt + progress 进度摘要透传；
 *     Web 无本地 profile 缓存，服务端 profile 缺字段时用与 listChildren 相同的兜底默认）。
 *   - childSelect：GET /children 校验存在性 → {success, profile}；成功时记内存「当前孩子」
 *     （scheduler 提醒轮询用，见 scheduler.ts noteActiveChild）。
 *   - childAuth：POST /children/auth {id, password} → {success: ok}；成功同样记当前孩子。
 *   - childDelete：DELETE /children/:id（服务端删除即真删，错误自然 reject——对齐 ipc 不捕获的形态）。
 *   - childResetPassword / childChangePassword：bcrypt 新哈希 + PATCH /children/:id
 *     {profile:{passwordHash}, forcePassword:true}（对齐 syncProfileToServer 的事故防护标志）。
 *   - childUpdateProfile：PATCH 合并 ai* 字段（对齐 updateChildProfile）。
 *   - childGetAgentsMd / childSaveAgentsMd：走 db RPC agents.get / agents.save
 *     （scope="child"，对齐 ipc 经 fetchAgentPromptRemote/saveAgentPrompt 的服务端真源路径）。
 */
import bcrypt from "bcryptjs";
import { http, getStoredLicense } from "../core/server-fetch";
import { dbQuery, dbExec } from "./db";
import { noteActiveChild, ensureReminderLoop } from "./scheduler";

/** 渲染层消费的孩子档案结构（对齐 electron/lib/child-auth.ts ChildProfile）。 */
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
  /** 学习进度摘要（服务端 /children 聚合；null = 未知） */
  progress?: { topics: number; learned: number; total: number; lastUpdated: string } | null;
}

/** 服务端 GET /children 的行结构。 */
interface ServerChild {
  id: string;
  name: string;
  created_at?: string;
  profile?: Record<string, unknown>;
  progress?: { topics?: number; learned?: number; total?: number; lastUpdated?: string } | null;
}

/** GET /children：所有域共用的拉取入口。 */
async function fetchServerChildren(): Promise<ServerChild[]> {
  const data = await http<{ children?: ServerChild[] }>("/children");
  return Array.isArray(data?.children) ? data.children : [];
}

/** 服务端行 → ChildProfile（缺省兜底对齐 listChildren 的占位逻辑）。 */
function toChildProfile(c: ServerChild): ChildProfile {
  const sp = (c.profile ?? {}) as Partial<ChildProfile>;
  const progress = c.progress
    ? {
        topics: Number(c.progress.topics ?? 0),
        learned: Number(c.progress.learned ?? 0),
        total: Number(c.progress.total ?? 0),
        lastUpdated: String(c.progress.lastUpdated ?? ""),
      }
    : null;
  return {
    childId: c.id,
    name: c.name,
    avatar: String(sp.avatar ?? "🧸"),
    passwordHash: String(sp.passwordHash ?? ""),
    age: Number(sp.age ?? 0),
    grade: String(sp.grade ?? ""),
    interests: String(sp.interests ?? ""),
    aiName: String(sp.aiName ?? "学习伙伴"),
    aiEmoji: String(sp.aiEmoji ?? "🤖"),
    aiPersonality: String(sp.aiPersonality ?? "温暖、耐心、靠谱。"),
    createdAt: String(sp.createdAt ?? c.created_at ?? new Date().toISOString()),
    progress,
  };
}

/** ChildProfile → 上传服务端的 profile 载荷（对齐 childProfilePayload，全字段）。 */
function childProfilePayload(p: Partial<ChildProfile>): Record<string, unknown> {
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

/** 云端复核许可（对齐 ipc child:add 的 verifyLicenseWithCloud 用法；不可达时用本地缓存值）。 */
async function cloudMaxChildren(): Promise<number> {
  const license = getStoredLicense();
  if (!license) return -1; // 无凭证：跳过客户端侧上限（服务端仍兜底）
  let maxChildren = license.max_children;
  try {
    const r = await http<{ license: { is_expired?: boolean; max_children?: number } }>(
      "/auth/license",
      { token: license.token }
    );
    maxChildren = Number(r.license.max_children ?? maxChildren);
  } catch {
    // 云端不可达：信任本地 license.max_children（对齐 ipc：cloud===null 时不覆盖）
  }
  return maxChildren;
}

export const childrenDomain = {
  /** childAdd: (data) => Promise<{ success: boolean; profile?: ChildProfile; error?: string }>（POST /children；上限以云端 license 为准） */
  childAdd: async (data: {
    name: string;
    avatar: string;
    password: string;
    age: number;
    grade: string;
    interests: string;
    aiName: string;
    aiEmoji: string;
    aiPersonality: string;
  }): Promise<{ success: boolean; profile?: ChildProfile; error?: string }> => {
    try {
      const maxChildren = await cloudMaxChildren();
      if (maxChildren >= 0) {
        const children = await fetchServerChildren();
        if (children.length >= maxChildren) {
          return { success: false, error: "已达孩子数量上限" };
        }
      }
      const childId = crypto.randomUUID();
      const passwordHash = await bcrypt.hash(data.password, 10);
      const createdAt = new Date().toISOString();
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
        createdAt,
        progress: null,
      };
      await http("/children", {
        method: "POST",
        body: { id: childId, name: data.name, profile: childProfilePayload(profile) },
      });
      return { success: true, profile };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** childList: () => Promise<ChildProfile[]>（GET /children → 渲染层消费的 children+progress 结构） */
  childList: async (): Promise<ChildProfile[]> => {
    const rows = await fetchServerChildren();
    return rows.map(toChildProfile);
  },

  /** childSelect: (childId) => Promise<{ success: boolean; profile?: ChildProfile; error?: string }>（成功时记录当前孩子，驱动提醒轮询） */
  childSelect: async (childId: string): Promise<{ success: boolean; profile?: ChildProfile; error?: string }> => {
    const rows = await fetchServerChildren();
    const hit = rows.find((c) => c.id === childId);
    if (!hit) return { success: false, error: "孩子不存在" };
    noteActiveChild(childId);
    ensureReminderLoop();
    return { success: true, profile: toChildProfile(hit) };
  },

  /** childAuth: (childId, password) => Promise<{ success: boolean }>（POST /children/auth；成功记录当前孩子） */
  childAuth: async (childId: string, password: string): Promise<{ success: boolean }> => {
    const r = await http<{ ok: boolean }>("/children/auth", {
      method: "POST",
      body: { id: childId, password },
    });
    const ok = !!r?.ok;
    if (ok) {
      noteActiveChild(childId);
      ensureReminderLoop();
    }
    return { success: ok };
  },

  /**
   * childDelete: (childId) => Promise<{ success: boolean }>（DELETE /children/:id）
   * 对齐 ipc child:delete 语义：Electron 端 deleteChild 吞掉服务端错误、通道恒 resolve
   * {success:true}（渲染层 ChildDetailPage 直接 await 后 onDeleted，无 try/catch）。
   * Web 同样恒 resolve——删除失败时仅记日志，孩子卡片会在下次 childList 拉取时按服务端真源复现。
   */
  childDelete: async (childId: string): Promise<{ success: boolean }> => {
    try {
      await http(`/children/${encodeURIComponent(childId)}`, { method: "DELETE" });
    } catch (err) {
      console.error(`[web-shim] childDelete(${childId}) failed:`, (err as Error).message);
    }
    return { success: true };
  },

  /** childResetPassword: (childId, newPassword) => Promise<{ success: boolean }>（bcrypt 哈希 + PATCH forcePassword） */
  childResetPassword: async (childId: string, newPassword: string): Promise<{ success: boolean }> => {
    const rows = await fetchServerChildren();
    const hit = rows.find((c) => c.id === childId);
    if (!hit) throw new Error(`未找到孩子档案（childId=${childId}），请确认孩子仍存在`);
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await http(`/children/${encodeURIComponent(childId)}`, {
      method: "PATCH",
      body: { profile: { passwordHash }, forcePassword: true },
    });
    return { success: true };
  },

  /** childChangePassword: (childId, old, new) => Promise<{ success: boolean; error?: string }>（先验旧密码再重置，对齐 changeChildPassword） */
  childChangePassword: async (
    childId: string,
    oldPassword: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> => {
    const auth = await http<{ ok: boolean }>("/children/auth", {
      method: "POST",
      body: { id: childId, password: oldPassword },
    });
    if (!auth?.ok) return { success: false, error: "旧密码不正确" };
    const passwordHash = await bcrypt.hash(newPassword, 10);
    await http(`/children/${encodeURIComponent(childId)}`, {
      method: "PATCH",
      body: { profile: { passwordHash }, forcePassword: true },
    });
    return { success: true };
  },

  /** childUpdateProfile: (childId, updates) => Promise<{ success: boolean; profile?: ChildProfile; error?: string }>（PATCH 合并 ai* 字段） */
  childUpdateProfile: async (
    childId: string,
    updates: Record<string, string>
  ): Promise<{ success: boolean; profile?: ChildProfile; error?: string }> => {
    try {
      const rows = await fetchServerChildren();
      const hit = rows.find((c) => c.id === childId);
      if (!hit) {
        return { success: false, error: `未找到孩子档案（childId=${childId}），请确认孩子仍存在` };
      }
      const current = toChildProfile(hit);
      const profile: ChildProfile = {
        ...current,
        ...(updates.aiName !== undefined ? { aiName: updates.aiName } : {}),
        ...(updates.aiEmoji !== undefined ? { aiEmoji: updates.aiEmoji } : {}),
        ...(updates.aiPersonality !== undefined ? { aiPersonality: updates.aiPersonality } : {}),
      };
      await http(`/children/${encodeURIComponent(childId)}`, {
        method: "PATCH",
        body: { profile: childProfilePayload(profile) },
      });
      return { success: true, profile };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * childGetAgentsMd: (childId) => Promise<{ content: string; network: boolean }>
   * 对齐 ipc child:getAgentsMd：agents.get 远程取用户版本；无用户版本返回空串底稿
   * （Electron 端此处返回代码默认 buildAgentsMd，Web 无本地代码默认，以空串代替）；
   * 服务端不可达 → network:true 降级标记。
   */
  childGetAgentsMd: async (childId: string): Promise<{ content: string; network: boolean }> => {
    try {
      const r = await dbQuery<{ content: string | null }>("agents.get", {
        scope: "child",
        ref: childId,
      });
      return { content: r.content !== null ? r.content : "", network: false };
    } catch {
      return { content: "", network: true };
    }
  },

  /** childSaveAgentsMd: (childId, content) => Promise<{ success: boolean; error?: string }>（agents.save，空内容=恢复默认） */
  childSaveAgentsMd: async (childId: string, content: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await dbExec("agents.save", { scope: "child", ref: childId, content });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

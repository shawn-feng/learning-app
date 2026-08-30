/**
 * 孩子管理（家长维度）：创建 / 列表 / 详情更新 / 密码校验 / 删除。
 * 孩子数据在服务端（kb 独立文件，见 db/kb.ts）；**孩子 profile 详情（头像/年龄/AI 名）
 * 与密码哈希存 children.profile_json**，登录密码由服务端校验（2026-08-30 起多设备共享）。
 * 删除孩子仅删 children 行，其 kb 文件保留（本期不做物理删除，避免误删学习数据）。
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";

interface ChildrenDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

/** 孩子详情字段（与客户端 ChildProfile 对齐；passwordHash 只在有值时写入）。 */
interface ChildProfilePayload {
  avatar?: string;
  age?: number;
  grade?: string;
  interests?: string;
  aiName?: string;
  aiEmoji?: string;
  aiPersonality?: string;
  passwordHash?: string;
  createdAt?: string;
}

function parseProfile(row: { profile_json: string | null }, fallback: { id: string; name: string; created_at: string }): Record<string, unknown> {
  let p: Record<string, unknown> = {};
  if (row.profile_json) {
    try {
      p = JSON.parse(row.profile_json) as Record<string, unknown>;
    } catch {
      p = {};
    }
  }
  return { ...p, childId: fallback.id, name: fallback.name, createdAt: fallback.created_at };
}

/** 单个孩子的学习进度摘要（ISSUE-001：家长卡片展示用）。读孩子 kb 的 topic_progress 视图聚合。 */
function childProgressSummary(dataDir: string, parentId: string, childId: string): Record<string, unknown> {
  const db = openKb(dataDir, parentId, childId);
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS topics,
                COALESCE(SUM(learned), 0) AS learned,
                COALESCE(SUM(total), 0) AS total,
                COALESCE(MAX(updated), '') AS updated
         FROM topic_progress`
      )
      .get() as { topics: number; learned: number; total: number; updated: string };
    return {
      topics: Number(row?.topics ?? 0),
      learned: Number(row?.learned ?? 0),
      total: Number(row?.total ?? 0),
      lastUpdated: String(row?.updated ?? ""),
    };
  } finally {
    db.close();
  }
}

export function registerChildrenRoutes(app: FastifyInstance, deps: ChildrenDeps): void {
  app.post("/api/v1/children", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    // id 可选：客户端可传本地生成的 childId（多设备共享同一 id，避免两端对不上）；
    // 不传/非法时服务端生成。
    const { name, id: reqId, profile } = (req.body ?? {}) as { name?: string; id?: string; profile?: ChildProfilePayload };
    if (!name?.trim()) return reply.code(400).send({ error: "name 必填" });
    const id = reqId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reqId) ? reqId : crypto.randomUUID();
    const now = new Date().toISOString();
    const profileJson = profile ? JSON.stringify({ ...profile, createdAt: profile.createdAt ?? now }) : null;
    deps.db
      .prepare("INSERT INTO children (id, parent_id, name, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, parentId, name.trim(), profileJson, now, now);
    return { child: { id, parent_id: parentId, name: name.trim(), profile: profileJson ? JSON.parse(profileJson) : null, created_at: now } };
  });

  app.get("/api/v1/children", async (req) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const rows = deps.db
      .prepare("SELECT id, name, profile_json, created_at FROM children WHERE parent_id = ? ORDER BY created_at")
      .all(parentId) as Array<{ id: string; name: string; profile_json: string | null; created_at: string }>;
    return {
      children: rows.map((r) => ({
        id: r.id,
        name: r.name,
        created_at: r.created_at,
        profile: parseProfile(r, { id: r.id, name: r.name, created_at: r.created_at }),
        // ISSUE-001：学习进度摘要（聚合自孩子 kb topic_progress，供家长卡片展示）
        progress: childProgressSummary(deps.config.dataDir, parentId, r.id),
      })),
    };
  });

  app.post("/api/v1/children/auth", async (req, reply) => {
    // 孩子登录密码校验（服务端为唯一校验方，2026-08-30 起多设备共享）
    const parentId = authParent(req, deps.config.jwtSecret);
    const { id, password } = (req.body ?? {}) as { id?: string; password?: string };
    if (!id || !password) return reply.code(400).send({ error: "id 与 password 必填" });
    const row = deps.db
      .prepare("SELECT profile_json FROM children WHERE id = ? AND parent_id = ?")
      .get(id, parentId) as { profile_json: string | null } | undefined;
    if (!row) return reply.code(403).send({ error: "无权访问该孩子" });
    const p = row.profile_json ? (JSON.parse(row.profile_json) as { passwordHash?: string }) : {};
    if (!p.passwordHash) return reply.code(400).send({ error: "该孩子未设置密码（请家长先重置密码）" });
    const ok = await bcrypt.compare(password, p.passwordHash);
    return { ok };
  });

  app.patch("/api/v1/children/:id", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { id } = req.params as { id: string };
    const { name, profile } = (req.body ?? {}) as { name?: string; profile?: ChildProfilePayload };
    if (!name?.trim() && profile === undefined) return reply.code(400).send({ error: "name 或 profile 必填" });
    const row = deps.db
      .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该孩子" });
    if (name?.trim()) {
      deps.db.prepare("UPDATE children SET name = ?, updated_at = ? WHERE id = ?").run(name.trim(), new Date().toISOString(), id);
    }
    if (profile !== undefined) {
      const cur = deps.db.prepare("SELECT profile_json FROM children WHERE id = ?").get(id) as { profile_json: string | null };
      let merged: Record<string, unknown> = {};
      if (cur.profile_json) {
        try {
          merged = JSON.parse(cur.profile_json) as Record<string, unknown>;
        } catch {
          merged = {};
        }
      }
      Object.assign(merged, profile);
      deps.db.prepare("UPDATE children SET profile_json = ?, updated_at = ? WHERE id = ?").run(JSON.stringify(merged), new Date().toISOString(), id);
    }
    return { ok: true };
  });

  app.delete("/api/v1/children/:id", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { id } = req.params as { id: string };
    const row = deps.db
      .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
      .get(id, parentId);
    if (!row) return reply.code(403).send({ error: "无权访问该孩子" });
    // 仅删除 children 行；kb 文件本期保留（防误删学习数据）
    deps.db.prepare("DELETE FROM children WHERE id = ?").run(id);
    return { ok: true };
  });
}

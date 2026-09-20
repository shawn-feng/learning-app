/**
 * 错题/生字本路由（ISSUE-114）：
 * - POST /api/v1/kb/:childId/mistakes          上报/合并一条（C2 查词浮层自动采 + 客户端主动记录）
 * - GET  /api/v1/kb/:childId/mistakes          清单（?status=open&kind=unknown_word&limit=50）
 * - POST /api/v1/kb/:childId/mistakes/action   { id, action: mastered | dismissed | reopen }
 * 鉴权：家长 JWT + children.parent_id 归属校验（客户端孩子 GUI 持家庭 license token，既有口径）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import {
  listMistakes,
  setMistakeStatus,
  upsertMistake,
  type MistakeKind,
  type MistakeStatus,
  type MistakeUpsert,
} from "../db/mistakes.js";

interface MistakeDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

const KINDS: MistakeKind[] = ["wrong_question", "unknown_word", "weak_point"];

function authParent(req: FastifyRequest, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

function assertChildOwned(db: DatabaseSync, parentId: string, childId: string): void {
  const ok = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
  if (!ok) throw new ApiError(403, "无权访问该孩子的数据");
}

export function registerMistakeRoutes(app: FastifyInstance, deps: MistakeDeps): void {
  const withChild = async <T>(req: FastifyRequest, childId: string, fn: (parentId: string) => T): Promise<T> => {
    const parentId = authParent(req, deps.config.jwtSecret);
    assertChildOwned(deps.db, parentId, childId);
    return fn(parentId);
  };

  app.post("/api/v1/kb/:childId/mistakes", async (req: FastifyRequest, reply: FastifyReply) => {
    const { childId } = req.params as { childId: string };
    const body = (req.body ?? {}) as Partial<MistakeUpsert>;
    const kind = body.kind as MistakeKind;
    if (!KINDS.includes(kind)) throw new ApiError(400, `kind 必须是 ${KINDS.join("/")}`);
    const content = String(body.content ?? "").trim();
    if (!content) throw new ApiError(400, "content 必填（错题摘要或字词）");
    const m: MistakeUpsert = {
      kind,
      content: content.slice(0, 2000),
      detail: String(body.detail ?? "").slice(0, 4000),
      source: ["conversation", "lookup", "exam"].includes(String(body.source)) ? String(body.source) : "conversation",
      source_ref: String(body.source_ref ?? "").slice(0, 200),
      question_id: String(body.question_id ?? "").slice(0, 200),
      course_ref: String(body.course_ref ?? "").slice(0, 200),
      knowledge_point_id: String(body.knowledge_point_id ?? "").slice(0, 200),
      knowledge_point_name: String(body.knowledge_point_name ?? "").slice(0, 200),
    };
    return withChild(req, childId, async (parentId) => {
      const row = upsertMistake(deps.config.dataDir, parentId, childId, m);
      return reply.code(200).send({ ok: true, mistake: row });
    });
  });

  app.get("/api/v1/kb/:childId/mistakes", async (req: FastifyRequest, reply: FastifyReply) => {
    const { childId } = req.params as { childId: string };
    const q = (req.query ?? {}) as { status?: string; kind?: string; limit?: string };
    const status = ["open", "mastered", "dismissed"].includes(String(q.status)) ? (q.status as MistakeStatus) : undefined;
    const kind = KINDS.includes(q.kind as MistakeKind) ? (q.kind as MistakeKind) : undefined;
    return withChild(req, childId, async (parentId) => {
      const mistakes = listMistakes(deps.config.dataDir, parentId, childId, {
        status,
        kind,
        limit: Number(q.limit) || 50,
      });
      return reply.code(200).send({ mistakes });
    });
  });

  app.post("/api/v1/kb/:childId/mistakes/action", async (req: FastifyRequest, reply: FastifyReply) => {
    const { childId } = req.params as { childId: string };
    const body = (req.body ?? {}) as { id?: string; action?: string };
    const id = String(body.id ?? "");
    const action = String(body.action ?? "");
    const map: Record<string, MistakeStatus> = { mastered: "mastered", dismiss: "dismissed", reopen: "open" };
    if (!id || !map[action]) throw new ApiError(400, "需要 id + action(mastered/dismiss/reopen)");
    return withChild(req, childId, async (parentId) => {
      const ok = setMistakeStatus(deps.config.dataDir, parentId, childId, id, map[action]);
      if (!ok) throw new ApiError(404, "条目不存在");
      return reply.code(200).send({ ok: true });
    });
  });
}

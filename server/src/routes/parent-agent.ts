/**
 * 家长 agent 路由（P2）：服务端跑家长 agent，客户端只做输入/显示。
 *
 * - GET  /api/v1/parent-agent/stream?kind=parent|parent-content   SSE（token 可走 ?token=）
 * - POST /api/v1/parent-agent/prompt                            提交一轮（kind 缺省 parent）
 * - POST /api/v1/parent-agent/open                              打开会话并返回全部历史（ISSUE-107）
 * - POST /api/v1/parent-agent/abort                             中止当前一轮（ISSUE-095）
 *
 * 与孩子路由（routes/agent.ts）的差异：作用域是家长而非孩子，故 childId 不出现在路径里；
 * 会话 key = `<parentId>:<kind>`，与孩子会话同在 stream-hub（按 key 天然隔离，不会串流）。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { AgentStreamHub, agentStreamHub } from "../agent/stream-hub.js";
import { submitParentPrompt, resetParentSession, abortParentSession, openParentSession, type ParentSessionKind } from "../agent/parent-registry.js";

interface ParentAgentDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(
  req: { headers: Record<string, string | string[] | undefined>; query?: unknown },
  secret: string
): string {
  const header = req.headers.authorization;
  let token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) {
    const q = (req.query ?? {}) as { token?: string };
    token = String(q.token ?? "").trim();
  }
  if (!token) throw new ApiError(401, "缺少 session token");
  try {
    return verifySession(token, secret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
}

function parseKind(v: unknown): ParentSessionKind {
  const s = String(v ?? "").trim();
  if (s === "parent-content") return "parent-content";
  if (s === "parent" || s === "") return "parent";
  // ISSUE-144 P6：`parent-data`（数据管理助手）已整组退场——旧客户端带这个 kind 一律按 400 拒绝
  throw new ApiError(400, "kind 只能是 parent 或 parent-content");
}

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerParentAgentRoutes(app: FastifyInstance, deps: ParentAgentDeps): void {
  app.get("/api/v1/parent-agent/stream", async (req, reply) => {
    let parentId: string;
    let kind: ParentSessionKind;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
      kind = parseKind((req.query as any)?.kind);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const caps = String((req.query as any)?.caps ?? "");
    const key = AgentStreamHub.key(parentId, kind);

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (id: number | string, type: string, data: unknown) => {
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send(agentStreamHub.lastEventId(key), "hello", { parentId, kind, caps, ts: Date.now() });

    const lastIdRaw = req.headers["last-event-id"] ?? (req.query as any)?.lastEventId;
    const lastId = Number(lastIdRaw ?? 0) || 0;
    if (lastId > 0) {
      for (const e of agentStreamHub.replayAfter(key, lastId)) send(e.id, e.type, e.data);
    }

    const unsubscribe = agentStreamHub.subscribe(key, (e) => send(e.id, e.type, e.data));
    const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15000);
    req.raw.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
    return reply;
  });

  app.post("/api/v1/parent-agent/prompt", async (req, reply) => {
    let parentId: string;
    let kind: ParentSessionKind;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
      kind = parseKind((req.body as any)?.kind);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const text = String((req.body as any)?.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "text 必填" });
    const r = await submitParentPrompt({ db: deps.db, dataDir: deps.config.dataDir }, parentId, kind, text);
    if (!r.ok) {
      return reply.code(r.error?.startsWith("busy") ? 409 : 500).send({ error: r.error });
    }
    return { ok: true };
  });

  // ISSUE-108：最近一次家长报表（parent_display_report 落 settings；重启不丢）
  app.get("/api/v1/parent-agent/report", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const row = deps.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`report:${parentId}`) as
      | { value_json?: string }
      | undefined;
    if (!row?.value_json) return { report: null };
    try {
      return { report: JSON.parse(row.value_json) };
    } catch {
      return { report: null };
    }
  });

  // —— 打开会话（ISSUE-107）：进聊天回填历史。家长会话不做跨天裁决（key 不含日期、长期持续
  // 累积），返回现会话全部历史——与孩子端 /agent/:childId/open 的「跨天自动新建」口径不同。
  app.post("/api/v1/parent-agent/open", async (req, reply) => {
    let parentId: string;
    let kind: ParentSessionKind;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
      kind = parseKind((req.body as any)?.kind);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const messages = await openParentSession({ db: deps.db, dataDir: deps.config.dataDir }, parentId, kind);
    return { messages };
  });

  app.post("/api/v1/parent-agent/reset", async (req, reply) => {
    let parentId: string;
    let kind: ParentSessionKind;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
      kind = parseKind((req.body as any)?.kind);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    resetParentSession(parentId, kind);
    return { ok: true };
  });

  // —— 中止当前一轮（ISSUE-095）：家长端「停止」按钮经主进程 pi:abort 打到这里 ——
  app.post("/api/v1/parent-agent/abort", async (req, reply) => {
    let parentId: string;
    let kind: ParentSessionKind;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
      kind = parseKind((req.body as any)?.kind);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const aborted = await abortParentSession(parentId, kind);
    return { ok: true, aborted };
  });
}

/**
 * agent 交互路由（P1 分水岭）：服务端跑孩子 agent，客户端只做输入/显示。
 *
 * - GET  /api/v1/agent/:childId/stream    SSE 事件流（token/thinking/工具/结束/错误），支持 Last-Event-ID 重放
 * - POST /api/v1/agent/:childId/prompt    提交一轮输入（等待本轮结束，增量走 stream）
 * - POST /api/v1/agent/:childId/events    页面事件上行（PiBridge 信封原样透传，累积到下一轮消息前）
 * - POST /api/v1/agent/:childId/page-result  资料页受控操作回执（requestId 配对）
 *
 * 鉴权：家长 JWT。SSE 走 EventSource 时无法自定义请求头，故额外接受 `?token=` 查询参数；
 * childId 必须归属该家长（children.parent_id），否则 403——隔离红线。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { agentStreamHub, AgentStreamHub } from "../agent/stream-hub.js";
import { submitChildPrompt, hasSession, disposeSession, type AgentSessionDeps } from "../agent/session-registry.js";
import { hubFor, hubForChild } from "../agent/page-hub.js";
import { registerCaps, parseCaps, getCaps } from "../agent/caps.js";

interface AgentRoutesDeps {
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
    // SSE（EventSource）不能带自定义头：允许 ?token= 兜底
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

function assertChildOwned(db: DatabaseSync, parentId: string, childId: string): void {
  const row = db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
  if (!row) throw new ApiError(403, "无权访问该孩子的数据");
}

function handleAuthError(err: unknown, reply: any): boolean {
  if (err instanceof ApiError) {
    reply.code(err.status).send({ error: err.message });
    return true;
  }
  return false;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentRoutesDeps): void {
  const agentDeps: AgentSessionDeps = { db: deps.db, dataDir: deps.config.dataDir };

  // —— SSE 事件流 ——
  app.get("/api/v1/agent/:childId/stream", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    // caps：设备能力（material-panel / mic / electron）——登记后由会话装配决定注册哪些设备相关工具
    const { caps } = req.query as { caps?: string };
    const key = AgentStreamHub.key(parentId, childId);
    const prevCaps = getCaps(key).raw;
    const nextCaps = parseCaps(caps);
    registerCaps(key, nextCaps);
    // 能力变化 → 重建会话（工具表在创建时定稿，不重建会出现「同一会话有时能操作页面有时不能」）
    if (prevCaps !== nextCaps.raw && hasSession(parentId, childId)) {
      disposeSession(parentId, childId);
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (id: number | string, type: string, data: unknown) => {
      reply.raw.write(`id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send(agentStreamHub.lastEventId(key), "hello", { childId, caps: caps ?? "", ts: Date.now() });

    // Last-Event-ID 重放：弱网/切后台重连不丢事件
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

  // —— 提交一轮输入 ——
  app.post("/api/v1/agent/:childId/prompt", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { text?: string; pageEvents?: string };
    const text = String(body.text ?? "").trim();
    if (!text) return reply.code(400).send({ error: "text 必填" });
    // 页面事件：优先用调用方显式传入，否则取桥内累积的待附带事件（ISSUE-015 语义）
    const streamKey = AgentStreamHub.key(parentId, childId);
    const hub = hubFor(streamKey, childId);
    const pending =
      typeof body.pageEvents === "string" && body.pageEvents.trim()
        ? body.pageEvents.trim()
        : hub.takePending(childId);
    const result = await submitChildPrompt(agentDeps, parentId, childId, text, {
      pendingPageEvents: pending,
    });
    if (!result.ok) {
      return reply.code(result.error?.startsWith("busy") ? 409 : 500).send({ error: result.error });
    }
    return { ok: true };
  });

  // —— 页面事件上行（PiBridge 信封） ——
  app.post("/api/v1/agent/:childId/events", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { events?: Array<{ kind?: string; title?: string; detail?: Record<string, unknown> }> };
    const events = Array.isArray(body.events) ? body.events : [];
    if (!events.length) return reply.code(400).send({ error: "events 必填（非空数组）" });
    const hub = hubFor(AgentStreamHub.key(parentId, childId), childId);
    for (const e of events) {
      hub.queueEvent(childId, {
        kind: String(e?.kind ?? ""),
        title: e?.title,
        detail: e?.detail,
      });
    }
    return { ok: true, queued: events.length };
  });

  // —— 资料页受控操作回执 ——
  app.post("/api/v1/agent/:childId/page-result", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const { childId } = req.params as { childId: string };
    try {
      assertChildOwned(deps.db, parentId, childId);
    } catch (err) {
      if (handleAuthError(err, reply)) return;
      throw err;
    }
    const body = (req.body ?? {}) as { requestId?: string; ok?: boolean; error?: string; data?: unknown };
    if (!body.requestId) return reply.code(400).send({ error: "requestId 必填" });
    const hub = hubForChild(childId);
    if (!hub) return reply.code(409).send({ error: "该孩子当前没有活跃会话，回执无处可兑" });
    hub.resolveAction(body.requestId, {
      ok: body.ok === true,
      error: body.error,
      data: body.data,
    });
    return { ok: true };
  });
}

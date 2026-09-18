/**
 * 微信桥（2026-09-17）：把微信消息转给 server 内的家长/孩子 agent 会话，同步等一轮回复。
 *
 * 形态：201 上的 OpenClaw gateway 装微信渠道插件（@tencent-weixin/openclaw-weixin）收发微信，
 * 配套 learning-bridge 插件用 before_agent_reply 钩子把消息 POST 到本路由；本路由
 * 复用现有会话注册表（submitParentPrompt / submitChildPrompt）+ agentStreamHub 聚合最终文本。
 * OpenClaw 自己的 LLM 不参与——学习服务端的 agent 是唯一大脑。
 *
 * 鉴权：connector 令牌（env WECHAT_CONNECTOR_TOKEN）或仅限本机回环地址（OpenClaw 与 server 同机）。
 * 超时：默认 240s；超时返回已聚合的部分回复。
 */
import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { agentStreamHub } from "../agent/stream-hub.js";
import { submitParentPrompt } from "../agent/parent-registry.js";
import { submitChildPrompt } from "../agent/session-registry.js";
import { verifySession } from "../auth/jwt.js";
import type { ServerConfig } from "../config.js";

interface Deps {
  config: ServerConfig;
  db: DatabaseSync;
}

function authParent(req: { headers: Record<string, string | string[] | undefined> }, secret: string): string {
  const header = req.headers.authorization;
  const token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token) throw new Error("缺少 session token");
  return verifySession(token, secret).parent_id;
}

const TURN_TIMEOUT_MS = 240_000;

/** 当前请求是否通过桥接鉴权：令牌匹配，或来自本机回环。 */
function authConnector(req: { ip?: string; headers: Record<string, string | string[] | undefined> }): boolean {
  const token = process.env.WECHAT_CONNECTOR_TOKEN || "";
  const given = String(req.headers["x-wechat-token"] ?? "");
  if (token && given === token) return true;
  const ip = String(req.ip ?? "");
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 一轮的过程快照（供渠道做"思考中/工具调用/作答中"的实时展示） */
export interface TurnProgress {
  thinking: string;
  tools: Array<{ name: string; done: boolean; error?: boolean }>;
  text: string;
}

/** 提交一轮并聚合最终文本：先订阅再提交，text_delta 累积，turn_end/error 收口。
 *  onProgress 给定时，每个 thinking/text/tool 事件都会带最新快照回调一次（节流由调用方负责）。
 *  onTimeout 给定时，超时先回调它（渠道用 session.abort() 解除会话卡死），再收口返回部分回复。 */
export async function runTurn(
  submit: () => Promise<{ ok: boolean; error?: string }>,
  hubKey: string,
  timeoutMs = TURN_TIMEOUT_MS,
  onProgress?: (p: TurnProgress) => void,
  onTimeout?: () => void | Promise<void>
): Promise<{ ok: boolean; reply: string; error?: string }> {
  let text = "";
  let thinking = "";
  const tools = new Map<string, { name: string; done: boolean; error?: boolean }>();
  let finished: (() => void) | null = null;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  let errorMessage: string | null = null;
  const snapshot = (): TurnProgress => ({
    thinking,
    tools: [...tools.values()].map((t) => ({ ...t })),
    text,
  });
  const unsubscribe = agentStreamHub.subscribe(hubKey, (e) => {
    if (e.type === "text_delta") {
      text += String((e.data as any)?.delta ?? "");
      onProgress?.(snapshot());
    } else if (e.type === "thinking_delta") {
      thinking += String((e.data as any)?.delta ?? "");
      onProgress?.(snapshot());
    } else if (e.type === "tool_start") {
      const callId = String((e.data as any)?.toolCallId ?? "");
      tools.set(callId, { name: String((e.data as any)?.toolName ?? "工具"), done: false });
      onProgress?.(snapshot());
    } else if (e.type === "tool_end") {
      const callId = String((e.data as any)?.toolCallId ?? "");
      const t = tools.get(callId);
      if (t) {
        t.done = true;
        t.error = (e.data as any)?.isError === true;
      }
      onProgress?.(snapshot());
    } else if (e.type === "error") {
      errorMessage = errorMessage ?? String((e.data as any)?.message ?? "agent 出错");
      finished?.();
    } else if (e.type === "turn_end") {
      finished?.();
    }
  });
  const timer = setTimeout(() => {
    errorMessage = errorMessage ?? `等待超时（${Math.round(timeoutMs / 1000)}s）`;
    void (async () => {
      try {
        await onTimeout?.();
      } catch (err) {
        console.error("[wechat] 超时中止会话失败:", (err as Error)?.message || err);
      }
      finished?.();
    })();
  }, timeoutMs);
  try {
    const sub = await submit();
    if (!sub.ok) {
      return { ok: false, reply: "", error: sub.error ?? "提交失败" };
    }
    await done;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
  if (errorMessage && !text) return { ok: false, reply: "", error: errorMessage };
  const reply = text.trim() || "（这轮没有文本回复）";
  return { ok: true, reply: errorMessage ? `${reply}\n\n（${errorMessage}）` : reply };
}

export function registerWechatRoutes(app: FastifyInstance, deps: Deps): void {
  // —— 绑定管理（家长 JWT；绑定 = 微信号 → 家长本人 / 某个孩子）——
  app.post("/api/v1/wechat/bindings", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    const body = (req.body ?? {}) as {
      action: "add" | "remove" | "list";
      wechatId?: string;
      role?: "parent" | "child";
      childId?: string;
      label?: string;
    };
    const db = deps.db;

    if (body.action === "list" || !body.action) {
      const rows = db
        .prepare("SELECT wechat_id, channel, role, child_id, label, created_at FROM wechat_bindings WHERE parent_id = ?")
        .all(parentId);
      return { bindings: rows };
    }

    const wechatId = String(body.wechatId ?? "").trim();
    if (!wechatId) return reply.code(400).send({ error: "wechatId 必填" });

    if (body.action === "remove") {
      db.prepare("DELETE FROM wechat_bindings WHERE wechat_id = ? AND parent_id = ?").run(wechatId, parentId);
      return { ok: true };
    }

    // add
    const role = body.role === "child" ? "child" : "parent";
    let childId = "";
    if (role === "child") {
      childId = String(body.childId ?? "").trim();
      if (!childId) return reply.code(400).send({ error: "绑定孩子需要 childId" });
      const kid = db.prepare("SELECT id FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
      if (!kid) return reply.code(400).send({ error: "孩子不存在或不属于当前家长" });
    }
    const now = nowStr();
    db.prepare(
      `INSERT INTO wechat_bindings (id, wechat_id, role, parent_id, child_id, label, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(wechat_id) DO UPDATE SET role=excluded.role, parent_id=excluded.parent_id,
         child_id=excluded.child_id, label=excluded.label, updated_at=excluded.updated_at`
    ).run(randomUUID(), wechatId, role, parentId, childId, String(body.label ?? ""), now, now);
    return { ok: true };
  });

  // —— 待确认绑定请求（家长 JWT；前端轮询展示，确认即落 wechat_bindings）——
  app.get("/api/v1/wechat/bind-requests", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    void parentId;
    const rows = deps.db
      .prepare(
        "SELECT id, wechat_id, channel, sample_text, first_seen, last_seen FROM wechat_bind_requests WHERE status = 'pending' ORDER BY last_seen DESC LIMIT 50"
      )
      .all();
    return { requests: rows };
  });

  app.post("/api/v1/wechat/bind-requests/decide", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    const body = (req.body ?? {}) as {
      id?: string;
      action?: "confirm" | "reject";
      role?: "parent" | "child";
      childId?: string;
      label?: string;
    };
    const id = String(body.id ?? "").trim();
    const action = body.action;
    if (!id || !action) return reply.code(400).send({ error: "id 与 action 必填" });
    const row = deps.db
      .prepare("SELECT wechat_id, channel, status FROM wechat_bind_requests WHERE id = ?")
      .get(id) as { wechat_id: string; channel: string; status: string } | undefined;
    if (!row) return reply.code(404).send({ error: "请求不存在" });
    if (row.status !== "pending") return reply.code(409).send({ error: `该请求已处理（${row.status}）` });

    if (action === "reject") {
      deps.db
        .prepare("UPDATE wechat_bind_requests SET status = 'rejected', decided_at = ? WHERE id = ?")
        .run(nowStr(), id);
      return { ok: true };
    }

    // confirm：落绑定（复用与手动添加相同的校验）
    const role = body.role === "child" ? "child" : "parent";
    let childId = "";
    if (role === "child") {
      childId = String(body.childId ?? "").trim();
      if (!childId) return reply.code(400).send({ error: "绑定孩子需要 childId" });
      const kid = deps.db.prepare("SELECT id FROM children WHERE id = ? AND parent_id = ?").get(childId, parentId);
      if (!kid) return reply.code(400).send({ error: "孩子不存在或不属于当前家长" });
    }
    const now = nowStr();
    deps.db
      .prepare(
        `INSERT INTO wechat_bindings (id, wechat_id, channel, role, parent_id, child_id, label, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(wechat_id) DO UPDATE SET channel=excluded.channel, role=excluded.role, parent_id=excluded.parent_id,
           child_id=excluded.child_id, label=excluded.label, updated_at=excluded.updated_at`
      )
      .run(randomUUID(), row.wechat_id, row.channel || "wechat", role, parentId, childId, String(body.label ?? ""), now, now);
    deps.db
      .prepare("UPDATE wechat_bind_requests SET status = 'confirmed', decided_at = ? WHERE id = ?")
      .run(now, id);
    return { ok: true, wechatId: row.wechat_id };
  });

  // —— 飞书渠道配置（家长 JWT；保存即生效，配置存 settings 表）——
  app.get("/api/v1/wechat/feishu-config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    void parentId;
    const { readFeishuConfig, feishuStatus } = await import("../channels/feishu.js");
    const cfg = readFeishuConfig(deps.db);
    const st = feishuStatus();
    return {
      enabled: cfg?.enabled ?? false,
      appId: cfg?.appId ?? "",
      hasSecret: Boolean(cfg?.appSecret),
      running: st.running,
      status: st.status,
      envFallback: Boolean(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET),
    };
  });

  app.put("/api/v1/wechat/feishu-config", async (req, reply) => {
    let parentId: string;
    try {
      parentId = authParent(req, deps.config.jwtSecret);
    } catch {
      return reply.code(401).send({ error: "未登录" });
    }
    void parentId;
    const body = (req.body ?? {}) as { appId?: string; appSecret?: string; enabled?: boolean };
    const { readFeishuConfig, saveFeishuConfig, applyFeishuChannel } = await import("../channels/feishu.js");
    const cur = readFeishuConfig(deps.db);
    const appId = String(body.appId ?? cur?.appId ?? "").trim();
    const appSecret = String(body.appSecret ?? cur?.appSecret ?? "").trim();
    if (!appId || !appSecret) return reply.code(400).send({ error: "appId 与 appSecret 必填（appSecret 留空表示保持原值）" });
    saveFeishuConfig(deps.db, { appId, appSecret, enabled: body.enabled !== false });
    const r = applyFeishuChannel({ db: deps.db, dataDir: deps.config.dataDir });
    return { ok: true, ...r };
  });

  // —— 微信消息入口（OpenClaw learning-bridge 插件调用）——
  app.post("/api/v1/wechat/turn", async (req, reply) => {
    if (!authConnector(req as any)) return reply.code(401).send({ error: "connector 未授权" });
    const body = (req.body ?? {}) as { senderId?: string; text?: string };
    const senderId = String(body.senderId ?? "").trim();
    const text = String(body.text ?? "").trim();
    if (!senderId || !text) return reply.code(400).send({ error: "senderId 与 text 必填" });

    const b = deps.db
      .prepare("SELECT role, parent_id, child_id FROM wechat_bindings WHERE wechat_id = ?")
      .get(senderId) as { role: "parent" | "child"; parent_id: string; child_id: string } | undefined;
    if (!b) {
      // 落一条待确认请求（幂等按 wechat_id；已拒绝的不再变回 pending，只刷新最近活跃）
      const now = nowStr();
      deps.db
        .prepare(
          `INSERT INTO wechat_bind_requests (id, wechat_id, channel, sample_text, first_seen, last_seen, status)
           VALUES (?,?, 'wechat', ?,?,?,'pending')
           ON CONFLICT(channel, wechat_id) DO UPDATE SET
             sample_text=excluded.sample_text, last_seen=excluded.last_seen,
             status=CASE WHEN wechat_bind_requests.status='pending' THEN 'pending' ELSE wechat_bind_requests.status END`
        )
        .run(randomUUID(), senderId, text.slice(0, 120), now, now);
      const rejected = deps.db
        .prepare("SELECT 1 FROM wechat_bind_requests WHERE wechat_id = ? AND status = 'rejected'")
        .get(senderId);
      return reply.code(200).send({
        ok: false,
        code: "unbound",
        reply: rejected
          ? "这个微信号还没有绑定学习伙伴。"
          : "这个微信号还没有绑定。家长会在 App「设置 → 微信绑定」里看到确认请求，确认后请再发一次。",
      });
    }

    const sessionDeps = { db: deps.db, dataDir: deps.config.dataDir };
    // 微信不渲染 markdown：注入渠道提示，让回复保持纯文本精炼（表格/标题/加粗在微信里是原始符号）
    const channelText =
      `（这条消息来自微信。回复要求：纯文本短句、口语化、控制在一两百字内；` +
      `不要用 markdown 表格、标题、加粗、列表符号，多行用换行即可。）

${text}`;
    if (b.role === "parent") {
      const hubKey = `${b.parent_id}:parent`;
      const r = await runTurn(() => submitParentPrompt(sessionDeps, b.parent_id, "parent", channelText), hubKey);
      return reply.code(r.ok ? 200 : r.error?.startsWith("busy") ? 409 : 500).send({ ...r, code: r.ok ? "ok" : r.error?.startsWith("busy") ? "busy" : "error" });
    }
    const streamKey = `${b.parent_id}:${b.child_id}`;
    const r = await runTurn(
      () => submitChildPrompt(sessionDeps, b.parent_id, b.child_id, channelText),
      streamKey
    );
    return reply.code(r.ok ? 200 : r.error?.startsWith("busy") ? 409 : 500).send({ ...r, code: r.ok ? "ok" : r.error?.startsWith("busy") ? "busy" : "error" });
  });
}

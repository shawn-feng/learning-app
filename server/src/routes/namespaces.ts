/**
 * Tier 2 自定义数据场景管理（F15b 家长确认关的 REST 面）：
 * - GET  /api/v1/namespaces          全量清单（含 pending 草案与 disabled，UI 按 status 分组）
 * - POST /api/v1/namespaces/decide   { ns, action: confirm | reject }   草案确认/拒绝
 * - POST /api/v1/namespaces/status   { ns, action: disable | enable }  已生效场景停用/启用
 * 鉴权：家长 JWT；namespaces 表在各自家长库，parentId 来自 token——物理隔离。
 */
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openParentLib } from "../db/parent-lib.js";
import {
  confirmNamespace,
  loadNamespaces,
  rejectNamespace,
  setNamespaceStatus,
  type NamespaceRow,
} from "../agent/tier2.js";

interface NsDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

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

function rowDto(n: NamespaceRow) {
  return {
    ns: n.ns,
    scope: n.scope,
    label: n.label,
    version: n.version,
    status: n.status ?? "active",
    fields: Object.entries(n.spec.columns).map(([name, c]) => {
      const ref = n.spec.refs?.find((r) => r.column === name);
      return {
        name,
        kind: c.kind,
        desc: c.desc,
        required: c.notEmpty !== false,
        filterable: (n.spec.filterable ?? []).includes(name),
        enumValues: c.enumValues ?? [],
        ref: ref ? `${ref.refTable}.${ref.refColumn}` : null,
      };
    }),
  };
}

export function registerNamespaceRoutes(app: FastifyInstance, deps: NsDeps): void {
  /** 打开当前家长的库（鉴权即开库，库随 token 走） */
  const withPdb = async <T>(req: FastifyRequest, fn: (pdb: ReturnType<typeof openParentLib>) => T): Promise<T> => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const pdb = openParentLib(deps.config.dataDir, parentId);
    try {
      return await fn(pdb);
    } finally {
      pdb.close();
    }
  };

  app.get("/api/v1/namespaces", async (req: FastifyRequest, reply: FastifyReply) => {
    const all = await withPdb(req, (pdb) => {
      const rows = [
        ...loadNamespaces(pdb, "parent", { includePending: true }),
        ...loadNamespaces(pdb, "child", { includePending: true }),
      ];
      // disabled 不在 loadNamespaces（运行面只要 active），清单里单独补
      const disabled = pdb
        .prepare("SELECT ns, scope, label, spec_json, version, status FROM namespaces WHERE status = 'disabled' ORDER BY ns")
        .all() as Array<Record<string, unknown>>;
      for (const r of disabled) {
        try {
          rows.push({
            ns: String(r.ns),
            scope: String(r.scope) as "parent" | "child",
            label: String(r.label ?? ""),
            spec: JSON.parse(String(r.spec_json ?? "{}")),
            version: Number(r.version) || 1,
            status: "disabled",
          });
        } catch {
          /* spec 坏行跳过 */
        }
      }
      return rows;
    });
    return reply.code(200).send({ namespaces: all.map(rowDto) });
  });

  app.post("/api/v1/namespaces/decide", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { ns?: string; action?: string };
    const ns = String(body.ns ?? "").trim();
    const action = String(body.action ?? "");
    if (!ns || !["confirm", "reject"].includes(action)) {
      throw new ApiError(400, "需要 ns + action(confirm/reject)");
    }
    const r = await withPdb(req, (pdb) => (action === "confirm" ? confirmNamespace(pdb, ns) : rejectNamespace(pdb, ns)));
    if (!r.ok) throw new ApiError(400, r.text);
    return reply.code(200).send({ ok: true, text: r.text });
  });

  app.post("/api/v1/namespaces/status", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as { ns?: string; action?: string };
    const ns = String(body.ns ?? "").trim();
    const action = String(body.action ?? "");
    if (!ns || !["disable", "enable"].includes(action)) {
      throw new ApiError(400, "需要 ns + action(disable/enable)");
    }
    const r = await withPdb(req, (pdb) => setNamespaceStatus(pdb, ns, action === "disable" ? "disabled" : "active"));
    if (!r.ok) throw new ApiError(400, r.text);
    return reply.code(200).send({ ok: true, text: r.text });
  });
}

/**
 * 家长材料域操作（P2）：服务端 agent 直接操作课程学习资料真源。
 *
 * 为什么要有这一层（ISSUE-079 的 server 形态）：
 * 资料真源在服务端（`<dataDir>/materials/<parentId>/…` + `materials` 索引表），而旧架构里
 * 家长 agent 跑在客户端、只能通过 HTTP 封装碰服务端，导致「列出/读取/删除/移动」四个必备管理动作缺失，
 * 家长无法让 agent 整理资料。agent 上移服务端后，这些动作就是本地的文件+索引操作，直接实现即可。
 *
 * 安全边界（对应红线「隔离不放松」+ ISSUE-079 待确认项）：
 *  - 根目录固定 `<dataDir>/materials/<parentId>`（调用方按登录家长注入），路径一律经 resolveWithin 校验；
 *  - topic 段（第一级目录）必须匹配 `^[a-zA-Z0-9_-]+$`（与 /materials/upload 一致，避免奇怪目录名）；
 *  - 删除必须先 dryRun（`confirm !== true` 时只返回将删除清单），真删写 activity log；
 *  - 读取按类型分流：文本类返回正文（限 200KB），二进制只返回元数据（避免大文件灌爆上下文）。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveWithin } from "@pi/agent-core";
import {
  materialsRoot,
  scanMaterials,
  upsertMaterialFile,
  encodeMaterialId,
  inferType,
  type MaterialMeta,
} from "../db/materials.js";

export const TOPIC_KEY_RE = /^[a-zA-Z0-9_-]+$/;
export const MAX_TEXT_READ_BYTES = 200 * 1024;
export const MAX_PUT_BYTES = 2 * 1024 * 1024;

export interface MaterialCtx {
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
}

/** 归一化材料相对路径：统一正斜杠、去前导斜杠、禁止空段与 .. 段。 */
export function normalizeMaterialPath(rel: string): string {
  const raw = String(rel ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) throw new Error("路径不能为空");
  const parts = raw.split("/").filter((p) => p.length > 0);
  if (!parts.length) throw new Error("路径不能为空");
  for (const p of parts) {
    if (p === "." || p === "..") throw new Error(`路径不允许包含 . 或 .. 段：${rel}`);
  }
  return parts.join("/");
}

/** 校验 topic（第一段目录）合法；返回 [topic, rest]。 */
export function splitTopic(relPosix: string): { topic: string; rest: string } {
  const norm = normalizeMaterialPath(relPosix);
  const idx = norm.indexOf("/");
  const topic = idx < 0 ? norm : norm.slice(0, idx);
  const rest = idx < 0 ? "" : norm.slice(idx + 1);
  if (!TOPIC_KEY_RE.test(topic)) {
    throw new Error(`topic（第一级目录）仅允许字母/数字/_/-，收到：${topic}`);
  }
  return { topic, rest };
}

/** 材料绝对路径（已做沙箱校验）。 */
export function materialAbsPath(ctx: MaterialCtx, relPosix: string): string {
  const root = materialsRoot(ctx.dataDir, ctx.parentId);
  const norm = normalizeMaterialPath(relPosix);
  splitTopic(norm);
  return resolveWithin(root, norm);
}

/** 列出材料（可按 topic / 路径前缀过滤），并顺带同步索引（与 /materials/list 同语义）。 */
export function listMaterials(
  ctx: MaterialCtx,
  opts: { topic?: string; relPrefix?: string } = {}
): MaterialMeta[] {
  scanMaterials(ctx.db, ctx.dataDir, ctx.parentId);
  const rows = ctx.db
    .prepare("SELECT id, path, type, size, updated_at FROM materials WHERE parent_id = ? ORDER BY path")
    .all(ctx.parentId) as unknown as MaterialMeta[];
  let out = rows;
  if (opts.topic) {
    const t = String(opts.topic).trim();
    if (!TOPIC_KEY_RE.test(t)) throw new Error(`topic 仅允许字母/数字/_/-，收到：${t}`);
    out = out.filter((r) => r.path.split("/")[0] === t);
  }
  if (opts.relPrefix) {
    const p = normalizeMaterialPath(opts.relPrefix);
    out = out.filter((r) => r.path === p || r.path.startsWith(p + "/"));
  }
  return out;
}

/** 材料树文本（按目录分组，供 agent 阅读）。 */
export function formatMaterialTree(items: MaterialMeta[], maxItems = 400): string {
  if (!items.length) return "（没有材料）";
  const lines = items.slice(0, maxItems).map((m) => `${m.path}  [${m.type}, ${m.size}B]`);
  if (items.length > maxItems) lines.push(`…（共 ${items.length} 条，已截断显示前 ${maxItems} 条）`);
  return lines.join("\n");
}

export interface MaterialContent {
  path: string;
  type: string;
  size: number;
  /** 文本类材料才有正文 */
  text?: string;
  truncated?: boolean;
}

const TEXT_TYPES = new Set(["html", "css", "js", "json", "text"]);

/** 读材料：文本类返回正文（超 200KB 截断），二进制返回元数据。 */
export function readMaterial(ctx: MaterialCtx, relPosix: string): MaterialContent {
  const abs = materialAbsPath(ctx, relPosix);
  if (!fs.existsSync(abs)) throw new Error(`材料不存在：${relPosix}`);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) throw new Error(`${relPosix} 是目录，请用 list 查看其下文件`);
  const type = inferType(relPosix);
  if (!TEXT_TYPES.has(type)) {
    return { path: relPosix, type, size: stat.size };
  }
  const buf = fs.readFileSync(abs);
  const truncated = buf.length > MAX_TEXT_READ_BYTES;
  return {
    path: relPosix,
    type,
    size: stat.size,
    text: buf.subarray(0, MAX_TEXT_READ_BYTES).toString("utf-8"),
    truncated,
  };
}

/** 写入/覆盖文本材料（agent 产出资料后发布到真源）。 */
export function putMaterial(ctx: MaterialCtx, relPosix: string, content: string): MaterialMeta {
  const size = Buffer.byteLength(content ?? "", "utf-8");
  if (size > MAX_PUT_BYTES) throw new Error(`内容过大（${size} 字节 > 2MB），请拆分写入`);
  const abs = materialAbsPath(ctx, relPosix);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content ?? "", "utf-8");
  return upsertMaterialFile(ctx.db, ctx.dataDir, ctx.parentId, normalizeMaterialPath(relPosix));
}

/** 删除材料（含索引行清理）。调用方须先确认（dryRun 由工具层负责）。 */
export function deleteMaterial(ctx: MaterialCtx, relPosix: string): { deleted: string; removedIndex: boolean } {
  const abs = materialAbsPath(ctx, relPosix);
  const norm = normalizeMaterialPath(relPosix);
  const existed = fs.existsSync(abs);
  const row = ctx.db
    .prepare("SELECT id FROM materials WHERE parent_id = ? AND path = ?")
    .get(ctx.parentId, norm) as { id: string } | undefined;
  if (row) ctx.db.prepare("DELETE FROM materials WHERE parent_id = ? AND id = ?").run(ctx.parentId, row.id);
  let removedFile = false;
  if (existed) {
    fs.rmSync(abs, { force: true });
    removedFile = true;
  }
  if (!existed && !row) throw new Error(`材料不存在：${relPosix}`);
  return { deleted: norm, removedIndex: !!row || removedFile };
}

/**
 * 移动/改名（真源内）。顺序刻意是「先写新、后删旧」：
 * 万一中途失败，最坏留下重复副本（可再用 delete 清理），而不会丢数据——反过来则会丢。
 */
export function moveMaterial(
  ctx: MaterialCtx,
  fromRel: string,
  toRel: string
): { from: string; to: string } {
  const fromNorm = normalizeMaterialPath(fromRel);
  const toNorm = normalizeMaterialPath(toRel);
  if (fromNorm === toNorm) throw new Error("源路径与目标路径相同");
  const fromAbs = materialAbsPath(ctx, fromNorm);
  const toAbs = materialAbsPath(ctx, toNorm);
  if (!fs.existsSync(fromAbs)) throw new Error(`材料不存在：${fromNorm}`);
  if (fs.existsSync(toAbs)) throw new Error(`目标已存在（拒绝覆盖）：${toNorm}`);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.copyFileSync(fromAbs, toAbs);
  upsertMaterialFile(ctx.db, ctx.dataDir, ctx.parentId, toNorm);
  try {
    deleteMaterial(ctx, fromNorm);
  } catch (err) {
    throw new Error(`新路径已写入（${toNorm}），但删除旧路径失败：${(err as Error).message}（可手动 delete 清理）`);
  }
  return { from: fromNorm, to: toNorm };
}

/** 材料 id（供客户端 media 协议使用；agent 一般用不到，列出时附带）。 */
export function materialId(relPosix: string): string {
  return encodeMaterialId(normalizeMaterialPath(relPosix));
}

/** 追加家长操作记录（activity-log.md，供家长回看 agent 改了什么）。 */
export function appendParentActivityLog(ctx: MaterialCtx, entry: string): string {
  const dir = path.join(ctx.dataDir, "parents", ctx.parentId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "activity-log.md");
  const line = `- ${new Date().toISOString()} ${entry}\n`;
  fs.appendFileSync(file, line, "utf-8");
  return file;
}

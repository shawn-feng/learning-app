/**
 * 聊天附件引用解析（ISSUE-124）。
 *
 * 背景：家长在聊天框上传图片/文件后，agent 只拿到一条**文本标记**（附件不进 prompt 正文）：
 *   【附件图片：微信图片_xxx.jpg|parents/<pid>/uploads/1789…-微信图片_xxx.jpg】
 *   【附件文件：作业.txt|<fileId>】
 * 旧实现（parent_read_image）把标记里的引用直接当**材料库相对路径**去查，材料库根是
 * `<dataDir>/materials/<pid>`，而上传区根本不在材料库里 → 永远「材料不存在」。
 *
 * 本模块把引用解析成**服务端磁盘上真实存在**的绝对路径，三类来源：
 *  1. `files` 表（服务端大文件通道 POST /files/upload，磁盘布局 `<dataDir>/files/<parentId>/<stored_path>`）
 *     —— 引用写成裸 uuid 或 `files/<id>`（Web 端与新版桌面端走这条）；
 *  2. `files/<parentId>/<stored_path>`（大文件通道的磁盘布局直写）；
 *  3. `uploads/<name>` / `parents/<parentId>/uploads/<name>`（客户端**本机**落盘路径）
 *     —— 只有「服务端 dataDir 就是那份数据」的同机/本地部署才读得到；远端客户端上传的附件
 *     并不在服务端，此时抛 `missing-remote`，由调用方给出可执行的替代建议。
 *
 * 安全红线：引用里带 `parents/<pid>/…` / `files/<pid>/…` 时，pid 必须等于当前登录家长，
 * 否则拒绝（家长之间不互通）。所有路径一律经 `resolveWithin` 沙箱校验，越界直接抛错。
 */
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveWithin } from "@pi/agent-core";

export interface UploadRefCtx {
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
}

export type UploadRefErrorKind = "not-a-ref" | "invalid" | "forbidden" | "missing-remote";

export class UploadRefError extends Error {
  constructor(
    message: string,
    public readonly kind: UploadRefErrorKind
  ) {
    super(message);
    this.name = "UploadRefError";
  }
}

export interface ResolvedUploadRef {
  /** 服务端可读的绝对路径 */
  abs: string;
  /** 原样回显用的引用 */
  ref: string;
  /** 展示用文件名（取引用末段） */
  fileName: string;
  /** 来源：服务端大文件通道 / 客户端本机上传区 */
  source: "files" | "uploads";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 归一化引用：去空白与包裹引号、反斜杠转正斜杠、去前导 `/` 与 `./`。 */
export function normalizeRef(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+/, "");
}

/**
 * 是否是「聊天附件引用」形态（不是材料相对路径）。
 * 判据：裸 uuid / `files/…` / `uploads/…` / `parents/…`。材料路径形如 `lunyu/materials/x.html`，不匹配。
 */
export function looksLikeAttachmentRef(raw: string): boolean {
  const n = normalizeRef(raw);
  if (!n) return false;
  if (UUID_RE.test(n)) return true;
  return /^(files|uploads|parents)\//.test(n);
}

function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,10})$/i.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function basenameOf(ref: string): string {
  const parts = ref.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : ref;
}

/** 从 files 表按 id 解析（归属校验：只认自己的文件）。
 *  P2 物理归并后的解析顺序：新根（workspaces/<pid>/{uploads|<cid>/uploads}）优先，
 *  旧根 files/<pid>/<stored> 永久兜底（存量不迁移）。 */
function resolveByFileId(ctx: UploadRefCtx, id: string, ref: string): ResolvedUploadRef {
  let row: { stored_path?: string; original_name?: string; child_id?: string | null } | undefined;
  try {
    row = ctx.db
      .prepare("SELECT stored_path, original_name, child_id FROM files WHERE id = ? AND parent_id = ?")
      .get(id, ctx.parentId) as { stored_path?: string; original_name?: string; child_id?: string | null } | undefined;
  } catch {
    row = undefined;
  }
  if (!row?.stored_path) {
    throw new UploadRefError(
      `附件引用「${ref}」在服务端文件记录里找不到（可能已被清理，或不属于当前家长）。`,
      "missing-remote"
    );
  }
  const stored = String(row.stored_path);
  const candidates: string[] = [];
  if (row.child_id) {
    candidates.push(path.join(ctx.dataDir, "workspaces", ctx.parentId, row.child_id, "uploads", stored));
  }
  candidates.push(path.join(ctx.dataDir, "workspaces", ctx.parentId, "uploads", stored));
  candidates.push(resolveWithin(path.join(ctx.dataDir, "files"), path.join(ctx.parentId, stored)));
  const abs = candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
  if (!fs.existsSync(abs)) {
    throw new UploadRefError(`附件「${ref}」有记录但文件已不在服务端磁盘上（可能已被清理）。`, "missing-remote");
  }
  return { abs, ref, fileName: String(row.original_name || basenameOf(String(row.stored_path))), source: "files" };
}

/**
 * 解析一条聊天附件引用。
 * - 不是附件引用形态 → `not-a-ref`（调用方应回退到材料库路径解析）；
 * - 引用合法但服务端没有该文件（远端客户端本机上传的老路径）→ `missing-remote`；
 * - 引用了别的家长的目录 → `forbidden`。
 */
export function resolveAttachmentRef(ctx: UploadRefCtx, raw: string): ResolvedUploadRef {
  const ref = normalizeRef(raw);
  if (!looksLikeAttachmentRef(ref)) {
    throw new UploadRefError(`「${raw}」不是聊天附件引用`, "not-a-ref");
  }

  // 1) 裸 uuid → files 表
  if (UUID_RE.test(ref)) return resolveByFileId(ctx, ref, ref);

  // 2) files/<…>
  if (ref.startsWith("files/")) {
    const rest = ref.slice("files/".length);
    const segs = rest.split("/").filter(Boolean);
    if (!segs.length) throw new UploadRefError(`附件引用「${ref}」缺少文件名`, "invalid");
    // `files/<fileId>`（裸 id 带前缀）→ 走 files 表（与裸 uuid 等价）
    if (segs.length === 1 && UUID_RE.test(segs[0])) return resolveByFileId(ctx, segs[0], ref);
    const filesRoot = path.join(ctx.dataDir, "files");
    // a) 默认按「当前家长」解析：`files/<自己pid>/<x>`（带 pid 的直写布局）与 `files/<x>`（不带 pid）
    const rel = segs[0] === ctx.parentId ? segs : [ctx.parentId, ...segs];
    const own = resolveWithin(filesRoot, rel.join("/"));
    if (fs.existsSync(own)) {
      return { abs: own, ref, fileName: segs[segs.length - 1], source: "files" };
    }
    // a2) P2 新根兜底：workspaces/<pid>/uploads/<x>（名称直写布局；segs 自身可能带自己 pid 前缀，两种都试）
    const uploadsRoot = path.join(ctx.dataDir, "workspaces", ctx.parentId, "uploads");
    for (const relCand of [rel.slice(1).join("/"), segs.join("/")]) {
      try {
        const inNew = resolveWithin(uploadsRoot, relCand);
        if (fs.existsSync(inNew)) {
          return { abs: inNew, ref, fileName: segs[segs.length - 1], source: "files" };
        }
      } catch {
        /* 越界候选跳过 */
      }
    }
    // b) 自己目录下没有：若在 files 根下确实存在，说明指向的是**别人**的目录/文件 → 拒绝
    let foreign = "";
    try {
      const bare = resolveWithin(filesRoot, segs.join("/"));
      if (fs.existsSync(bare)) foreign = bare;
    } catch {
      /* 越界 → 当作不存在 */
    }
    if (foreign) throw new UploadRefError(`拒绝读取其它家长的附件（引用 ${ref}）`, "forbidden");
    throw new UploadRefError(`附件「${ref}」在服务端不存在（可能已被清理）。`, "missing-remote");
  }

  // 3) parents/<pid>/uploads/… 或 uploads/…
  let rel: string[];
  if (ref.startsWith("parents/")) {
    const segs = ref.split("/").filter(Boolean);
    const pid = segs[1] ?? "";
    if (pid !== ctx.parentId) {
      throw new UploadRefError(`拒绝读取其它家长的上传区（引用 ${ref}）`, "forbidden");
    }
    rel = segs; // 保持 `parents/<pid>/uploads/…`，本身就是相对 dataDir 的路径
  } else {
    rel = ["parents", ctx.parentId, ...ref.split("/").filter(Boolean)];
  }
  const abs = resolveWithin(ctx.dataDir, rel.join("/"));
  if (fs.existsSync(abs)) {
    return { abs, ref, fileName: rel[rel.length - 1], source: "uploads" };
  }
  // P2 新根兜底：`uploads/<name>` / `parents/<pid>/uploads/<name>` → workspaces/<pid>/uploads/<…>
  const tail = ref.startsWith("uploads/") ? ref.split("/").filter(Boolean).slice(1) : rel.slice(3);
  if (tail.length) {
    const newRoot = path.join(ctx.dataDir, "workspaces", ctx.parentId, "uploads");
    const inNew = resolveWithin(newRoot, tail.join("/"));
    if (fs.existsSync(inNew)) {
      return { abs: inNew, ref, fileName: tail[tail.length - 1], source: "uploads" };
    }
  }
  throw new UploadRefError(`附件「${ref}」不在服务端磁盘上`, "missing-remote");
}

/** 文本类附件扩展名（可返回正文）。图片另有视觉模型通道。 */
const TEXT_EXTS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "yaml",
  "yml",
  "html",
  "htm",
  "css",
  "js",
  "ts",
  "log",
  "srt",
  "vtt",
]);

export function isTextAttachment(name: string): boolean {
  return TEXT_EXTS.has(extOf(name));
}

export function isImageAttachment(name: string): boolean {
  return ["png", "jpg", "jpeg", "webp", "gif", "bmp"].includes(extOf(name));
}

/**
 * 附件读不到时的**可执行提示**（给 agent 原样转述，别让它再去试别的路径——ISSUE-124 现场就是这么绕圈失败的）。
 */
export function missingRemoteHint(err: UploadRefError, ref: string): string {
  return (
    `【附件读不到】${err.message}\n` +
    `这个附件是家长在**他自己电脑上**上传的，服务端没有这份文件，所以读不到内容。请如实告诉家长（不要再去试 materials/、uploads/、parents/ 等路径，都不通）：\n` +
    `- 升级客户端后**重新发送这条消息/重新上传这张图**（新版会把附件上传到服务端，服务端就能读了）；或\n` +
    `- 直接把图片里的关键内容用文字发过来（如题目、生字、页码）。\n` +
    `（引用：${ref}）`
  );
}

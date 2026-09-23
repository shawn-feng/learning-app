/**
 * 文件区网盘路由（ISSUE-131 P1）：双端文件管理的服务端真源操作面。
 *
 * P1 不动物理布局，把现有三区挂成**统一虚拟视图**：
 *   家长 scope（token → parentId，childId 省略）虚拟根 =
 *     materials/          → 物理 <dataDir>/materials/<pid>/   （资料真源；写走 putMaterial 语义）
 *     uploads/            → 物理 <dataDir>/files/<pid>/       （服务端大文件通道原始件，files 表管理）
 *     <其余段>/…          → 物理 <dataDir>/workspaces/<pid>/… （孩子工作区 / parent / 全部可管）
 *   孩子 scope（token + childId + 归属断言）根 = 物理 <dataDir>/workspaces/<pid>/<cid>/（一区，无虚拟映射）。
 * P2 物理归并后 materials/uploads 落进 workspaces/<pid>/，虚拟映射在此单点塌缩成单根。
 *
 * 安全红线（R-6）：
 *   - 所有路径先 normalizeRelPath（拒 ..、绝对路径、反斜杠）再 resolveWithin 沙箱；
 *   - 家长之间隔离：根永远锚在登录家长的 pid 下；孩子 scope：先断言 children 归属再锚 <cid>；
 *   - 目录移动拒绝移进自身/自身子目录（R-8）。
 * materials 区（R-1 / R-8）：删除/改名/移出前做引用影响检查（courses.html_path / material /
 * send_material、display_contents、孩子库 exam_plans scope——命中则要求 confirm:true 才执行）；
 * 写删后调用 scanMaterials 现场重建索引 = 磁盘即真源，无索引漂移（P2 删表后这些调用整体移除）。
 * uploads 区（P1 收敛面）：uuid 落盘名 + files 表登记，只开 list/download/upload/delete——
 * 改名/移动会扯断 `files/<id>` 引用语义（R-2），P2 归并到 workspaces/<pid>/uploads/ 后再放开。
 */
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { resolveWithin, safeSegment } from "@pi/agent-core";
import {
  legacyMaterialsRoot,
  listMaterialsMeta,
  materialsRoot,
  resolveMaterialFile,
} from "../db/materials.js";
import { splitTopic } from "../agent/parent-materials.js";

interface FsDeps {
  config: ServerConfig;
  db: DatabaseSync;
}

/** 一次网盘操作的鉴权上下文：childId 为 null = 家长 scope（整棵虚拟树）。 */
export interface FsCtx {
  dataDir: string;
  db: DatabaseSync;
  parentId: string;
  childId: string | null;
}

export type FsZone = "materials" | "uploads" | "workspace";

export interface FsEntry {
  /** 展示名（uploads 区 = files 表 original_name） */
  name: string;
  /** 人类可读标签（孩子目录 = 孩子名）；展示优先于 name，操作仍用 path */
  label?: string;
  /** 规范虚拟路径（相对 scope 根，posix）——所有变更操作都用它定位 */
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
  /** uploads 区专属：files 表行 id（agent 引用形态 files/<id>） */
  fileId?: string;
}

export interface RefHit {
  source: "course" | "display" | "exam_plan";
  detail: string;
}

const MAX_LIST_ENTRIES = 500;

// ---------------------------------------------------------------------------
// 路径解析
// ---------------------------------------------------------------------------

/** 归一化相对路径：正斜杠、去首尾与前导斜杠；拒 . / .. 段；空串 = 根。 */
export function normalizeRelPath(rel: string): string {
  const raw = String(rel ?? "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!raw) return "";
  const parts = raw.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "." || p === "..") throw new ApiError(400, `路径不允许包含 . 或 .. 段：${rel}`);
  }
  return parts.join("/");
}

/** 单段文件/目录名（新建/改名用）：非空、不含分隔符、不得为 . / ..（允许点开头的名字，如 .pi）。 */
export function safeName(name: string): string {
  const v = String(name ?? "").trim();
  if (!v || v === "." || v === ".." || /[\\/]/.test(v) || v.includes("\0")) {
    throw new ApiError(400, `非法名称：${name}`);
  }
  return v;
}

/** 三区物理根（P2 归并后布局：全部在家长工作区内；uploads 旧根 files/<pid> 由列表/解析兜底）。 */
function zoneRoot(ctx: FsCtx, zone: FsZone): string {
  if (zone === "materials") return materialsRoot(ctx.dataDir, ctx.parentId);
  if (zone === "uploads") return path.join(ctx.dataDir, "workspaces", ctx.parentId, "uploads");
  return ctx.childId
    ? path.join(ctx.dataDir, "workspaces", ctx.parentId, safeSegment(ctx.childId, "childId"))
    : path.join(ctx.dataDir, "workspaces", ctx.parentId);
}

/** uploads 旧物理根（files 通道 2026-09-22 前的落盘位置；存量只读兜底+可管）。 */
function legacyUploadsRoot(ctx: FsCtx): string {
  return path.join(ctx.dataDir, "files", ctx.parentId);
}

/** materials 相对路径在双根上的存在性（新根优先返回实际所在物理路径；都不在返回 null）。 */
function resolveMaterialsPhysical(ctx: FsCtx, zoneRel: string): string | null {
  for (const abs of [
    path.join(materialsRoot(ctx.dataDir, ctx.parentId), zoneRel),
    path.join(legacyMaterialsRoot(ctx.dataDir, ctx.parentId), zoneRel),
  ]) {
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** uploads 相对路径在双根上的实际物理位置（新根优先；zoneRel = 区内相对 stored 路径）。 */
function resolveUploadsPhysical(ctx: FsCtx, zoneRel: string): string | null {
  for (const abs of [
    path.join(zoneRoot(ctx, "uploads"), zoneRel),
    path.join(legacyUploadsRoot(ctx), zoneRel),
  ]) {
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

/** uploads 条目物理名变更后同步 files 表 stored_path（保持 files/<id> 引用可解析，R-2）。 */
function syncUploadsRow(ctx: FsCtx, oldZoneRel: string, newZoneRel: string): void {
  try {
    ctx.db
      .prepare("UPDATE files SET stored_path = ? WHERE parent_id = ? AND stored_path = ?")
      .run(newZoneRel, ctx.parentId, oldZoneRel);
  } catch {
    /* 登记同步失败不阻断磁盘操作 */
  }
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** 虚拟路径拼接（区名前缀 + 区内相对目录 + 名）；zoneRel 为空 = 区根。 */
function joinZone(zone: FsZone, zoneRel: string, name: string): string {
  const base = zone === "materials" ? "materials" : zone === "uploads" ? "uploads" : "";
  return [base, zoneRel, name].filter(Boolean).join("/");
}

/**
 * 虚拟路径 → 物理绝对路径 + 所属区。家长 scope 首段 materials/uploads 是保留区名；
 * 孩子 scope 整棵都在自己工作区内（zone 恒为 workspace）。
 */
export function resolveEntry(
  ctx: FsCtx,
  rel: string
): { abs: string; zone: FsZone; zoneRel: string } {
  const norm = normalizeRelPath(rel);
  if (!ctx.childId) {
    if (norm === "materials" || norm.startsWith("materials/")) {
      const zoneRel = norm === "materials" ? "" : norm.slice("materials/".length);
      return { abs: resolveWithin(zoneRoot(ctx, "materials"), zoneRel || "."), zone: "materials", zoneRel };
    }
    if (norm === "uploads" || norm.startsWith("uploads/")) {
      const zoneRel = norm === "uploads" ? "" : norm.slice("uploads/".length);
      return { abs: resolveWithin(zoneRoot(ctx, "uploads"), zoneRel || "."), zone: "uploads", zoneRel };
    }
  }
  return { abs: resolveWithin(zoneRoot(ctx, "workspace"), norm || "."), zone: "workspace", zoneRel: norm };
}

/** 家长 scope 的保留区根（materials/ uploads/）不可改名/删除/移动。 */
function guardZoneRoot(entry: { zone: FsZone; zoneRel: string }, op: string): void {
  if (entry.zone !== "workspace" && entry.zoneRel === "") {
    throw new ApiError(400, `保留区目录不能${op}`);
  }
}

/** 家长虚拟根下不能新建与保留区同名的项（会被区映射遮住）。 */
function guardReservedName(ctx: FsCtx, parentZone: FsZone, parentZoneRel: string, name: string): void {
  if (!ctx.childId && parentZone === "workspace" && parentZoneRel === "" && (name === "materials" || name === "uploads")) {
    throw new ApiError(400, "materials / uploads 是保留区名，请换一个名称");
  }
}

// ---------------------------------------------------------------------------
// 引用影响检查（R-1）
// ---------------------------------------------------------------------------

/** 引用口径归一：兼容旧 `materials/` 前缀与 ./ 前缀、反斜杠。 */
function normMaterialRef(p: string): string {
  return String(p ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/^materials\//, "");
}

function refMatches(refPath: string, targetRel: string, isDir: boolean): boolean {
  const n = normMaterialRef(refPath);
  if (!n) return false;
  if (n === targetRel) return true;
  return isDir && n.startsWith(targetRel + "/");
}

function openSqlite(file: string): DatabaseSync | null {
  if (!fs.existsSync(file)) return null;
  return new DatabaseSync(file);
}

/** 列出该家长全部孩子 id。 */
function listChildIds(ctx: FsCtx): string[] {
  try {
    return (
      ctx.db.prepare("SELECT id FROM children WHERE parent_id = ?").all(ctx.parentId) as Array<{ id: string }>
    ).map((r) => r.id);
  } catch {
    return [];
  }
}

function openChildKbRO(ctx: FsCtx, childId: string): DatabaseSync | null {
  return openSqlite(path.join(ctx.dataDir, "kb", ctx.parentId, `${safeSegment(childId, "childId")}.sqlite`));
}

/**
 * R-1：materials 相对路径（文件或目录）被哪些业务引用着。
 * 扫 courses.html_path（精确）+ material/send_material（正文提及）+ 各孩子库
 * display_contents（source=materials）+ 孩子库 exam_plans scope（命中课程挂着的考核计划）。
 */
export function findMaterialReferences(ctx: FsCtx, targetRel: string): RefHit[] {
  const hits: RefHit[] = [];
  const matAbs = resolveMaterialsPhysical(ctx, targetRel);
  const isDir = !!matAbs && fs.statSync(matAbs).isDirectory();

  // 1) 家长库 courses：html_path 精确命中；material/send_material 正文包含
  const lib = openSqlite(path.join(ctx.dataDir, "parents", ctx.parentId, "parent.sqlite"));
  const affectedCourses = new Set<string>();
  if (lib) {
    try {
      const rows = lib
        .prepare("SELECT topic, title, html_path, material, send_material FROM courses")
        .all() as Array<{ topic: string; title: string; html_path: string; material: string; send_material: string }>;
      for (const r of rows) {
        if (r.html_path && refMatches(r.html_path, targetRel, isDir)) {
          affectedCourses.add(r.title);
          hits.push({ source: "course", detail: `课程「${r.topic}/${r.title}」的 html_path 指向 ${targetRel}` });
        } else if (
          (r.material && r.material.includes(targetRel)) ||
          (r.send_material && r.send_material.includes(targetRel))
        ) {
          affectedCourses.add(r.title);
          hits.push({ source: "course", detail: `课程「${r.topic}/${r.title}」的资料文本提到 ${targetRel}` });
        }
      }
    } finally {
      lib.close();
    }
  }

  for (const cid of listChildIds(ctx)) {
    try {
      const kb = openChildKbRO(ctx, cid);
      if (!kb) continue;
      try {
        // 2) display_contents（source=materials 的展示登记）
        try {
          const rows = kb
            .prepare("SELECT DISTINCT child_key, path FROM display_contents WHERE source = 'materials'")
            .all() as Array<{ child_key: string; path: string }>;
          for (const r of rows) {
            if (refMatches(r.path, targetRel, isDir)) {
              hits.push({
                source: "display",
                detail: `孩子「${cid}/${r.child_key}」的展示登记引用 ${normMaterialRef(r.path)}`,
              });
            }
          }
        } catch {
          /* 无表（未登记过）跳过 */
        }
        // 3) 考核计划 scope：courses 命中 → 计划受影响
        if (affectedCourses.size) {
          try {
            const plans = kb
              .prepare("SELECT title, scope_json FROM exam_plans WHERE active = 1")
              .all() as Array<{ title: string; scope_json: string }>;
            for (const p of plans) {
              let names: string[] = [];
              try {
                const scope = JSON.parse(p.scope_json || "{}") as { courses?: unknown };
                if (Array.isArray(scope.courses)) {
                  names = scope.courses
                    .map((c) => (typeof c === "string" ? c : ((c as { title?: string })?.title ?? "")))
                    .filter(Boolean);
                }
              } catch {
                /* 坏 scope 跳过 */
              }
              const hit = names.filter((n) => affectedCourses.has(n));
              if (hit.length) {
                hits.push({ source: "exam_plan", detail: `考核计划「${p.title}」引用课程：${hit.join("、")}` });
              }
            }
          } catch {
            /* 无表跳过 */
          }
        }
      } finally {
        kb.close();
      }
    } catch {
      /* 单孩子库读取失败不阻断 */
    }
  }

  return hits;
}

/** materials 区写删前置检查：命中引用且未 confirm → 返回待确认载荷（路由层短路返回）。 */
function guardMaterialsRefs(
  ctx: FsCtx,
  zoneRel: string,
  confirm: boolean
): { needsConfirm: true; refs: RefHit[] } | null {
  const refs = findMaterialReferences(ctx, zoneRel);
  if (refs.length && !confirm) return { needsConfirm: true, refs };
  return null;
}

/** splitTopic 抛的是业务 Error → 转成 400（topic 第一段 ^[a-zA-Z0-9_-]+$）。 */
function assertTopic(destRel: string): void {
  try {
    splitTopic(destRel);
  } catch (err) {
    throw new ApiError(400, (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// 列目录
// ---------------------------------------------------------------------------

function listPhysicalDir(absDir: string, virtualPrefix: string): FsEntry[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(absDir, { encoding: "utf-8" });
  } catch {
    return [];
  }
  const out: FsEntry[] = [];
  for (const name of names.slice(0, MAX_LIST_ENTRIES)) {
    const abs = path.join(absDir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    out.push({
      name,
      path: virtualPrefix ? `${virtualPrefix}/${name}` : name,
      type: st.isDirectory() ? "dir" : "file",
      size: st.isFile() ? st.size : 0,
      mtime: st.mtime.toISOString(),
    });
  }
  return out;
}

/** 目录列表（家长虚拟根 / 物理目录通用）。uploads 区用 files 表补全展示名。 */
export function fsList(ctx: FsCtx, rel: string): { path: string; entries: FsEntry[] } {  const norm = normalizeRelPath(rel);
  if (!ctx.childId && norm === "") {
    // 家长虚拟根：materials/ + uploads/ + workspaces/<pid>/ 的直接子项
    const entries: FsEntry[] = [
      { name: "materials", path: "materials", type: "dir", size: 0, mtime: "", label: "课程资料库" },
      { name: "uploads", path: "uploads", type: "dir", size: 0, mtime: "", label: "上传原始件" },
    ];
    // 孩子目录/家长运行区配人类可读标签（uuid 不标名家长没法管）
    const childNames = new Map<string, string>();
    try {
      for (const r of ctx.db.prepare("SELECT id, name FROM children WHERE parent_id = ?").all(ctx.parentId) as Array<{ id: string; name: string }>) {
        childNames.set(r.id, r.name);
      }
    } catch {
      /* 查不到就退化为原名 */
    }
    for (const e of listPhysicalDir(zoneRoot(ctx, "workspace"), "")) {
      if (childNames.has(e.name)) e.label = `${childNames.get(e.name)} 的工作区`;
      else if (e.name === "parent") e.label = "家长工作区";
      entries.push(e);
    }
    return { path: "", entries };
  }
  const { abs, zone, zoneRel } = resolveEntry(ctx, norm);
  // P2 双根：区目录在新根或旧根任一存在即可列
  const zoneExists =
    zone === "materials"
      ? [materialsRoot(ctx.dataDir, ctx.parentId), legacyMaterialsRoot(ctx.dataDir, ctx.parentId)].some((r) =>
          fs.existsSync(path.join(r, zoneRel))
        )
      : zone === "uploads"
        ? [zoneRoot(ctx, "uploads"), legacyUploadsRoot(ctx)].some((r) => fs.existsSync(path.join(r, zoneRel)))
        : fs.existsSync(abs);
  if (!zoneExists) {
    // 全新家长/孩子的空工作区/空区 → 空目录而不是 404
    if (norm === "") return { path: norm, entries: [] };
    throw new ApiError(404, "目录不存在");
  }
  // 目录性质检查按区感知（双根下任一物理位置存在即可；workspace 区仍看 abs 本身）
  if (zone === "workspace") {
    if (!fs.statSync(abs).isDirectory()) throw new ApiError(400, "不是目录");
  } else {
    const physical =
      zone === "materials"
        ? resolveMaterialsPhysical(ctx, zoneRel)
        : resolveUploadsPhysical(ctx, zoneRel);
    if (physical && fs.statSync(physical).isFile()) throw new ApiError(400, "不是目录");
  }
  if (zone === "uploads") {
    // files 通道原始件：新根 + 旧根（files/<pid> 存量）合并列出，磁盘为准；
    // files 表按 stored_path 补 original_name / id（旧根的 stored = <stored>，新根同）
    const byStored = new Map<string, { id: string; original_name: string }>();
    try {
      const rows = ctx.db
        .prepare("SELECT id, original_name, stored_path FROM files WHERE parent_id = ?")
        .all(ctx.parentId) as Array<{ id: string; original_name: string; stored_path: string }>;
      for (const r of rows) byStored.set(r.stored_path, { id: r.id, original_name: r.original_name });
    } catch {
      /* 表读失败则退化为纯落盘名 */
    }
    const relBase = zoneRel ? `${zoneRel}/` : "";
    const byName = new Map<string, FsEntry>();
    for (const root of [legacyUploadsRoot(ctx), zoneRoot(ctx, "uploads")]) {
      const rootAbs = zoneRel ? path.join(root, zoneRel) : root;
      for (const e of listPhysicalDir(rootAbs, norm)) {
        const row = byStored.get(relBase + e.name);
        byName.set(e.name, row ? { ...e, name: row.original_name || e.name, fileId: row.id } : e);
      }
    }
    return { path: norm, entries: [...byName.values()] };
  }
  if (zone === "materials") {
    // P2 双根合并列出（新根覆盖同名旧根条目）；跳过运行时目录
    const byName = new Map<string, FsEntry>();
    for (const root of [legacyMaterialsRoot(ctx.dataDir, ctx.parentId), zoneRoot(ctx, "materials")]) {
      const rootAbs = zoneRel ? path.join(root, zoneRel) : root;
      for (const e of listPhysicalDir(rootAbs, norm)) {
        if (e.type === "dir" && [".pi", "node_modules", ".git"].includes(e.name)) continue;
        byName.set(e.name, e);
      }
    }
    return { path: norm, entries: [...byName.values()] };
  }
  return { path: norm, entries: listPhysicalDir(abs, norm) };
}

// ---------------------------------------------------------------------------
// 检索（当前目录范围内向下递归，名字包含匹配）
// ---------------------------------------------------------------------------

const MAX_SEARCH_NODES = 20000;
const MAX_SEARCH_RESULTS = 500;
const MAX_SEARCH_DEPTH = 8;
/** 运行时目录不进检索（agent 状态/依赖动辄上万文件，会把扫描预算烧光，也不是用户内容） */
const SEARCH_SKIP_DIRS = new Set([".pi", "node_modules", ".git"]);

/**
 * 子树检索：从 base 目录向下广度优先（上限：扫描 20000 项 / 命中 500 条 / 深度 8 层，
 * 超限标 truncated），名字大小写不敏感包含匹配；目录也参与命中（点击可跳转）。
 * 家长虚拟根（rel=""）= 三棵物理树合并进同一搜索队列，前缀即虚拟路径。
 * uploads 区结果同 list 语义，用 files 表补 original_name 展示名。
 */
export function fsSearch(
  ctx: FsCtx,
  baseRel: string,
  query: string
): { path: string; query: string; entries: FsEntry[]; truncated: boolean } {
  const needle = String(query ?? "").trim().toLowerCase();
  if (!needle) throw new ApiError(400, "检索词不能为空");
  const baseNorm = normalizeRelPath(baseRel);
  const base = resolveEntry(ctx, baseNorm);
  if (!fs.existsSync(base.abs) || !fs.statSync(base.abs).isDirectory()) throw new ApiError(404, "目录不存在");

  const results: FsEntry[] = [];
  let scanned = 0;
  let truncated = false;
  // BFS 队列：父根检索时新+旧物理树一起入队（materials/uploads 双根 + workspaces），命中不因单棵深树饿死
  const queue: Array<{ abs: string; vp: string; depth: number }> = [];
  if (!ctx.childId && baseNorm === "") {
    queue.push(
      { abs: materialsRoot(ctx.dataDir, ctx.parentId), vp: "materials", depth: 1 },
      { abs: legacyMaterialsRoot(ctx.dataDir, ctx.parentId), vp: "materials", depth: 1 },
      { abs: zoneRoot(ctx, "uploads"), vp: "uploads", depth: 1 },
      { abs: legacyUploadsRoot(ctx), vp: "uploads", depth: 1 },
      { abs: path.join(ctx.dataDir, "workspaces", ctx.parentId), vp: "", depth: 1 }
    );
  } else {
    queue.push({ abs: base.abs, vp: baseNorm, depth: 1 });
  }

  while (queue.length) {
    if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_NODES) {
      truncated = true;
      break;
    }
    const { abs, vp, depth } = queue.shift()!;
    let names: string[] = [];
    try {
      names = fs.readdirSync(abs, { encoding: "utf-8" });
    } catch {
      continue;
    }
    for (const name of names) {
      if (results.length >= MAX_SEARCH_RESULTS || scanned >= MAX_SEARCH_NODES) {
        truncated = true;
        break;
      }
      scanned++;
      const childAbs = path.join(abs, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(childAbs);
      } catch {
        continue;
      }
      const childVp = vp ? `${vp}/${name}` : name;
      if (name.toLowerCase().includes(needle)) {
        results.push({
          name,
          path: childVp,
          type: st.isDirectory() ? "dir" : "file",
          size: st.isFile() ? st.size : 0,
          mtime: st.mtime.toISOString(),
        });
      }
      if (st.isDirectory()) {
        if (depth >= MAX_SEARCH_DEPTH) {
          truncated = true;
        } else if (!SEARCH_SKIP_DIRS.has(name)) {
          queue.push({ abs: childAbs, vp: childVp, depth: depth + 1 });
        }
      }
    }
  }

  if (base.zone === "uploads" || (!ctx.childId && baseNorm === "")) {
    const byStored = new Map<string, { id: string; original_name: string }>();
    try {
      const rows = ctx.db
        .prepare("SELECT id, original_name, stored_path FROM files WHERE parent_id = ?")
        .all(ctx.parentId) as Array<{ id: string; original_name: string; stored_path: string }>;
      for (const r of rows) byStored.set(r.stored_path, { id: r.id, original_name: r.original_name });
    } catch {
      /* 退化纯落盘名 */
    }
    for (const e of results) {
      if (!e.path.startsWith("uploads/")) continue;
      const row = byStored.get(e.path.slice("uploads/".length));
      if (row) {
        e.name = row.original_name || e.name;
        e.fileId = row.id;
      }
    }
  }
  return { path: baseNorm, query: needle, entries: results, truncated };
}

// ---------------------------------------------------------------------------
// 新建目录 / 改名 / 移动 / 删除
// ---------------------------------------------------------------------------

export function fsMkdir(ctx: FsCtx, rel: string, name: string): { path: string } {
  const dir = resolveEntry(ctx, rel);
  if (!fs.existsSync(dir.abs) || !fs.statSync(dir.abs).isDirectory()) throw new ApiError(404, "目标目录不存在");
  const n = safeName(name);
  guardReservedName(ctx, dir.zone, dir.zoneRel, n);
  if (dir.zone === "materials" && dir.zoneRel === "") {
    assertTopic(n); // materials 根下新建 = 新 topic，规则与 /materials/upload 一致
  }
  const abs = resolveWithin(dir.abs, n);
  if (fs.existsSync(abs)) throw new ApiError(409, "同名目录或文件已存在");
  fs.mkdirSync(abs, { recursive: true });
  return { path: joinZone(dir.zone, dir.zoneRel, n) };
}

/** 改名（同目录内）。materials 区先过 R-1；uploads 区 P2 放开（同步 files 行 stored_path）。 */
export function fsRename(
  ctx: FsCtx,
  rel: string,
  newName: string,
  opts: { confirm?: boolean } = {}
): { path?: string; needsConfirm?: boolean; refs?: RefHit[] } {
  const entry = resolveEntry(ctx, rel);
  guardZoneRoot(entry, "改名");
  const n = safeName(newName);
  if (!fs.existsSync(entry.abs)) {
    // materials 双根兜底（存量在旧根）
    if (entry.zone !== "materials") throw new ApiError(404, "文件或目录不存在");
  }
  const srcAbs =
    entry.zone === "materials"
      ? resolveMaterialsPhysical(ctx, entry.zoneRel) ?? entry.abs
      : entry.zone === "uploads"
        ? resolveUploadsPhysical(ctx, entry.zoneRel) ?? entry.abs
        : entry.abs;
  if (!fs.existsSync(srcAbs)) throw new ApiError(404, "文件或目录不存在");
  const destAbs = resolveWithin(path.dirname(srcAbs), n);
  if (fs.existsSync(destAbs)) throw new ApiError(409, "同名文件或目录已存在");
  if (entry.zone === "materials") {
    const guard = guardMaterialsRefs(ctx, entry.zoneRel, opts.confirm === true);
    if (guard) return guard;
  }
  fs.renameSync(srcAbs, destAbs);
  const parentRel = entry.zoneRel.includes("/")
    ? entry.zoneRel.slice(0, entry.zoneRel.lastIndexOf("/"))
    : "";
  if (entry.zone === "uploads") syncUploadsRow(ctx, entry.zoneRel, joinRel(parentRel, n));
  return { path: joinZone(entry.zone, parentRel, n) };
}

/** 移动到另一目录（同 scope 内）。跨区进 materials = 转存语义（putMaterial 流程）。 */
export function fsMove(
  ctx: FsCtx,
  fromRel: string,
  toDirRel: string,
  opts: { confirm?: boolean } = {}
): { path?: string; needsConfirm?: boolean; refs?: RefHit[] } {
  const from = resolveEntry(ctx, fromRel);
  const toDir = resolveEntry(ctx, toDirRel);
  guardZoneRoot(from, "移动");
  const fromAbs =
    from.zone === "materials"
      ? resolveMaterialsPhysical(ctx, from.zoneRel) ?? from.abs
      : from.zone === "uploads"
        ? resolveUploadsPhysical(ctx, from.zoneRel) ?? from.abs
        : from.abs;
  if (!fs.existsSync(fromAbs)) throw new ApiError(404, "源文件或目录不存在");
  if (!fs.existsSync(toDir.abs) || !fs.statSync(toDir.abs).isDirectory()) throw new ApiError(404, "目标目录不存在");
  const name = path.basename(fromAbs);
  const fromNorm = normalizeRelPath(fromRel);
  const toDirNorm = normalizeRelPath(toDirRel);
  if (toDirNorm === fromNorm || toDirNorm.startsWith(fromNorm + "/")) {
    throw new ApiError(400, "不能把目录移动进它自己或它的子目录");
  }
  if (from.zone === "uploads" || toDir.zone === "uploads") {
    // uploads 区内改名/换位支持；跨区移动会破坏 files/<id> 引用语义（登记行跟随复杂），仍禁止
    if (!(from.zone === "uploads" && toDir.zone === "uploads")) {
      throw new ApiError(400, "uploads 区原始件挂着 files 表登记（files/<id> 引用），暂不支持跨区移动");
    }
  }
  const destAbs = resolveWithin(toDir.abs, name);
  if (fs.existsSync(destAbs)) throw new ApiError(409, "目标已存在同名文件或目录");

  // R-1：源在 materials（改名/移出/移走都算破坏引用）
  if (from.zone === "materials") {
    const guard = guardMaterialsRefs(ctx, from.zoneRel, opts.confirm === true);
    if (guard) return guard;
  }

  if (from.zone === toDir.zone) {
    fs.renameSync(fromAbs, destAbs);
    if (from.zone === "uploads") {
      syncUploadsRow(ctx, from.zoneRel, joinRel(toDir.zoneRel, name));
    }
  } else if (toDir.zone === "materials") {
    // 转存进资料真源：putMaterial 流程（topic 约束 + 写新根），然后删源（move 语义）
    if (!fs.statSync(fromAbs).isFile()) {
      throw new ApiError(400, "整目录转存进 materials 暂不支持，请逐个文件转存");
    }
    const destRel = normalizeRelPath(`${toDir.zoneRel ? toDir.zoneRel + "/" : ""}${name}`);
    assertTopic(destRel);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.copyFileSync(fromAbs, destAbs);
    fs.rmSync(fromAbs, { force: true });
  } else {
    // materials → workspace：先复制保数据，再删源
    if (fs.statSync(fromAbs).isDirectory()) {
      fs.cpSync(fromAbs, destAbs, { recursive: true });
    } else {
      fs.copyFileSync(fromAbs, destAbs);
    }
    fs.rmSync(fromAbs, { recursive: true, force: true });
  }
  return { path: joinZone(toDir.zone, toDir.zoneRel, name) };
}

export function fsDelete(
  ctx: FsCtx,
  rel: string,
  opts: { confirm?: boolean } = {}
): { ok?: true; needsConfirm?: boolean; refs?: RefHit[] } {
  const norm = normalizeRelPath(rel);
  if (norm === "") throw new ApiError(400, "不能删除根目录");
  const entry = resolveEntry(ctx, norm);
  guardZoneRoot(entry, "删除");
  const entryAbs =
    entry.zone === "materials"
      ? resolveMaterialsPhysical(ctx, entry.zoneRel)
      : entry.zone === "uploads"
        ? resolveUploadsPhysical(ctx, entry.zoneRel)
        : entry.abs;
  if (!entryAbs || !fs.existsSync(entryAbs)) throw new ApiError(404, "文件或目录不存在");

  if (entry.zone === "uploads") {
    // files 表行一并删（与 DELETE /files/:id 同语义：登记与磁盘保持一致）
    try {
      ctx.db.prepare("DELETE FROM files WHERE parent_id = ? AND stored_path = ?").run(ctx.parentId, entry.zoneRel);
    } catch {
      /* 登记删除失败不阻断磁盘删除 */
    }
    fs.rmSync(entryAbs, { recursive: true, force: true });
    return { ok: true };
  }
  if (entry.zone === "materials") {
    const guard = guardMaterialsRefs(ctx, entry.zoneRel, opts.confirm === true);
    if (guard) return guard;
    // 双根哪里有删哪里（存量兼容；索引表已删无需清理行）
    for (const abs of [
      path.join(materialsRoot(ctx.dataDir, ctx.parentId), entry.zoneRel),
      path.join(legacyMaterialsRoot(ctx.dataDir, ctx.parentId), entry.zoneRel),
    ]) {
      try {
        if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
      } catch {
        /* 单根失败不阻断另一根 */
      }
    }
    return { ok: true };
  }
  fs.rmSync(entryAbs, { recursive: true, force: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 上传
// ---------------------------------------------------------------------------

function safeExt(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : "";
}

/** 通用上传落点：materials（putMaterial 语义）/ uploads（files 表登记）/ workspace（普通文件）。 */
export function fsSaveUpload(
  ctx: FsCtx,
  dirRel: string,
  filename: string,
  tmpPath: string,
  mime: string,
  opts: { overwrite?: boolean } = {}
): { entry: FsEntry; conflict?: boolean } {
  const dir = resolveEntry(ctx, dirRel);
  // materials / uploads 区落盘目录由各分支自建（新 topic、全新 files/<pid> 均合法），跳过存在性检查
  if (dir.zone === "workspace") {
    if (!fs.existsSync(dir.abs) || !fs.statSync(dir.abs).isDirectory()) throw new ApiError(404, "目标目录不存在");
  }
  const n = safeName(filename);
  guardReservedName(ctx, dir.zone, dir.zoneRel, n);

  if (dir.zone === "uploads") {
    // files 通道同款：uuid 落盘名 + files 表登记（original_name 保留展示名）
    const id = crypto.randomUUID();
    const storedPath = `${id}${safeExt(n)}`;
    const abs = resolveWithin(dir.abs, storedPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tmpPath, abs);
    const size = fs.statSync(abs).size;
    const createdAt = new Date().toISOString();
    try {
      ctx.db
        .prepare(
          "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(id, ctx.parentId, ctx.childId, n, storedPath, mime, size, createdAt);
    } catch {
      /* 登记失败不阻断落盘（列表以磁盘为准，仍可见） */
    }
    return {
      entry: { name: n, path: joinZone("uploads", "", storedPath), type: "file", size, mtime: createdAt, fileId: id },
    };
  }

  if (dir.zone === "materials") {
    const destRel = normalizeRelPath(`${dir.zoneRel ? dir.zoneRel + "/" : ""}${n}`);
    assertTopic(destRel);
    // 冲突检查看双根（旧根同名文件会被新根同名遮蔽）
    if (resolveMaterialsPhysical(ctx, destRel) && !opts.overwrite) {
      return { entry: { name: n, path: joinZone("materials", dir.zoneRel, n), type: "file", size: 0, mtime: "" }, conflict: true };
    }
    const abs = resolveWithin(dir.abs, n);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.renameSync(tmpPath, abs);
    const stat = fs.statSync(abs);
    return { entry: { name: n, path: joinZone("materials", dir.zoneRel, n), type: "file", size: stat.size, mtime: stat.mtime.toISOString() } };
  }

  const abs = resolveWithin(dir.abs, n);
  const parentNorm = normalizeRelPath(dirRel);
  if (fs.existsSync(abs) && !opts.overwrite) {
    const st = fs.statSync(abs);
    return {
      entry: { name: n, path: `${parentNorm}/${n}`, type: "file", size: st.size, mtime: st.mtime.toISOString() },
      conflict: true,
    };
  }
  fs.renameSync(tmpPath, abs);
  const st = fs.statSync(abs);
  return {
    entry: { name: n, path: `${parentNorm}/${n}`, type: "file", size: st.size, mtime: st.mtime.toISOString() },
  };
}

// ---------------------------------------------------------------------------
// 路由装配
// ---------------------------------------------------------------------------

function authCtx(
  req: { headers: Record<string, string | string[] | undefined>; query?: unknown },
  deps: FsDeps,
  flexible: boolean
): FsCtx {
  const header = req.headers.authorization;
  let token = typeof header === "string" ? header.replace(/^Bearer\s+/i, "").trim() : "";
  if (!token && flexible) {
    const q = (req.query ?? {}) as { token?: unknown };
    token = typeof q.token === "string" ? q.token.trim() : "";
  }
  if (!token) throw new ApiError(401, "缺少 session token");
  let parentId = "";
  try {
    parentId = verifySession(token, deps.config.jwtSecret).parent_id;
  } catch {
    throw new ApiError(401, "session 无效或已过期，请重新登录");
  }
  return { dataDir: deps.config.dataDir, db: deps.db, parentId, childId: null };
}

/** 孩子上下文：家长 token + childId + 归属断言（R-6：越过自己 <cid> 一律拒绝）。导出供回归测试用。 */
export function withChild(ctx: FsCtx, childIdRaw: unknown): FsCtx {
  const childId = String(childIdRaw ?? "").trim();
  if (!childId) return ctx;
  const owned = ctx.db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(childId, ctx.parentId);
  if (!owned) throw new ApiError(403, "无权访问该孩子的数据");
  return { ...ctx, childId: safeSegment(childId, "childId") };
}

export function registerFsRoutes(app: FastifyInstance, deps: FsDeps): void {
  const jsonHandler = (
    fn: (ctx: FsCtx, body: Record<string, unknown>) => unknown
  ) => {
    return async (req: FastifyRequest, reply: any) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const ctx = withChild(authCtx(req, deps, false), body.childId);
        return reply.send(fn(ctx, body));
      } catch (err) {
        if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    };
  };

  app.post("/api/v1/fs/list", jsonHandler((ctx, body) => fsList(ctx, String(body.path ?? ""))));

  // 子树检索（当前目录范围内向下）
  app.post(
    "/api/v1/fs/search",
    jsonHandler((ctx, body) => fsSearch(ctx, String(body.path ?? ""), String(body.query ?? "")))
  );

  app.post(
    "/api/v1/fs/mkdir",
    jsonHandler((ctx, body) => fsMkdir(ctx, String(body.path ?? ""), String(body.name ?? "")))
  );

  app.post(
    "/api/v1/fs/rename",
    jsonHandler((ctx, body) =>
      fsRename(ctx, String(body.path ?? ""), String(body.newName ?? ""), { confirm: body.confirm === true })
    )
  );

  app.post(
    "/api/v1/fs/move",
    jsonHandler((ctx, body) =>
      fsMove(ctx, String(body.from ?? ""), String(body.toDir ?? ""), { confirm: body.confirm === true })
    )
  );

  app.post(
    "/api/v1/fs/delete",
    jsonHandler((ctx, body) => fsDelete(ctx, String(body.path ?? ""), { confirm: body.confirm === true }))
  );

  // R-1 预检：前端删/移前展示引用影响
  app.post(
    "/api/v1/fs/refs",
    jsonHandler((ctx, body) => {
      const entry = resolveEntry(ctx, String(body.path ?? ""));
      if (entry.zone !== "materials" || !entry.zoneRel) return { refs: [], zone: entry.zone };
      return { refs: findMaterialReferences(ctx, entry.zoneRel), zone: entry.zone };
    })
  );

  // 上传（multipart）：busboy 迭代中必须立即消费 file 流（M4 教训）——先落 tmp 再定位
  app.post("/api/v1/fs/upload", async (req, reply) => {
    const tmpDir = path.join(deps.config.dataDir, "tmp");
    fs.mkdirSync(tmpDir, { recursive: true });
    let tmpPath = "";
    try {
      let ctx = authCtx(req, deps, false);
      let filename = "";
      let mime = "application/octet-stream";
      let dirRel = "";
      let overwrite = false;
      const parts = req.parts();
      for await (const part of parts) {
        if (part.type === "field") {
          if (part.fieldname === "childId" || part.fieldname === "child_id") {
            ctx = withChild(ctx, String(part.value ?? ""));
          } else if (part.fieldname === "path") {
            dirRel = String(part.value ?? "");
          } else if (part.fieldname === "overwrite") {
            overwrite = String(part.value ?? "") === "true";
          }
          continue;
        }
        if (part.type === "file") {
          filename = path.basename(String(part.filename ?? ""));
          mime = String(part.mimetype ?? "application/octet-stream");
          tmpPath = path.join(tmpDir, `${crypto.randomUUID()}.upload`);
          await new Promise<void>((resolve, reject) => {
            const out = fs.createWriteStream(tmpPath);
            part.file.on("error", reject);
            out.on("error", reject);
            out.on("finish", resolve);
            part.file.pipe(out);
          });
        }
      }
      if (!filename || !tmpPath) return reply.code(400).send({ error: "缺少文件" });
      const r = fsSaveUpload(ctx, dirRel, filename, tmpPath, mime, { overwrite });
      if (r.conflict) return reply.code(409).send({ error: "目标已存在同名文件", entry: r.entry });
      return reply.send({ entry: r.entry });
    } catch (err) {
      try {
        if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        /* 清理失败忽略 */
      }
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });

  // 下载：GET + ?token= 兜底（a[download]/新标签无法带自定义请求头，与 files/materials GET 同款）
  app.get("/api/v1/fs/download", async (req, reply) => {
    try {
      const ctx = withChild(authCtx(req, deps, true), (req.query as Record<string, unknown>)?.childId);
      const entry = resolveEntry(ctx, String((req.query as Record<string, unknown>)?.path ?? ""));
      if (!fs.existsSync(entry.abs) || !fs.statSync(entry.abs).isFile()) {
        return reply.code(404).send({ error: "文件不存在" });
      }
      // 展示名：uploads 区优先 files 表 original_name
      let name = path.basename(entry.abs);
      if (entry.zone === "uploads") {
        try {
          const row = ctx.db
            .prepare("SELECT original_name FROM files WHERE parent_id = ? AND stored_path = ?")
            .get(ctx.parentId, entry.zoneRel) as { original_name?: string } | undefined;
          if (row?.original_name) name = row.original_name;
        } catch {
          /* 展示名回退落盘名 */
        }
      }
      const MIME: Record<string, string> = {
        html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8",
        css: "text/css", js: "text/javascript", json: "application/json",
        md: "text/markdown; charset=utf-8", txt: "text/plain; charset=utf-8",
        png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
        webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
        mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4",
        mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf",
      };
      const ext = path.extname(name).toLowerCase().replace(".", "");
      reply.header("Content-Type", MIME[ext] ?? "application/octet-stream");
      reply.header("Cache-Control", "no-store");
      const ascii = name.replace(/[^\x20-\x7e]/g, "_");
      reply.header(
        "Content-Disposition",
        `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
      );
      return reply.send(fs.createReadStream(entry.abs));
    } catch (err) {
      if (err instanceof ApiError) return reply.code(err.status).send({ error: err.message });
      throw err;
    }
  });
}

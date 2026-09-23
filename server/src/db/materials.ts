/**
 * Materials 真源（ISSUE-131 P2 物理归并后）：内容存服务端
 * `<dataDir>/workspaces/<parentId>/materials/`（家长工作区内的 assets 区）。
 *
 * 兼容层（存量不迁移）：物理归并前旧数据在 `<dataDir>/materials/<parentId>/`，
 * 读取一律经 `resolveMaterialFile`（新根优先、旧根兜底）；写/删只落新根；
 * 目录级列举用 `listMaterialsMeta` 合并两棵树（同相对路径新根覆盖旧根）。
 *
 * ⚠️ 2026-09-22 决策 1：materials **索引表已删**（纯镜像无归属价值）——
 * 列表 = 现场双根 walk；id = base64url(相对路径)（URL 安全，content/:id 解码后校验防穿越）。
 * 外部引用语法（courses.html_path 的 `topic/file`、display 的 `materials/topic/...`）不变，
 * 物理根变化全部由本模块单点吸收。
 */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export interface MaterialMeta {
  id: string;
  path: string;
  type: string;
  size: number;
  updated_at: string;
}

const TYPE_MAP: Record<string, string> = {
  html: "html",
  htm: "html",
  css: "css",
  js: "js",
  json: "json",
  md: "text",
  txt: "text",
  pdf: "other",
  mp4: "video",
  webm: "video",
  mp3: "audio",
  wav: "audio",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  svg: "image",
};

/** 新根（P2 归并后，唯一写入点）：`workspaces/<pid>/materials` */
export function materialsRoot(dataDir: string, parentId: string): string {
  return path.join(dataDir, "workspaces", parentId, "materials");
}

/** 旧根（P2 归并前布局，存量只读兼容，永不写入）：`<dataDir>/materials/<pid>` */
export function legacyMaterialsRoot(dataDir: string, parentId: string): string {
  return path.join(dataDir, "materials", parentId);
}

export function inferType(relPath: string): string {
  const ext = path.extname(relPath).toLowerCase().replace(".", "");
  return TYPE_MAP[ext] ?? "other";
}

export function encodeMaterialId(relPath: string): string {
  return Buffer.from(relPath, "utf-8").toString("base64url");
}

export function decodeMaterialId(id: string): string {
  return Buffer.from(id, "base64url").toString("utf-8");
}

/** 递归收集目录下所有文件（相对 posix 路径）。
 * ⚠️ 不用 fs.readdirSync(recursive)：recursive 模式**不跟随目录符号链接**，会漏掉
 * 软链目录（如 english → ChildWeb/english-learner，2026-08-29 部署踩坑）。
 * 这里手写 walk：statSync follow 文件/目录软链接；realpath 去重防环。
 */
export function walkFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue; // 目录不可达（坏链）跳过
    }
    if (seen.has(real)) continue; // 防环（软链接指回祖先）
    seen.add(real);
    let names: string[];
    try {
      names = fs.readdirSync(dir, { encoding: "utf-8" });
    } catch {
      continue; // 单目录不可读不中断整体扫描
    }
    for (const name of names) {
      const abs = path.join(dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs); // follow 符号链接
      } catch {
        continue; // 坏链跳过
      }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        out.push(path.relative(root, abs).split(path.sep).join("/"));
      }
    }
  }
  return out;
}

function metaFor(abs: string, relPosix: string): MaterialMeta {
  const stat = fs.statSync(abs);
  return {
    id: encodeMaterialId(relPosix),
    path: relPosix,
    type: inferType(relPosix),
    size: stat.size,
    updated_at: stat.mtime.toISOString(),
  };
}

/** 运行时目录不作为材料列举/检索（agent 状态与依赖，不是用户内容；ISSUE-118 实证 .pi 曾长进资产区） */
export function isRuntimeRelPath(relPosix: string): boolean {
  return (
    relPosix.startsWith(".pi/") ||
    relPosix.includes("/.pi/") ||
    relPosix.startsWith("node_modules/") ||
    relPosix.includes("/node_modules/") ||
    relPosix.startsWith(".git/") ||
    relPosix.includes("/.git/")
  );
}

/**
 * 材料 = 现场双根 walk（无索引可漂移）。同相对路径新根覆盖旧根。
 * 运行时目录（.pi/node_modules/.git）不进清单。
 * db 参数保留（历史签名兼容；索引表已删，不再读写）。
 */
export function listMaterialsMeta(
  dataDir: string,
  parentId: string,
  _db?: DatabaseSync
): MaterialMeta[] {
  const byPath = new Map<string, MaterialMeta>();
  for (const root of [legacyMaterialsRoot(dataDir, parentId), materialsRoot(dataDir, parentId)]) {
    if (!fs.existsSync(root)) continue;
    for (const posix of walkFilesRecursive(root)) {
      if (isRuntimeRelPath(posix)) continue;
      byPath.set(posix, metaFor(path.join(root, posix), posix));
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * 解析一个材料文件的物理绝对路径：新根优先，旧根兜底（存量不迁移）。
 * 文件不存在时返回新根路径（报错/写入都指向新根）。
 */
export function resolveMaterialFile(dataDir: string, parentId: string, relPosix: string): string {
  const rel = relPosix.replace(/^materials\//, "");
  const inNew = path.join(materialsRoot(dataDir, parentId), rel);
  if (fs.existsSync(inNew)) return inNew;
  const inLegacy = path.join(legacyMaterialsRoot(dataDir, parentId), rel);
  if (fs.existsSync(inLegacy)) return inLegacy;
  return inNew;
}

/**
 * 客户端索引比对（/materials/index）：updates = 与 client_index 不同的条目；
 * removed = client 有而服务端双根都无的 id。表没了，diff 现场算。
 */
export function diffMaterialIndex(
  dataDir: string,
  parentId: string,
  clientIndex: Record<string, string>
): { updates: MaterialMeta[]; removed: string[] } {
  const current = listMaterialsMeta(dataDir, parentId);
  const updates = current.filter((m) => clientIndex[m.id] !== m.updated_at);
  const known = new Set(current.map((m) => m.id));
  const removed = Object.keys(clientIndex).filter((id) => !known.has(id));
  return { updates, removed };
}

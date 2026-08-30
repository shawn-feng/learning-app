/**
 * 数据备份 / 恢复（ISSUE-003，SPLIT 服务端侧）。
 *
 * - GET  /api/v1/backup           → 把该家长的**服务端数据**（家长库 parent.sqlite
 *   + 每个孩子的 kb/<childId>.sqlite）打包成 zip 返回给客户端（客户端存到本地）。
 *   不含：账号/鉴权（server.sqlite）、模型 API key、登录凭证、材料大文件（可另行同步）。
 * - POST /api/v1/backup/restore   → 接收客户端上传的 zip，**恢复前先对服务端当前数据
 *   做一次自动备份**（pre-restore 快照 zip，存 data/backups/<parentId>/），
 *   再用 zip 内数据覆盖家长库与孩子 kb（仅允许 parent.sqlite 与归属本家长的孩子 kb）。
 *
 * zip 实现零外部依赖（与 electron/lib/backup.ts 同款：deflateRaw + 手写 ZIP 结构）。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { openKb } from "../db/kb.js";
import { openParentLib } from "../db/parent-lib.js";

// ================= 极简 ZIP（与客户端 backup.ts 同款，保持互认） =================

const ZIP_SIG_LOCAL = 0x04034b50;
const ZIP_SIG_CENTRAL = 0x02014b50;
const ZIP_SIG_EOCD = 0x06054b50;
const ZIP_METHOD_DEFLATE = 8;
const ZIP_UTF8_FLAG = 0x0800;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >>> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

interface ZipEntry {
  path: string;
  data: Buffer;
}

/** 内存打包 zip（家长数据量通常数 MB 内，可接受）。导出供测试。 */
export function zipPack(entries: ZipEntry[]): Buffer {
  const central: Buffer[] = [];
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.path, "utf-8");
    const compressed = zlib.deflateRawSync(e.data);
    const { time, date } = dosDateTime(new Date());
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(ZIP_SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);
    offset += 30 + name.length + compressed.length;

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(ZIP_SIG_CENTRAL, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    cen.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(compressed.length, 20);
    cen.writeUInt32LE(e.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset - (30 + name.length + compressed.length), 42);
    central.push(cen, name);
  }

  const cdStart = offset;
  const cdSize = central.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(ZIP_SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, ...central, eocd]);
}

/** 解包 zip（内存；恢复包通常几十 MB 内）。校验 CRC，防损坏静默恢复。导出供测试。 */
export function zipUnpack(buf: Buffer): ZipEntry[] {
  let eocdIdx = buf.length - 22;
  if (eocdIdx < 0 || buf.readUInt32LE(eocdIdx) !== ZIP_SIG_EOCD) {
    eocdIdx = -1;
    const scanStart = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= scanStart; i--) {
      if (buf.readUInt32LE(i) === ZIP_SIG_EOCD) {
        eocdIdx = i;
        break;
      }
    }
    if (eocdIdx < 0) throw new Error("无效的 zip 文件（找不到目录结尾）");
  }
  const count = buf.readUInt16LE(eocdIdx + 10);
  let cd = buf.readUInt32LE(eocdIdx + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(cd) !== ZIP_SIG_CENTRAL) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(cd + 10);
    const crc = buf.readUInt32LE(cd + 16);
    const csize = buf.readUInt32LE(cd + 20);
    const usize = buf.readUInt32LE(cd + 24);
    const nameLen = buf.readUInt16LE(cd + 28);
    const extraLen = buf.readUInt16LE(cd + 30);
    const commentLen = buf.readUInt16LE(cd + 32);
    const localOffset = buf.readUInt32LE(cd + 42);
    const name = buf.toString("utf-8", cd + 46, cd + 46 + nameLen);
    if (buf.readUInt32LE(localOffset) !== ZIP_SIG_LOCAL) throw new Error("zip 本地头损坏");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(dataStart, dataStart + csize);
    let raw: Buffer;
    if (method === 0) raw = Buffer.from(data);
    else if (method === 8) raw = zlib.inflateRawSync(data);
    else throw new Error(`不支持的压缩方式: ${method}`);
    if (raw.length !== usize) throw new Error(`zip 条目长度不符: ${name}`);
    if (crc32(raw) !== crc) throw new Error(`zip 校验失败: ${name}`);
    entries.push({ path: name, data: raw });
    cd += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ================= 备份范围（ISSUE-003：服务端用户数据） =================

interface BackupDeps {
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

/** 家长的孩子 id 列表（服务端主库）。 */
function childIdsOf(deps: BackupDeps, parentId: string): string[] {
  const rows = deps.db
    .prepare("SELECT id FROM children WHERE parent_id = ?")
    .all(parentId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** WAL 落盘后返回 sqlite 文件字节（一致性快照）。文件不存在返回 null。 */
function readSqliteFile(filePath: string): Buffer | null {
  if (!fs.existsSync(filePath)) return null;
  // 打开并 checkpoint，把 WAL 里未落盘的事务写回主文件，再读主文件（-wal/-shm 不入包）
  try {
    const db = new DatabaseSync(filePath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } catch {
    // 损坏/打不开：直接读主文件（尽力而为）
  }
  return fs.readFileSync(filePath);
}

/** 收集该家长的备份条目（家长库 + 每个孩子的 kb）。 */
function collectBackupEntries(deps: BackupDeps, parentId: string): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const parentLibPath = path.join(deps.config.dataDir, "parents", parentId, "parent.sqlite");
  const pl = readSqliteFile(parentLibPath);
  if (pl) entries.push({ path: "parent.sqlite", data: pl });

  for (const childId of childIdsOf(deps, parentId)) {
    const kbPath = path.join(deps.config.dataDir, "kb", parentId, `${childId}.sqlite`);
    const kb = readSqliteFile(kbPath);
    if (kb) entries.push({ path: `kb/${childId}.sqlite`, data: kb });
  }

  entries.unshift({
    path: "manifest.json",
    data: Buffer.from(
      JSON.stringify(
        {
          tool: "学习伙伴数据备份（服务端用户数据）",
          createdAt: new Date().toISOString(),
          fileCount: entries.length,
          note: "仅含家长库与孩子学习库（课程/进度/生活记录）；不含账号、模型 API key、登录凭证、材料大文件。",
        },
        null,
        2
      ),
      "utf-8"
    ),
  });
  return entries;
}

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 恢复路径校验：只允许 parent.sqlite 或本家长孩子的 kb/<childId>.sqlite；返回目标绝对路径。 */
function resolveRestoreTarget(deps: BackupDeps, parentId: string, entryPath: string): { target: string; label: string } | null {
  const p = entryPath.replace(/\\/g, "/");
  if (p === "manifest.json") return null;
  if (p === "parent.sqlite") {
    return { target: path.join(deps.config.dataDir, "parents", parentId, "parent.sqlite"), label: p };
  }
  const m = p.match(/^kb\/([0-9a-fA-F-]+)\.sqlite$/);
  if (m) {
    const childId = m[1];
    const owned = deps.db
      .prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?")
      .get(childId, parentId);
    if (!owned) return null; // 非本家长孩子：跳过（防越权覆盖他人数据）
    return { target: path.join(deps.config.dataDir, "kb", parentId, `${childId}.sqlite`), label: p };
  }
  return null;
}

export function registerBackupRoutes(app: FastifyInstance, deps: BackupDeps): void {
  // 下载备份：返回 zip 二进制（客户端保存到本地）
  app.get("/api/v1/backup", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const entries = collectBackupEntries(deps, parentId);
    const zip = zipPack(entries);
    const stamp = backupTimestamp();
    reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="backup-${stamp}.zip"`)
      .header("X-Backup-Count", String(entries.length))
      .send(zip);
  });

  // 恢复：multipart 上传 zip → 先自动备份当前数据 → 校验 → 覆盖
  app.post("/api/v1/backup/restore", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);

    // 1) 读上传文件（整个缓冲；备份包通常几十 MB 内）
    let zipBuf: Buffer | null = null;
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "file") {
        const chunks: Buffer[] = [];
        for await (const chunk of part.file) chunks.push(Buffer.from(chunk));
        zipBuf = Buffer.concat(chunks);
        break;
      }
    }
    if (!zipBuf) return reply.code(400).send({ error: "缺少备份文件" });

    // 2) 恢复前先对服务端当前数据做自动备份（防误覆盖，快照存服务端）
    const backupsDir = path.join(deps.config.dataDir, "backups", parentId);
    fs.mkdirSync(backupsDir, { recursive: true });
    const preRestorePath = path.join(backupsDir, `pre-restore-${backupTimestamp()}.zip`);
    try {
      const snapshot = zipPack(collectBackupEntries(deps, parentId));
      fs.writeFileSync(preRestorePath, snapshot);
    } catch (e) {
      return reply.code(500).send({ error: `恢复前自动备份失败，已中止恢复：${(e as Error).message}` });
    }

    // 3) 解包 + 校验 + 覆盖
    let entries: ZipEntry[];
    try {
      entries = zipUnpack(zipBuf);
    } catch (e) {
      return reply.code(400).send({ error: `备份文件无效：${(e as Error).message}` });
    }

    let restored = 0;
    const skipped: string[] = [];
    for (const e of entries) {
      const target = resolveRestoreTarget(deps, parentId, e.path);
      if (!target) {
        if (e.path !== "manifest.json") skipped.push(e.path);
        continue;
      }
      const { target: abs, label } = target;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.restore-${crypto.randomUUID()}.tmp`;
      fs.writeFileSync(tmp, e.data);
      fs.renameSync(tmp, abs);
      // 清理陈旧 WAL，强制下次打开时重建干净状态（避免旧 -wal 与新主文件错配）
      for (const suffix of ["-wal", "-shm"]) {
        fs.rmSync(`${abs}${suffix}`, { force: true });
      }
      restored++;
      void label;
    }
    return { ok: true, restored, skipped, preRestore: path.basename(preRestorePath) };
  });
}

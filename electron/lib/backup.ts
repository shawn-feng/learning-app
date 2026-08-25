/**
 * 本地备份 / 恢复（ISSUE-041 层 A）。
 *
 * - createBackup(destDir)：把 data/ 全量（按 denylist 过滤）打成 zip 到用户指定目录，
 *   含 manifest.json；profile.json 写入备份包时剥离 passwordHash（源文件不动）。
 * - restoreBackup(zipPath, {keepAuth})：解压回 data/，默认不覆盖 shared/auth.json / license.json
 *   （保护本机 API key 与订阅凭证）。
 *
 * zip 实现零外部依赖：用 Node 内置 zlib（deflateRaw / inflateRaw）+ 手写 ZIP 格式
 * （local header + central directory + EOCD），UTF-8 文件名（flag 0x0800），
 * 兼容 7-Zip / Windows 资源管理器 / Python zipfile。
 */
import fs from "fs";
import path from "path";
import os from "os";
import zlib from "zlib";
import { getDataDir } from "./config";

// ================= 极简 ZIP（无外部依赖） =================

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

export interface ZipEntry {
  /** posix 相对路径（UTF-8） */
  path: string;
  data: Buffer;
}

/** 流式写 zip：逐条写入 local header + deflate 数据，末尾补 central directory + EOCD。 */
async function writeZipToFile(
  entries: AsyncIterable<ZipEntry>,
  destPath: string
): Promise<{ count: number }> {
  const fh = await fs.promises.open(destPath, "w");
  const central: Buffer[] = [];
  let offset = 0;
  let count = 0;
  try {
    for await (const e of entries) {
      const name = Buffer.from(e.path, "utf-8");
      const compressed = zlib.deflateRawSync(e.data);
      const { time, date } = dosDateTime(new Date());
      const crc = crc32(e.data);
      const localHeaderOffset = offset;

      const local = Buffer.alloc(30);
      local.writeUInt32LE(ZIP_SIG_LOCAL, 0);
      local.writeUInt16LE(20, 4); // version needed
      local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
      local.writeUInt16LE(ZIP_METHOD_DEFLATE, 8);
      local.writeUInt16LE(time, 10);
      local.writeUInt16LE(date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(e.data.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28); // extra len
      await fh.write(local);
      await fh.write(name);
      await fh.write(compressed);
      offset += 30 + name.length + compressed.length;

      const cen = Buffer.alloc(46);
      cen.writeUInt32LE(ZIP_SIG_CENTRAL, 0);
      cen.writeUInt16LE(20, 4); // version made by
      cen.writeUInt16LE(20, 6); // version needed
      cen.writeUInt16LE(ZIP_UTF8_FLAG, 8);
      cen.writeUInt16LE(ZIP_METHOD_DEFLATE, 10);
      cen.writeUInt16LE(time, 12);
      cen.writeUInt16LE(date, 14);
      cen.writeUInt32LE(crc, 16);
      cen.writeUInt32LE(compressed.length, 20);
      cen.writeUInt32LE(e.data.length, 24);
      cen.writeUInt16LE(name.length, 28);
      cen.writeUInt16LE(0, 30); // extra
      cen.writeUInt16LE(0, 32); // comment
      cen.writeUInt16LE(0, 34); // disk
      cen.writeUInt16LE(0, 36); // internal attrs
      cen.writeUInt32LE(0, 38); // external attrs
      cen.writeUInt32LE(localHeaderOffset, 42);
      central.push(cen, name);
      count++;
    }

    const cdStart = offset;
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(ZIP_SIG_EOCD, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    await fh.write(Buffer.concat(central));
    await fh.write(eocd);
  } finally {
    await fh.close();
  }
  return { count };
}

/** 解包 zip（内存读取；备份包一般几十 MB 内，可接受）。校验 CRC，防损坏静默恢复。 */
export function zipUnpack(buf: Buffer): ZipEntry[] {  // EOCD：本工具产出的 zip 无注释，尾部 22 字节即 EOCD；外部工具可能带注释，
  // 回退为从尾部最多 64KB 内反向找签名。
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

/** 内存打包 zip（测试 / 小文件用）：走临时文件路径再读回 Buffer。 */
export async function zipPack(entries: ZipEntry[]): Promise<Buffer> {
  const tmp = path.join(
    os.tmpdir(),
    `pi-zip-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`
  );
  try {
    await writeZipToFile(
      (async function* () {
        for (const e of entries) yield e;
      })(),
      tmp
    );
    return await fs.promises.readFile(tmp);
  } finally {
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

// ================= 备份范围（ISSUE-041 清单） =================
// 排除：模型 API key、登录/订阅凭证、调度内部状态、agent 会话 jsonl、历史备份包、临时 baks。
/** 相对路径级排除（相对 data/，posix 分隔）。 */
export const BACKUP_DENY_REL = ["shared/auth.json", "license.json", "task-state.json"];

/** 目录名级排除（任意层级出现即跳过）：agent 会话等内部状态。 */
export const BACKUP_DENY_DIRS = new Set([".pi"]);

const DENY_NAME_PATTERN = /\.bak-|\.bak-dedup$/;
const BACKUP_FILE_PATTERN = /^backup-\d{8}-\d{6}\.zip$/;

export function isBackupExcluded(relPath: string): boolean {
  const p = relPath.replace(/\\/g, "/");
  if (BACKUP_DENY_REL.includes(p)) return true;
  const segments = p.split("/");
  for (const seg of segments) {
    if (seg === ".pi") return true;
  }
  const base = segments[segments.length - 1] || "";
  if (DENY_NAME_PATTERN.test(base)) return true;
  if (BACKUP_FILE_PATTERN.test(base)) return true;
  return false;
}

/** 写入备份包时脱敏：children/<id>/profile.json 剥离 passwordHash（源文件不动）。 */
function sanitizeForBackup(rel: string, data: Buffer): Buffer {
  if (rel.startsWith("children/") && rel.endsWith("/profile.json")) {
    try {
      const obj = JSON.parse(data.toString("utf-8"));
      if (obj && typeof obj === "object" && "passwordHash" in obj) {
        delete obj.passwordHash;
        return Buffer.from(JSON.stringify(obj, null, 2), "utf-8");
      }
    } catch {
      /* 解析失败保持原样（不该发生，防御性处理） */
    }
  }
  return data;
}

/** 递归扫描 data/，返回应纳入备份的文件（异步 + 定时让出事件循环，见 ISSUE-011）。 */
async function scanBackupFiles(): Promise<Array<{ rel: string; abs: string }>> {
  const root = getDataDir();
  const results: Array<{ rel: string; abs: string }> = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在/不可读：整目录跳过
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".pi") continue;
        await walk(full);
      } else {
        const rel = path.relative(root, full).replace(/\\/g, "/");
        if (isBackupExcluded(rel)) continue;
        results.push({ rel, abs: full });
      }
      if (results.length % 20 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }
  }
  await walk(root);
  return results;
}

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface BackupResult {
  file: string;
  count: number;
  bytes: number;
}

/** 创建备份：data/ 全量（denylist 过滤 + profile 脱敏）→ zip 到 destDir。 */
export async function createBackup(destDir: string): Promise<BackupResult> {
  await fs.promises.mkdir(destDir, { recursive: true });
  const stamp = backupTimestamp();
  const finalPath = path.join(destDir, `backup-${stamp}.zip`);
  const tmpPath = path.join(destDir, `.backup-${stamp}.tmp`);

  // 先扫描定文件清单，再写 zip —— 避免 tmp 文件/新备份被扫进自身
  const files = await scanBackupFiles();
  let totalBytes = 0;

  async function* entries(): AsyncGenerator<ZipEntry> {
    const manifest = {
      tool: "学习伙伴备份",
      createdAt: new Date().toISOString(),
      fileCount: files.length,
      excludedNote:
        "不含：模型 API key、登录/订阅凭证、孩子密码哈希、agent 会话历史(.pi)、调度内部状态、临时备份",
    };
    yield { path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf-8") };
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const data = sanitizeForBackup(f.rel, await fs.promises.readFile(f.abs));
      totalBytes += data.length;
      yield { path: f.rel, data };
      if (i % 20 === 0) await new Promise<void>((r) => setImmediate(r));
    }
  }

  try {
    const { count } = await writeZipToFile(entries(), tmpPath);
    await fs.promises.rename(tmpPath, finalPath);
    return { file: finalPath, count, bytes: totalBytes };
  } catch (e) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
}

export interface RestoreResult {
  restored: number;
  skipped: string[];
}

/** 恢复路径白名单：拒绝绝对路径 / 目录穿越 / .pi。 */
function sanitizeRelPath(p: string): string | null {
  const norm = p.replace(/\\/g, "/");
  if (path.isAbsolute(norm)) return null;
  const parts = norm.split("/");
  if (parts.some((s) => s === ".." || s === ".")) return null;
  if (parts.includes(".pi")) return null;
  return norm;
}

/** 从备份 zip 恢复使用数据；默认保护本机 auth.json / license.json（keepAuth）。 */
export async function restoreBackup(
  zipPath: string,
  opts: { keepAuth?: boolean } = {}
): Promise<RestoreResult> {
  const { keepAuth = true } = opts;
  const buf = await fs.promises.readFile(zipPath);
  const entries = zipUnpack(buf);
  const root = getDataDir();
  const skipped: string[] = [];
  let restored = 0;

  for (const e of entries) {
    if (e.path === "manifest.json") continue;
    const safe = sanitizeRelPath(e.path);
    if (!safe) {
      skipped.push(e.path);
      continue;
    }
    const abs = path.join(root, safe);
    const relRoot = path.relative(root, abs);
    if (relRoot.startsWith("..") || path.isAbsolute(relRoot)) {
      skipped.push(e.path);
      continue;
    }
    if (keepAuth && (safe === "shared/auth.json" || safe === "license.json")) {
      skipped.push(safe);
      continue;
    }
    await fs.promises.mkdir(path.dirname(abs), { recursive: true });
    await fs.promises.writeFile(abs, e.data);
    restored++;
  }
  return { restored, skipped };
}

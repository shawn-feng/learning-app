/**
 * 学习主题打包导出 / 导入（2026-09-25 方案：docs/主题打包导入导出-设计方案-2026-09-25.md）。
 *
 * - GET  /api/v1/parent-lib/export-topic/:topicKey/preview → 导出预览（主题信息/内容计数/资料文件清单）
 * - POST /api/v1/parent-lib/export-topic                   → 生成 .ltpkg（zip）二进制返回
 * - POST /api/v1/parent-lib/import-topic                   → 上传 .ltpkg（multipart）导入，返回报告
 *
 * 包内容：家长库 topics 行 + courses 行 + 考核三表（question_bank / knowledge_points /
 * course_knowledge_questions，按 courses.uuid 挂靠）必含；materials <topicKey>/ 前缀下资料文件
 * 可选勾选（**默认不打包**，逐文件/按类型勾选由客户端对话框完成）。
 * 不进包：孩子库一切（分配/进度/掌握）、topics.method_spec（按孩子区分，导入端走考核设置生成）、
 * 知识库条目、tags 定义。
 *
 * zip 复用 backup.ts 的零依赖 zipPack/zipUnpack。uuid 原样保留：跨库天然不撞（碰撞则重生成并
 * 重映射），同包重复导入 = 幂等刷新（同名且同 topic_key → INSERT OR REPLACE/IGNORE）。
 * 导入遇「同名但不同 topic_key」→ 自动重命名（name 加 " (2)"、topic_key 加 "-2"），课程归属、
 * html_path / material 指针、落盘目录四处前缀同步改写。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ServerConfig } from "../config.js";
import { ApiError } from "../auth/proxy.js";
import { verifySession } from "../auth/jwt.js";
import { zipPack, zipUnpack } from "./backup.js";
import { openParentLib } from "../db/parent-lib.js";
import { listMaterialsMeta, materialsRoot, resolveMaterialFile, type MaterialMeta } from "../db/materials.js";
import { SERVER_VERSION } from "./version.js";

export const TOPIC_PACKAGE_KIND = "learning-topic-package";
export const TOPIC_PACKAGE_SCHEMA_VERSION = 1;
// 体积上限已按用户要求取消（2026-09-26）：千字文级别（30 段视频 ≈370MB）也允许整包导出导入；
// zip 打包/解包均为内存操作，超大数据包的流式优化留待实际遇到瓶颈再做。

interface PackageCourse {
  uuid: string;
  title: string;
  sort_order: number;
  material: string;
  send_material: string;
  tags: string;
  lesson_method: string;
  html_path: string;
  teaching_copy: string;
  assess_rubric: string;
}

export interface TopicPackageManifest {
  kind: string;
  schema_version: number;
  created_at: string;
  source: { server_version: string };
  topic: {
    name: string;
    topic_key: string;
    method: string;
    assess_method: string;
    progress: string;
    rules_json: string;
  };
  courses: PackageCourse[];
  question_bank: Array<{
    id: string;
    stem: string;
    answer: string;
    scoring: string | null;
    point_max: number;
    behavior: string;
    note: string;
    knowledge_summary: string;
    options: string;
  }>;
  knowledge_points: Array<{ id: string; course_uuid: string; name: string; detail: string; seq: number }>;
  course_knowledge_questions: Array<{
    course_id: string;
    knowledge_point_id: string;
    question_id: string;
    seq: number;
    overview: string | null;
  }>;
  files: Array<{ path: string; size: number; sha256: string }>;
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

function placeholders(n: number): string {
  return n === 0 ? "''" : Array(n).fill("?").join(",");
}

// ==================== 导出：收集 + 打包 ====================

/** 读主题行（按 topic_key 解析，PK 是 name 所以可能多行——取第一个，与 buildAllocPackage 同策略）。 */
function topicRowByKey(db: DatabaseSync, topicKey: string):
  | { name: string; topic_key: string; method: string; assess_method: string; progress: string; rules_json: string }
  | undefined {
  return db
    .prepare(
      "SELECT name, topic_key, method, assess_method, progress, rules_json FROM topics WHERE topic_key = ? ORDER BY name LIMIT 1"
    )
    .get(topicKey) as TopicPackageManifest["topic"] | undefined;
}

function coursesOfTopic(db: DatabaseSync, topicKey: string): PackageCourse[] {
  return db
    .prepare(
      `SELECT uuid, title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric
       FROM courses WHERE topic = ? ORDER BY sort_order, title`
    )
    .all(topicKey) as unknown as PackageCourse[];
}

/** 主题的资料文件清单（双根合并后的 <topicKey>/ 前缀文件，运行时目录已被 listMaterialsMeta 排除）。 */
export function topicFileList(dataDir: string, parentId: string, topicKey: string): MaterialMeta[] {
  const prefix = `${topicKey}/`;
  return listMaterialsMeta(dataDir, parentId).filter((m) => m.path.startsWith(prefix));
}

/** 导出预览：主题信息 + 内容计数 + 文件清单（含每文件被本主题课程引用次数）。 */
export function previewTopicExport(dataDir: string, parentId: string, topicKey: string) {
  const db = openParentLib(dataDir, parentId);
  try {
    const topic = topicRowByKey(db, topicKey);
    if (!topic) throw new ApiError(404, `家长库中未找到主题 ${topicKey}`);
    const courses = coursesOfTopic(db, topicKey);
    const courseUuids = courses.map((c) => String(c.uuid || ""));
    const kpCount =
      courseUuids.length === 0
        ? 0
        : (
            db.prepare(`SELECT COUNT(*) AS c FROM knowledge_points WHERE course_uuid IN (${placeholders(courseUuids.length)})`).get(...courseUuids) as { c: number }
          ).c;
    const qCount =
      courseUuids.length === 0
        ? 0
        : (
            db
              .prepare(
                `SELECT COUNT(DISTINCT q.id) AS c FROM question_bank q
                 JOIN course_knowledge_questions ck ON ck.question_id = q.id
                 WHERE ck.course_id IN (${placeholders(courseUuids.length)})`
              )
              .get(...courseUuids) as { c: number }
          ).c;
    // 引用计数对全部课程算（其他主题的课程也可能引用本主题目录下的文件）
    const refCount = new Map<string, number>();
    for (const c of db.prepare("SELECT material, html_path FROM courses").all() as Array<{ material: string; html_path: string }>) {
      for (const v of [c.material, c.html_path]) {
        const s = String(v || "");
        if (s) refCount.set(s, (refCount.get(s) || 0) + 1);
      }
    }
    const files = topicFileList(dataDir, parentId, topicKey).map((f) => ({
      path: f.path,
      type: f.type,
      size: f.size,
      refCount: refCount.get(f.path) || 0,
    }));
    return {
      topic: { name: topic.name, topicKey: topic.topic_key },
      counts: { courses: courses.length, knowledgePoints: kpCount, questions: qCount },
      files,
    };
  } finally {
    db.close();
  }
}

/** 收集一个主题的完整包（manifest + 选中文件内容）。files 为空 = 纯数据包。 */
export function collectTopicPackage(
  dataDir: string,
  parentId: string,
  topicKey: string,
  files: string[]
): { manifest: TopicPackageManifest; fileData: Map<string, Buffer> } {
  const db = openParentLib(dataDir, parentId);
  let manifest: TopicPackageManifest;
  try {
    const topic = topicRowByKey(db, topicKey);
    if (!topic) throw new ApiError(404, `家长库中未找到主题 ${topicKey}`);
    const courses = coursesOfTopic(db, topicKey);
    const courseUuids = courses.map((c) => String(c.uuid || ""));

    const kps =
      courseUuids.length === 0
        ? []
        : (db
            .prepare(`SELECT id, course_uuid, name, detail, seq FROM knowledge_points WHERE course_uuid IN (${placeholders(courseUuids.length)}) ORDER BY course_uuid, seq`)
            .all(...courseUuids) as TopicPackageManifest["knowledge_points"]);
    const ckq =
      courseUuids.length === 0
        ? []
        : (db
            .prepare(
              `SELECT course_id, knowledge_point_id, question_id, seq, overview FROM course_knowledge_questions WHERE course_id IN (${placeholders(courseUuids.length)}) ORDER BY course_id, knowledge_point_id, seq`
            )
            .all(...courseUuids) as TopicPackageManifest["course_knowledge_questions"]);
    const questionIds = [...new Set(ckq.map((r) => String(r.question_id)))];
    const questions =
      questionIds.length === 0
        ? []
        : (db
            .prepare(
              `SELECT id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options FROM question_bank WHERE id IN (${placeholders(questionIds.length)})`
            )
            .all(...questionIds) as TopicPackageManifest["question_bank"]);

    manifest = {
      kind: TOPIC_PACKAGE_KIND,
      schema_version: TOPIC_PACKAGE_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      source: { server_version: SERVER_VERSION },
      topic,
      courses,
      question_bank: questions,
      knowledge_points: kps,
      course_knowledge_questions: ckq,
      files: [],
    };
  } finally {
    db.close();
  }

  // 文件读取在关库之后（纯文件系统操作）；勾选路径必须真实存在，防客户端乱指
  const available = new Set(topicFileList(dataDir, parentId, topicKey).map((f) => f.path));
  const wanted = [...new Set((files || []).map((f) => String(f)))];
  const unknown = wanted.filter((f) => !available.has(f));
  if (unknown.length) throw new ApiError(400, `勾选的资料文件不存在：${unknown[0]}`);
  const fileData = new Map<string, Buffer>();
  let total = 0;
  for (const rel of wanted) {
    const abs = resolveMaterialFile(dataDir, parentId, rel);
    const buf = fs.readFileSync(abs);
    total += buf.length;
    fileData.set(rel, buf);
  }
  void total;
  manifest.files = [...fileData.entries()].map(([p, buf]) => ({
    path: p,
    size: buf.length,
    sha256: crypto.createHash("sha256").update(buf).digest("hex"),
  }));
  return { manifest, fileData };
}

/** 打包成 .ltpkg（zip）：manifest.json + files/<相对路径>。 */
export function buildTopicPackageZip(manifest: TopicPackageManifest, fileData: Map<string, Buffer>): Buffer {
  const entries = [{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf-8") }];
  for (const [p, buf] of fileData) entries.push({ path: `files/${p}`, data: buf });
  return zipPack(entries);
}

// ==================== 导入：校验 + 冲突改写 + 落库 ====================

export interface ImportReport {
  ok: true;
  topic: { name: string; topicKey: string };
  /** true = 同名不同 key，自动重命名导入 */
  renamed: boolean;
  /** true = 同名同 key 的已有主题被刷新（幂等重导） */
  refreshed: boolean;
  courses: number;
  knowledge_points: number;
  questions: number;
  files: number;
  /** 课程引用了但未随包的资料清单（默认不带文件导出时必有内容） */
  missing_files: string[];
  warnings: string[];
}

/** manifest 解析与校验；不合法直接抛错（消息给用户看）。 */
export function parseManifest(raw: string): TopicPackageManifest {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "包内 manifest.json 不是合法 JSON");
  }
  const m = obj as Partial<TopicPackageManifest> | null;
  if (!m || typeof m !== "object") throw new ApiError(400, "包内缺少 manifest.json");
  if (m.kind !== TOPIC_PACKAGE_KIND) throw new ApiError(400, "这不是学习主题包（kind 不符）");
  if (Number(m.schema_version) > TOPIC_PACKAGE_SCHEMA_VERSION) {
    throw new ApiError(400, `包格式版本过新（${m.schema_version}），请先升级学习伙伴再导入`);
  }
  const t = m.topic as TopicPackageManifest["topic"] | undefined;
  if (!t || typeof t.name !== "string" || !t.name.trim() || typeof t.topic_key !== "string" || !t.topic_key.trim()) {
    throw new ApiError(400, "包内 manifest 缺少主题信息（name/topic_key）");
  }
  for (const key of ["courses", "question_bank", "knowledge_points", "course_knowledge_questions", "files"] as const) {
    if (!Array.isArray(m[key])) throw new ApiError(400, `包内 manifest 缺少 ${key} 字段`);
  }
  return m as TopicPackageManifest;
}

/** zip 条目里的 files/ 相对路径安全校验：posix、无 ..、无绝对路径/盘符，且必须落在包主题目录内。返回 null = 非 files/ 条目。 */
export function safePackageFilePath(entryPath: string, topicKey: string): string | null {
  if (!entryPath.startsWith("files/")) return null;
  const rel = entryPath.slice("files/".length);
  if (!rel || rel.includes("\\") || rel.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(rel)) return null;
  const norm = path.posix.normalize(rel);
  if (norm.startsWith("..") || norm.includes("/../") || norm.split("/").some((seg) => seg === ".." || seg === "")) return null;
  if (!norm.startsWith(`${topicKey}/`)) return null;
  return norm;
}

/** 目标身份裁决：新主题 / 同名同 key 幂等刷新 / 同名不同 key 自动重命名。 */
export function resolveImportIdentity(
  db: DatabaseSync,
  pkgName: string,
  pkgKey: string
): { name: string; topicKey: string; renamed: boolean; refreshed: boolean } {
  const existing = db.prepare("SELECT topic_key FROM topics WHERE name = ?").get(pkgName) as
    | { topic_key: string }
    | undefined;
  if (!existing) return { name: pkgName, topicKey: pkgKey, renamed: false, refreshed: false };
  if (existing.topic_key === pkgKey) return { name: pkgName, topicKey: pkgKey, renamed: false, refreshed: true };
  // 同名不同源：找一个 name/topic_key/课程目录都空的后缀
  const identityTaken = (n: string, k: string) =>
    !!db.prepare("SELECT 1 FROM topics WHERE name = ? OR topic_key = ?").get(n, k) ||
    !!db.prepare("SELECT 1 FROM courses WHERE topic = ?").get(k);
  for (let i = 2; ; i++) {
    const n = `${pkgName} (${i})`;
    const k = `${pkgKey}-${i}`;
    if (!identityTaken(n, k)) return { name: n, topicKey: k, renamed: true, refreshed: false };
  }
}

/** 指针前缀改写：值等于旧 key 或以 旧key/ 开头 → 换成新 key 前缀。 */
export function rewriteTopicRef(value: string, oldKey: string, newKey: string): string {
  const v = String(value || "");
  if (v === oldKey) return newKey;
  if (v.startsWith(`${oldKey}/`)) return newKey + v.slice(oldKey.length);
  return v;
}

/**
 * 应用一个已解包的主题包：写家长库（单事务）→ 落资料文件。
 * zip 条目以 manifest.files 为白名单（路径 + sha256），额外/篡改条目忽略或报警。
 */
export function applyTopicImport(
  dataDir: string,
  parentId: string,
  entries: Array<{ path: string; data: Buffer }>
): ImportReport {
  const manifestEntry = entries.find((e) => e.path === "manifest.json");
  if (!manifestEntry) throw new ApiError(400, "包内缺少 manifest.json");
  const manifest = parseManifest(manifestEntry.data.toString("utf-8"));
  const pkgKey = manifest.topic.topic_key;

  const warnings: string[] = [];
  const whitelisted = new Map(manifest.files.map((f) => [f.path, f]));
  const fileData = new Map<string, Buffer>();
  for (const e of entries) {
    const rel = safePackageFilePath(e.path, pkgKey);
    if (!rel) continue; // manifest.json 与白名单外条目一律忽略
    const meta = whitelisted.get(rel);
    if (!meta) {
      warnings.push(`已忽略包内未登记文件：${rel}`);
      continue;
    }
    if (meta.sha256 && crypto.createHash("sha256").update(e.data).digest("hex") !== meta.sha256) {
      throw new ApiError(400, `文件校验失败（sha256 不符）：${rel}`);
    }
    fileData.set(rel, e.data);
  }
  const missingPkg = [...whitelisted.keys()].filter((p) => !fileData.has(p));
  for (const p of missingPkg) warnings.push(`包清单登记了但包里缺失的文件：${p}`);

  const db = openParentLib(dataDir, parentId);
  try {
    const identity = resolveImportIdentity(db, manifest.topic.name, pkgKey);
    const oldKey = pkgKey;
    const newKey = identity.topicKey;
    const fix = (v: string) => rewriteTopicRef(v, oldKey, newKey);

    db.exec("BEGIN");
    try {
      db.prepare(
        `INSERT OR REPLACE INTO topics (name, topic_key, method, assess_method, progress, rules_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        identity.name,
        newKey,
        String(manifest.topic.method || ""),
        String(manifest.topic.assess_method || ""),
        String(manifest.topic.progress || ""),
        String(manifest.topic.rules_json || "{}")
      );

      const insertCourse = db.prepare(
        `INSERT OR REPLACE INTO courses (topic, title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric, uuid)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const c of manifest.courses) {
        let uuid = String(c.uuid || "");
        if (uuid) {
          // uuid 撞了别的主题的课程（跨库概率≈0，防御）：重生成并靠下方重映射保住考核挂靠
          const owner = db.prepare("SELECT topic FROM courses WHERE uuid = ? AND topic != ?").get(uuid, newKey);
          if (owner) {
            const remapFrom = uuid;
            uuid = crypto.randomUUID().replace(/-/g, "");
            db.prepare("UPDATE knowledge_points SET course_uuid = ? WHERE course_uuid = ?").run(uuid, remapFrom);
            db.prepare("UPDATE course_knowledge_questions SET course_id = ? WHERE course_id = ?").run(uuid, remapFrom);
            warnings.push(`课程「${c.title}」的 uuid 与现有课程冲突，已重新生成`);
          }
        } else {
          uuid = crypto.randomUUID().replace(/-/g, "");
        }
        insertCourse.run(
          newKey,
          String(c.title),
          Number(c.sort_order) || 0,
          fix(String(c.material || "")),
          String(c.send_material || ""),
          String(c.tags || ""),
          String(c.lesson_method || ""),
          fix(String(c.html_path || "")),
          String(c.teaching_copy || ""),
          String(c.assess_rubric || ""),
          uuid
        );
      }

      const insertQuestion = db.prepare(
        `INSERT OR IGNORE INTO question_bank (id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const q of manifest.question_bank) {
        insertQuestion.run(
          String(q.id),
          String(q.stem || ""),
          String(q.answer || ""),
          q.scoring == null ? null : String(q.scoring),
          Number(q.point_max) || 10,
          String(q.behavior || "generic"),
          String(q.note || ""),
          String(q.knowledge_summary || ""),
          String(q.options || "[]")
        );
      }

      const insertKp = db.prepare(
        `INSERT OR IGNORE INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, ?)`
      );
      for (const k of manifest.knowledge_points) {
        insertKp.run(String(k.id), String(k.course_uuid), String(k.name), String(k.detail || ""), Number(k.seq) || 0);
      }

      const insertCkq = db.prepare(
        `INSERT OR IGNORE INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)`
      );
      for (const r of manifest.course_knowledge_questions) {
        insertCkq.run(
          String(r.course_id),
          String(r.knowledge_point_id),
          String(r.question_id),
          Number(r.seq) || 0,
          r.overview == null ? null : String(r.overview)
        );
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    // 资料文件落盘（库提交后；失败不回滚库——等同「没带文件」的可兜底状态，进 warnings）
    const root = materialsRoot(dataDir, parentId);
    for (const [rel, buf] of fileData) {
      const target = path.join(root, rewriteTopicRef(rel, oldKey, newKey));
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
      } catch (err) {
        warnings.push(`资料写入失败：${rel}（${(err as Error).message}）`);
      }
    }

    // 缺资料清单：课程引用了但没随包（不判断目标端是否已有——引用真实性以包为准，目标端残留另算）
    const pkgFiles = new Set(whitelisted.keys());
    const missing = new Set<string>();
    for (const c of manifest.courses) {
      for (const field of ["material", "html_path"] as const) {
        const v = String(c[field] || "");
        if (v && !pkgFiles.has(v)) missing.add(`${c.title} → ${v}`);
      }
    }

    return {
      ok: true,
      topic: { name: identity.name, topicKey: newKey },
      renamed: identity.renamed,
      refreshed: identity.refreshed,
      courses: manifest.courses.length,
      knowledge_points: manifest.knowledge_points.length,
      questions: manifest.question_bank.length,
      files: fileData.size,
      missing_files: [...missing],
      warnings,
    };
  } finally {
    db.close();
  }
}

// ==================== 路由 ====================

export function registerTopicPackageRoutes(app: FastifyInstance, deps: { config: ServerConfig }): void {
  // 导出预览
  app.get("/api/v1/parent-lib/export-topic/:topicKey/preview", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const { topicKey } = req.params as { topicKey: string };
    return previewTopicExport(deps.config.dataDir, parentId, decodeURIComponent(topicKey));
  });

  // 导出：POST { topic_key, files } → .ltpkg zip 二进制
  app.post("/api/v1/parent-lib/export-topic", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
    const body = (req.body || {}) as { topic_key?: string; files?: string[] };
    const topicKey = String(body.topic_key || "").trim();
    if (!topicKey) return reply.code(400).send({ error: "缺少 topic_key" });
    const { manifest, fileData } = collectTopicPackage(deps.config.dataDir, parentId, topicKey, body.files || []);
    const zip = buildTopicPackageZip(manifest, fileData);
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    // header 文件名保持 ASCII 安全（真实文件名由客户端对话框决定）
    return reply
      .header("Content-Type", "application/zip")
      .header("Content-Disposition", `attachment; filename="topic-${topicKey}-${stamp}.ltpkg"`)
      .header("X-Topic-Files", String(fileData.size))
      .send(zip);
  });

  // 导入：multipart 上传 .ltpkg → 报告
  app.post("/api/v1/parent-lib/import-topic", async (req, reply) => {
    const parentId = authParent(req, deps.config.jwtSecret);
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
    if (!zipBuf) return reply.code(400).send({ error: "缺少主题包文件" });

    let parsed: Array<{ path: string; data: Buffer }>;
    try {
      parsed = zipUnpack(zipBuf);
    } catch (e) {
      return reply.code(400).send({ error: `主题包无效：${(e as Error).message}` });
    }
    return applyTopicImport(deps.config.dataDir, parentId, parsed);
  });
}

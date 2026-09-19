/**
 * 向量旁表 + 「精确匹配落空 → 向量检索兜底」（ISSUE-111）。
 *
 * 设计要点（见 issue 与设计讨论定案）：
 * - 向量存旁表 embeddings，业务表零 schema 变更；只对登记列（EMBEDDED_COLUMNS）生效；
 * - 余弦相似度 JS 内存计算（千行级 × 1024 维 float32 ≈ 数 MB）；不引入 sqlite-vec（一期否决）；
 * - embedding 服务由 **provider 内置声明**驱动（agent-core providers.ts 的 embedding 字段），
 *   自动解析家长已配 key 的厂商，用户零配置；无可用厂商 → 整体跳过（静默降级，零开销）；
 * - 写路径 markStale 入队异步嵌入，业务写入绝不因嵌入失败而失败；source_hash 判过期，
 *   未嵌完/嵌入失败的行不参与候选（宁缺毋滥）；
 * - 候选只提示不代入：「精确匹配无数据；以下为向量检索候选…请判断选哪一个，均不符则确认新建」。
 */
import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getProviderEmbedding, EMBEDDING_PROVIDER_PRIORITY, PROVIDER_REGISTRATIONS } from "@pi/agent-core";

// ==================== 登记列（只对登记列生效） ====================

export interface EmbeddedColumn {
  table: string;
  column: string;
  /** 主键列（row_pk 序列化顺序） */
  pkCols: string[];
}

export const EMBEDDED_COLUMNS: EmbeddedColumn[] = [
  { table: "courses", column: "title", pkCols: ["topic", "title"] },
  { table: "topics", column: "name", pkCols: ["name"] },
];

export function embeddedColumn(table: string, column?: string): EmbeddedColumn | undefined {
  return EMBEDDED_COLUMNS.find((e) => e.table === table && (!column || e.column === column));
}

/** 业务主键 → 旁表 row_pk（稳定序列化） */
export function serializePk(pkCols: string[], row: Record<string, unknown>): string {
  return JSON.stringify(pkCols.map((c) => row[c] ?? null));
}

// ==================== 旁表 ====================

export const EMBEDDINGS_DDL = `
CREATE TABLE IF NOT EXISTS embeddings (
  table_name TEXT NOT NULL,
  row_pk TEXT NOT NULL,
  column_name TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vector BLOB NOT NULL,
  source_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  PRIMARY KEY (table_name, row_pk, column_name)
);
`;

export function ensureEmbeddingsSchema(db: DatabaseSync): void {
  db.exec(EMBEDDINGS_DDL);
}

// ==================== provider 解析（零配置） ====================

export interface ResolvedEmbedding {
  provider: string;
  model: string;
  dimensions: number;
  endpoint: string;
  apiKey: string;
}

/** 按 EMBEDDING_PROVIDER_PRIORITY 找第一个「声明了 embedding 且家长配了 key」的 provider。 */
export function resolveEmbedding(auth: Record<string, unknown>): ResolvedEmbedding | null {
  for (const provider of EMBEDDING_PROVIDER_PRIORITY) {
    const cap = getProviderEmbedding(provider);
    if (!cap) continue;
    const key = (auth as Record<string, Record<string, unknown>>)?.[provider]?.key;
    if (!key || typeof key !== "string" || !key.trim()) continue;
    return { provider, model: cap.model, dimensions: cap.dimensions ?? 1024, endpoint: "", apiKey: key };
  }
  return null;
}

// ==================== 嵌入客户端（OpenAI 兼容 /embeddings） ====================

export class EmbedUnavailableError extends Error {}

const EMBED_TIMEOUT_MS = 30_000;
const EMBED_BATCH = 10;

/** endpoint = provider 注册表 baseUrl + /embeddings（OpenAI 兼容）。 */
function endpointFor(provider: string): string {
  const cfg = PROVIDER_REGISTRATIONS.find(([pid]) => pid === provider)?.[1];
  if (!cfg?.baseUrl) throw new EmbedUnavailableError(`provider ${provider} 无 baseUrl`);
  return `${cfg.baseUrl.replace(/\/$/, "")}/embeddings`;
}

/** 批量嵌入（自动按 10 条/次分块；30s 超时；失败重试 1 次）。 */
export async function embedTexts(resolved: ResolvedEmbedding, texts: string[]): Promise<Float32Array[]> {
  const endpoint = resolved.endpoint || endpointFor(resolved.provider);
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const chunk = texts.slice(i, i + EMBED_BATCH);
    const vecs = await embedChunk(resolved, endpoint, chunk);
    out.push(...vecs);
  }
  return out;
}

async function embedChunk(resolved: ResolvedEmbedding, endpoint: string, texts: string[]): Promise<Float32Array[]> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
    try {
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
        body: JSON.stringify({ model: resolved.model, input: texts, dimensions: resolved.dimensions }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        lastErr = new Error(`embedding HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        continue;
      }
      const json = (await r.json()) as { data?: Array<{ index: number; embedding: number[] }> };
      if (!json.data?.length) throw new Error("embedding 返回空 data");
      const sorted = [...json.data].sort((a, b) => a.index - b.index);
      return sorted.map((d) => Float32Array.from(d.embedding));
    } catch (e) {
      lastErr = e as Error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new EmbedUnavailableError(lastErr?.message ?? "embedding 调用失败");
}

// ==================== 向量数学 ====================

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const hashText = (text: string): string => crypto.createHash("sha256").update(text, "utf-8").digest("hex");
export const vectorToBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
export const blobToVector = (b: Buffer): Float32Array => new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));

// ==================== 读兜底 ====================

export interface EmbedContext {
  /** 主库（读 settings 用） */
  db: DatabaseSync;
  dataDir: string;
  parentId: string;
}

export interface VectorCandidate {
  /** 业务主键（{col: value}） */
  pk: Record<string, unknown>;
  text: string;
  score: number;
}

export type LookupResult =
  | { kind: "exact"; pk: Record<string, unknown>; text: string }
  | { kind: "candidates"; query: string; candidates: VectorCandidate[] }
  | { kind: "miss"; query: string };

export const VECTOR_TOP_K = 5;
export const VECTOR_DEFAULT_THRESHOLD = 0.6;

/** 向量缓存（键 = 稳定命名空间|表|列；嵌入写入后失效）。值 = row_pk → 向量。 */
const vectorCache = new Map<string, Map<string, Float32Array>>();

let dbSeq = 0;
/** 无 stableKey 时的兜底：句柄级标记（同一句柄内缓存有效；跨句柄不共享——调用方应传 stableKey）。 */
function handleKey(db: DatabaseSync): string {
  if (!(db as any).__embKey) (db as any).__embKey = `h${++dbSeq}`;
  return (db as any).__embKey;
}

/**
 * 载入某 (表,列) 的全部向量（内存缓存）。
 * stableKey：跨句柄的稳定命名空间（如 `pdb:<dataDir>|<parentId>`）——库句柄每次打开都是新的，
 * 句柄级键会让缓存永不命中、失效也失效（ISSUE-111 复盘）；给了 stableKey 的调用方必须用
 * 同一 stableKey 调 invalidateVectorCache。
 */
function loadVectors(db: DatabaseSync, table: string, column: string, stableKey?: string): Map<string, Float32Array> {
  const key = stableKey ? `${stableKey}|${table}|${column}` : `${handleKey(db)}|${table}|${column}`;
  let m = vectorCache.get(key);
  if (!m) {
    m = new Map<string, Float32Array>();
    const rows = db
      .prepare("SELECT row_pk, vector FROM embeddings WHERE table_name = ? AND column_name = ?")
      .all(table, column) as Array<{ row_pk: string; vector: Buffer }>;
    for (const r of rows) m.set(r.row_pk, blobToVector(r.vector));
    vectorCache.set(key, m);
  }
  return m;
}

/** 按稳定命名空间失效缓存（省略 table/column 时清该库全部列）。 */
export function invalidateVectorCache(stablePrefix: string, table?: string, column?: string): void {
  for (const key of [...vectorCache.keys()]) {
    if (!key.startsWith(`${stablePrefix}|`)) continue;
    if (table && column) {
      if (key === `${stablePrefix}|${table}|${column}`) vectorCache.delete(key);
    } else {
      vectorCache.delete(key);
    }
  }
}

/** 统一的稳定命名空间（家长库维度）。 */
export function parentLibCacheKey(dataDir: string, parentId: string): string {
  return `pdb:${dataDir}|${parentId}`;
}

/** 查业务表当前文本（按 pk）；行已删 → null。 */
function currentText(db: DatabaseSync, ec: EmbeddedColumn, rowPk: string): { pk: Record<string, unknown>; text: string } | null {
  let vals: Array<null | number | bigint | string>;
  try {
    vals = JSON.parse(rowPk) as Array<null | number | bigint | string>;
  } catch {
    return null;
  }
  const where = ec.pkCols.map((c) => `${c} = ?`).join(" AND ");
  const row = db.prepare(`SELECT ${ec.column} FROM ${ec.table} WHERE ${where}`).get(...vals) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  const pk: Record<string, unknown> = {};
  ec.pkCols.forEach((c, i) => (pk[c] = vals[i]));
  return { pk, text: String(row[ec.column] ?? "") };
}

/** 读当前设置的向量阈值（app_settings.embeddingThreshold，可调）。 */
export function vectorThreshold(appSettings?: Record<string, unknown>): number {
  const v = Number(appSettings?.embeddingThreshold);
  return Number.isFinite(v) && v > 0 && v < 1 ? v : VECTOR_DEFAULT_THRESHOLD;
}

/**
 * 核心兜底钩子：精确 = 命中 → 原样；0 行 → 向量 top-K；无可用 embedding → miss。
 * resolved 传 null = 功能关闭（调用方静默跳过）。
 */
export async function lookupWithFallback(
  db: DatabaseSync,
  resolved: ResolvedEmbedding | null,
  table: string,
  column: string,
  value: string,
  opts?: { topK?: number; threshold?: number; cacheKey?: string }
): Promise<LookupResult> {
  const ec = embeddedColumn(table, column);
  if (!ec) return { kind: "miss", query: value };
  // ① 精确 = 命中 → 原样返回（零额外开销）
  const row = db
    .prepare(`SELECT ${ec.pkCols.join(", ")}, ${ec.column} FROM ${ec.table} WHERE ${ec.column} = ? LIMIT 1`)
    .get(value) as Record<string, unknown> | undefined;
  if (row) {
    const pk: Record<string, unknown> = {};
    for (const c of ec.pkCols) pk[c] = row[c];
    return { kind: "exact", pk, text: String(row[ec.column] ?? "") };
  }
  // ② 无可用 embedding → 静默降级为现状行为
  if (!resolved) return { kind: "miss", query: value };
  // ③ 向量 top-K 候选
  try {
    const [qv] = await embedTexts(resolved, [value]);
    const vectors = loadVectors(db, table, column, opts?.cacheKey);
    const threshold = opts?.threshold ?? VECTOR_DEFAULT_THRESHOLD;
    const topK = opts?.topK ?? VECTOR_TOP_K;
    const scored: VectorCandidate[] = [];
    for (const [rowPk, vec] of vectors) {
      const score = cosine(qv, vec);
      if (score < threshold) continue;
      const cur = currentText(db, ec, rowPk);
      if (!cur) continue; // 行已删
      scored.push({ pk: cur.pk, text: cur.text, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return { kind: "candidates", query: value, candidates: scored.slice(0, topK) };
  } catch {
    // 嵌入服务失败 → 静默降级
    return { kind: "miss", query: value };
  }
}

/** 候选提示文案（用户指定契约：只提示不代入）。 */
export function formatCandidates(result: Extract<LookupResult, { kind: "candidates" }>): string {
  if (!result.candidates.length) {
    return `精确匹配无数据：「${result.query}」。也没有相近的候选（向量检索无达标项）——如需新建请与家长确认名称。`;
  }
  const lines = result.candidates.map((c, i) => `${i + 1}. ${c.text}（相似度 ${c.score.toFixed(3)}）`);
  return (
    `精确匹配无数据：「${result.query}」。\n` +
    `以下为向量检索候选（相似度降序），请判断选哪一个，均不符则与家长确认新建：\n${lines.join("\n")}`
  );
}

// ==================== 写路径：惰性嵌入 ====================

/** upsert 一条向量（写后失效缓存；stablePrefix 为该家长库的稳定命名空间）。 */
function upsertVector(db: DatabaseSync, ec: EmbeddedColumn, rowPk: string, model: string, vec: Float32Array, hash: string, stablePrefix: string): void {
  db.prepare(
    `INSERT INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(table_name, row_pk, column_name) DO UPDATE SET
       model = excluded.model, dim = excluded.dim, vector = excluded.vector,
       source_hash = excluded.source_hash, updated_at = datetime('now','localtime')`
  ).run(ec.table, rowPk, ec.column, model, vec.length, vectorToBlob(vec), hash);
  invalidateVectorCache(stablePrefix, ec.table, ec.column);
}

/** 判断写操作是否触及登记列（insert 的行键 / update 的 where 行存在即可 —— update 简化为行级失效）。 */
export function writeTouchesEmbedded(table: string, op: "insert" | "update" | "delete", rowKeys: string[]): EmbeddedColumn | undefined {
  const ec = EMBEDDED_COLUMNS.find((e) => e.table === table);
  if (!ec) return undefined;
  if (op === "delete") return ec;
  return rowKeys.includes(ec.column) ? ec : undefined;
}

const embedQueues = new Map<string, Promise<void>>();
const embedQueueItems = new Map<string, Array<{ table: string; pkVals: Array<null | number | bigint | string> }>>();

/** 写后标记待嵌入（fire-and-forget；同家长串行处理；失败留待 backfill，绝不抛出）。 */
export function markStale(ctx: EmbedContext, table: string, pkVals: Array<null | number | bigint | string>): void {
  if (!embeddedColumn(table)) return;
  const qKey = ctx.parentId;
  const list = embedQueueItems.get(qKey) ?? [];
  list.push({ table, pkVals });
  embedQueueItems.set(qKey, list);
  if (embedQueues.has(qKey)) return; // 已有处理循环在跑
  embedQueues.set(
    qKey,
    (async () => {
      try {
        let settings: { auth: Record<string, unknown> } | null = null;
        let resolved: ResolvedEmbedding | null = null;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const items = embedQueueItems.get(qKey) ?? [];
          if (!items.length) break;
          const job = items.shift()!;
          try {
            if (!settings) {
              const { readParentSettings } = await import("../worker/scheduler.js");
              settings = await readParentSettings(ctx.db, ctx.dataDir, ctx.parentId);
              resolved = resolveEmbedding(settings.auth);
            }
            if (!resolved) break; // 无可用 embedding → 清空队列，整体跳过
            // 打开该家长的库读当前文本（ctx.db 是主库；这里需要家长库）
            const { openParentLib } = await import("../db/parent-lib.js");
            const pdb = openParentLib(ctx.dataDir, ctx.parentId);
            try {
              const ec = embeddedColumn(job.table)!;
              const where = ec.pkCols.map((c) => `${c} = ?`).join(" AND ");
              const row = pdb.prepare(`SELECT ${ec.pkCols.join(", ")}, ${ec.column} FROM ${ec.table} WHERE ${where}`).get(...job.pkVals) as
                | Record<string, unknown>
                | undefined;
              if (!row) {
                // 行已删 → 删向量
                const rowPk = JSON.stringify(job.pkVals);
                pdb.prepare("DELETE FROM embeddings WHERE table_name = ? AND row_pk = ? AND column_name = ?").run(ec.table, rowPk, ec.column);
                invalidateVectorCache(parentLibCacheKey(ctx.dataDir, ctx.parentId), ec.table, ec.column);
                continue;
              }
              const text = String(row[ec.column] ?? "");
              const hash = hashText(text);
              const rowPk = JSON.stringify(ec.pkCols.map((c) => row[c]));
              const exist = pdb
                .prepare("SELECT source_hash, model FROM embeddings WHERE table_name = ? AND row_pk = ? AND column_name = ?")
                .get(ec.table, rowPk, ec.column) as { source_hash: string; model: string } | undefined;
              if (exist && exist.source_hash === hash && exist.model === resolved.model) continue; // 未变化
              const [vec] = await embedTexts(resolved, [text]);
              upsertVector(pdb, ec, rowPk, resolved.model, vec, hash, parentLibCacheKey(ctx.dataDir, ctx.parentId));
            } finally {
              pdb.close();
            }
          } catch (e) {
            console.warn(`[embeddings] 嵌入失败（留待 backfill）：${(e as Error).message}`);
          }
        }
      } finally {
        embedQueues.delete(qKey);
      }
    })()
  );
}

/**
 * 候选提示文本（工具层便捷入口）：内部读设置 → 解析 provider → 向量检索 → 格式化。
 * 任何一步不满足（未配 key / 未登记列 / 服务失败 / 精确命中）都返回 null —— 调用方静默跳过。
 */
export async function candidatesHintText(
  ctx: EmbedContext,
  table: string,
  value: unknown,
  opts?: { column?: string; topK?: number; threshold?: number }
): Promise<string | null> {
  try {
    const valueStr = String(value ?? "").trim();
    if (!valueStr) return null;
    const { readParentSettings } = await import("../worker/scheduler.js");
    const { openParentLib } = await import("../db/parent-lib.js");
    const settings = await readParentSettings(ctx.db, ctx.dataDir, ctx.parentId);
    const resolved = resolveEmbedding(settings.auth);
    if (!resolved) return null;
    const ec = embeddedColumn(table, opts?.column);
    if (!ec) return null;
    const pdb = openParentLib(ctx.dataDir, ctx.parentId);
    try {
      const r = await lookupWithFallback(pdb, resolved, table, ec.column, valueStr, {
        topK: opts?.topK,
        threshold: opts?.threshold ?? vectorThreshold(settings.appSettings),
      });
      if (r.kind !== "candidates") return null;
      return formatCandidates(r);
    } finally {
      pdb.close();
    }
  } catch {
    return null; // 任何异常 → 静默跳过（不阻断业务流）
  }
}

// ==================== 孩子侧跨库候选（kb_query 用，ISSUE-111 二期） ====================

/** 孩子已分配的 topic_key 集合。 */
function childAllocatedTopicKeys(kb: DatabaseSync): Set<string> {
  const rows = kb.prepare("SELECT topic_key FROM topics").all() as Array<{ topic_key: string }>;
  return new Set(rows.map((r) => r.topic_key).filter(Boolean));
}

/**
 * 课程名候选（跨库）：在**家长库** courses.title 向量里检索，候选按孩子视野过滤——
 * 主题必须在孩子已分配清单里、且孩子库真实存在这门课。向量数据不重复建（孩子库 ⊆ 家长库）。
 */
export function searchCourseCandidatesForChild(
  pdb: DatabaseSync,
  kb: DatabaseSync,
  queryVec: Float32Array,
  opts?: { topK?: number; threshold?: number; cacheKey?: string }
): VectorCandidate[] {
  const threshold = opts?.threshold ?? VECTOR_DEFAULT_THRESHOLD;
  const topK = opts?.topK ?? VECTOR_TOP_K;
  const allocated = childAllocatedTopicKeys(kb);
  const vectors = loadVectors(pdb, "courses", "title", opts?.cacheKey);
  const scored: Array<{ rowPk: string; score: number }> = [];
  for (const [rowPk, vec] of vectors) {
    const score = cosine(queryVec, vec);
    if (score >= threshold) scored.push({ rowPk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: VectorCandidate[] = [];
  for (const s of scored) {
    if (out.length >= topK) break;
    let vals: Array<null | number | bigint | string>;
    try {
      vals = JSON.parse(s.rowPk) as Array<null | number | bigint | string>;
    } catch {
      continue;
    }
    const topic = String(vals[0] ?? "");
    const title = String(vals[1] ?? "");
    if (!allocated.has(topic)) continue; // 孩子未分配该主题
    const exists = kb.prepare("SELECT 1 FROM courses WHERE topic = ? AND title = ?").get(topic, title);
    if (!exists) continue; // 孩子库没有这门课
    out.push({ pk: { topic, title }, text: title, score: s.score });
  }
  return out;
}

/** 主题名候选（跨库）：家长库 topics.name 向量检索，过滤到孩子已分配的主题。 */
export function searchTopicCandidatesForChild(
  pdb: DatabaseSync,
  kb: DatabaseSync,
  queryVec: Float32Array,
  opts?: { topK?: number; threshold?: number; cacheKey?: string }
): VectorCandidate[] {
  const threshold = opts?.threshold ?? VECTOR_DEFAULT_THRESHOLD;
  const topK = opts?.topK ?? VECTOR_TOP_K;
  const allocated = childAllocatedTopicKeys(kb);
  const vectors = loadVectors(pdb, "topics", "name", opts?.cacheKey);
  const scored: Array<{ rowPk: string; score: number }> = [];
  for (const [rowPk, vec] of vectors) {
    const score = cosine(queryVec, vec);
    if (score >= threshold) scored.push({ rowPk, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const out: VectorCandidate[] = [];
  for (const s of scored) {
    if (out.length >= topK) break;
    let vals: Array<null | number | bigint | string>;
    try {
      vals = JSON.parse(s.rowPk) as Array<null | number | bigint | string>;
    } catch {
      continue;
    }
    const name = String(vals[0] ?? "");
    const tKey = kb
      .prepare("SELECT topic_key FROM topics WHERE name = ? LIMIT 1")
      .get(name) as { topic_key?: string } | undefined;
    if (!tKey?.topic_key || !allocated.has(tKey.topic_key)) continue; // 孩子未分配
    out.push({ pk: { name, topic_key: tKey.topic_key }, text: `${name}（${tKey.topic_key}）`, score: s.score });
  }
  return out;
}

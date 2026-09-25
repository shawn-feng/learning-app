/**
 * 知识库条目真源（KB P1，2026-09-27）。
 *
 * ## 归属
 * 五张表全在 `parents/<parentId>/parent.sqlite`（**家长维度，一个家长一个库文件**）——
 * 与 `topics`/`courses` 一致，因此**表里没有 `parent_id` 列**。孩子库一行都不加；
 * 孩子只能通过 `kb_lookup` 一把工具看到这里。
 *
 * ## 与 ISSUE-131 P2「磁盘即真源」的关系
 * `kb_entry_assets.path` **只是一个字符串**，条目不承载"文件是否存在"——
 * 任何存在性判断都走 `resolveMaterialFile()`（新根优先、旧根兜底）。
 * 而 `summary`/`usage` 这些**磁盘上本来就不存在**，是家长新写的，
 * 所以这不是"又一个镜像表"（不变式：**索引缺行 ≠ 文件不存在**）。
 *
 * ## 派生的东西一律不存
 * 资产类型 = `f(扩展名)`（`inferType`）；时长 = 文件本身（`probeFfmpeg`）。
 * 曾设计又删掉的 `kb_entries.kind` / `kb_entry_assets.role` 与此同因，
 * 理由见 `docs/知识库-完整方案-2026-09-26.md` §3.3.5（**别再往回调**）。
 *
 * ## 两道门（都得过，别搞混）
 * - `status`：家长**审过没有**（`draft` → `published`）
 * - `visibility`：审过了**给不给这个孩子看**（`parent` / `child`）
 * ⇒ **`published` + `parent` 是合法且常见的状态**。
 * 门控一律在 SQL 里（`GATED_WHERE`），**绝不靠提示词**。
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encodeMaterialId, inferType, resolveMaterialFile } from "./materials.js";

// ==================== Schema ====================

export const KB_SCHEMA_TABLES = `
CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  usage TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'parent',
  share TEXT NOT NULL DEFAULT 'all',
  status TEXT NOT NULL DEFAULT 'draft',
  origin TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_kb_entries_lookup ON kb_entries(status, visibility, share);

CREATE TABLE IF NOT EXISTS kb_entry_assets (
  entry_id TEXT NOT NULL,
  path TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (entry_id, path)
);

CREATE TABLE IF NOT EXISTS kb_entry_links (
  entry_id TEXT NOT NULL, topic TEXT NOT NULL, course TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (entry_id, topic, course)
);
CREATE INDEX IF NOT EXISTS idx_kb_links_course ON kb_entry_links(topic, course);

CREATE TABLE IF NOT EXISTS kb_gaps (
  id TEXT PRIMARY KEY,
  child_id TEXT NOT NULL,
  question TEXT NOT NULL,
  hits_json TEXT NOT NULL DEFAULT '[]',
  high_risk INTEGER NOT NULL DEFAULT 0,
  count INTEGER NOT NULL DEFAULT 1,
  asked_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  entry_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_kb_gaps_open ON kb_gaps(child_id, status, asked_at);

-- 2026-09-27 家长决策：高风险词表**要可配置**（对话形式），不再是纯代码常量。
-- 表里存的是「家长可加减」那一层；代码里另有一份不可关的底线（KB_RISK_FLOOR，见下）。
CREATE TABLE IF NOT EXISTS kb_risk_terms (
  term TEXT PRIMARY KEY,
  note TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
);
`;

export function ensureKbEntriesSchema(db: DatabaseSync): void {
  db.exec(KB_SCHEMA_TABLES);
  seedRiskTerms(db);
}

// ==================== 高风险词表（两层：代码底线 + 家长可配置） ====================

/**
 * **不可关闭的底线**（家长在对话里也关不掉）。
 *
 * 为什么留这一层（而不是全交家长配置）：安全阀有一条"拆掉就没救"的性质——
 * 一旦「自杀」被关掉，孩子问到时的答案就只剩模型的自由发挥，而这类话题答错的代价
 * 是**不可逆**的。这与仓里既有的做法同源：`parent-skills.ts:76` 的「不可覆盖条款」
 * 与 `validateSkillOverride` 的红线关键词校验，都是「口径可改、红线来自代码」。
 *
 * 选取判据：**答错会造成安全/侵害风险**，而不是"家长与我意见不同"。
 * 「神/宗教/女娲/钱/离婚」那类属家庭口径，放在可配置层（`KB_RISK_SEED`）。
 */
export const KB_RISK_FLOOR: ReadonlyArray<{ term: string; why: string }> = [
  { term: "自杀", why: "自伤风险，必须由家长接住" },
  { term: "自残", why: "自伤风险" },
  { term: "死", why: "死亡/丧亲话题，答错的影响是长期的" },
  { term: "去世", why: "死亡/丧亲话题" },
  { term: "身体", why: "身体与性相关，适龄判断权在家长" },
  { term: "亲嘴", why: "性相关，适龄判断权在家长" },
  { term: "打我", why: "可能是被侵害的信号，必须让家长知道" },
  { term: "欺负", why: "可能是被侵害的信号，必须让家长知道" },
];

/**
 * **默认词表**（首次打开家长库时写进 `kb_risk_terms`，家长可以逐条关掉/删掉）。
 *
 * ⚠️ 「删掉」实现为 `enabled = 0`，**不 DELETE**：种子行靠 `INSERT OR IGNORE` 保证存在，
 * 真删了下次打开又会回来（家长会以为"删了没用"）；而 `enabled = 0` 是可逆的，
 * 家长改口说"这条也要"时 `add` 一下即可复原。
 */
export const KB_RISK_SEED: ReadonlyArray<{ term: string; note: string }> = [
  { term: "神", note: "信仰" },
  { term: "上帝", note: "信仰" },
  { term: "宗教", note: "信仰" },
  { term: "佛", note: "信仰" },
  { term: "菩萨", note: "信仰" },
  { term: "女娲", note: "创世/造人" },
  { term: "造人", note: "创世/造人" },
  { term: "从哪来", note: "生命起源" },
  { term: "结婚", note: "身体与关系" },
  { term: "生孩子", note: "身体与关系" },
  { term: "离婚", note: "家庭关系" },
  { term: "吵架", note: "家庭关系" },
  { term: "钱", note: "金钱观" },
  { term: "工资", note: "金钱观" },
  { term: "同学", note: "同伴关系" },
  { term: "好人坏人", note: "是非判断" },
  { term: "好坏", note: "是非判断" },
];

/**
 * 写种子行（幂等）。**只插不改**：家长已关掉的行（`enabled = 0`）不会被重新打开，
 * 家长自己加的说明（`note`）也不会被代码覆盖。
 */
function seedRiskTerms(db: DatabaseSync): void {
  const now = new Date().toISOString();
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO kb_risk_terms (term, note, enabled, origin, created_at, updated_at) VALUES (?, ?, 1, 'seed', ?, ?)"
  );
  for (const s of KB_RISK_SEED) stmt.run(s.term, s.note, now, now);
}

export interface RiskTermRow {
  term: string;
  note: string;
  enabled: boolean;
  origin: string;
  /** 底线词表中的词关不掉——列表里要说清楚 */
  floor?: boolean;
  floorWhy?: string;
}

/** 家长视角的风险词表：底线（不可关）在前，随后是家长可配置的那些。 */
export function listRiskTerms(db: DatabaseSync): RiskTermRow[] {
  const rows = db
    .prepare("SELECT term, note, enabled, origin FROM kb_risk_terms ORDER BY enabled DESC, term")
    .all() as Array<{ term: string; note: string; enabled: number; origin: string }>;
  return [
    ...KB_RISK_FLOOR.map((f) => ({ term: f.term, note: f.why, enabled: true, origin: "floor", floor: true, floorWhy: f.why })),
    ...rows.map((r) => ({ term: r.term, note: r.note, enabled: Number(r.enabled) === 1, origin: r.origin })),
  ];
}

export interface RiskTermChange {
  added: string[];
  /** 被关掉的（含原本就不在表里的：插入一行 enabled=0 作为"明确关掉"的记录） */
  removed: string[];
  /** 试图关掉底线词而被拒的 */
  rejected: Array<{ term: string; why: string }>;
}

/** 家长加/减风险词（对话式）。**底线词一律拒绝移除**，并如实回报原因。 */
export function updateRiskTerms(
  db: DatabaseSync,
  change: { add?: Array<{ term: string; note?: string }>; remove?: string[] }
): RiskTermChange {
  const now = new Date().toISOString();
  const out: RiskTermChange = { added: [], removed: [], rejected: [] };
  const upsert = db.prepare(
    `INSERT INTO kb_risk_terms (term, note, enabled, origin, created_at, updated_at) VALUES (?, ?, ?, 'parent', ?, ?)
     ON CONFLICT(term) DO UPDATE SET note = CASE WHEN excluded.note != '' THEN excluded.note ELSE kb_risk_terms.note END,
       enabled = excluded.enabled, origin = 'parent', updated_at = excluded.updated_at`
  );
  for (const a of change.add ?? []) {
    const term = String(a?.term ?? "").trim();
    if (!term) continue;
    upsert.run(term, String(a?.note ?? ""), 1, now, now);
    out.added.push(term);
  }
  for (const raw of change.remove ?? []) {
    const term = String(raw ?? "").trim();
    if (!term) continue;
    const floor = KB_RISK_FLOOR.find((f) => f.term === term);
    if (floor) {
      out.rejected.push({ term, why: floor.why });
      continue;
    }
    upsert.run(term, "", 0, now, now);
    out.removed.push(term);
  }
  return out;
}

/**
 * 高风险判定：**模型传的 high_risk 是主判据，关键词表是兜底**。
 *
 * 为什么保留关键词表：模型会漏（而且必然不全）。而**漏一次就是一次事故**——
 * 宁可比对多记一条 `kb_gaps` 让家长自己划掉，也不要让模型硬答一次。
 */
export function judgeHighRisk(
  db: DatabaseSync,
  query: string,
  explicit?: boolean
): { high: boolean; matched: string; source: "model" | "floor" | "configured" | "none" } {
  if (explicit === true) return { high: true, matched: "", source: "model" };
  const q = String(query ?? "");
  for (const f of KB_RISK_FLOOR) {
    if (q.includes(f.term)) return { high: true, matched: f.term, source: "floor" };
  }
  const rows = db.prepare("SELECT term FROM kb_risk_terms WHERE enabled = 1").all() as Array<{ term: string }>;
  for (const r of rows) {
    if (r.term && q.includes(r.term)) return { high: true, matched: r.term, source: "configured" };
  }
  return { high: false, matched: "", source: "none" };
}

// ==================== 条目读写 ====================

export interface KbEntryInput {
  id?: string;
  title: string;
  aliases?: string;
  summary?: string;
  tags?: string;
  usage?: string;
  share?: string;
  /**
   * **这段说法是谁拟的**（决定清单上标不标「这条是助手拟的」）。
   *
   * ⚠️ 缺省是 `"ai"`，**不是** `"manual"`——刻意的：把"助手拟的稿"误标成"家长原话"，
   * 会让一句其实没过家长脑子的文本冒充家长口径；反过来只是多标一句提示。
   * 工具描述与场景技能都要求：家长**一字一句给了原话**时才传 `"parent"`。
   */
  drafted_by?: "parent" | "ai";
}

export interface KbAssetInput {
  /** 挂到哪条条目上：给 `entry_id` 或 `entry_title` 之一（同一次调用里的条目可互相引用） */
  entry_id?: string;
  entry_title?: string;
  path: string;
  title?: string;
  seq?: number;
}

export interface KbSavedEntry {
  id: string;
  title: string;
  status: string;
  visibility: string;
  origin: string;
  created: boolean;
  /** 内容改了、已发布的条目被退回草稿（需要家长重新确认一次） */
  requalified: boolean;
  assetCount: number;
}

/** 只校验、不清理：相对路径、不含 `..`、不是绝对路径 */
function assertSafeRelPath(p: string): string {
  const raw = String(p ?? "").trim().replace(/\\/g, "/");
  if (!raw) throw new Error("资产 path 不能为空");
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new Error(`资产 path 必须是资料库相对路径：${raw}`);
  if (raw.split("/").includes("..")) throw new Error(`资产 path 不能含 ..：${raw}`);
  return raw.replace(/^\/+/, "").replace(/^materials\//, "");
}

function zhAssetKind(relPath: string): string {
  const t = inferType(relPath);
  if (t === "html") return "网页";
  if (t === "image") return "图片";
  if (t === "audio") return "音频";
  if (t === "video") return "视频";
  if (t === "text") return "文本";
  if (/\.pdf$/i.test(relPath)) return "PDF";
  return "文件";
}

export { zhAssetKind };

export function encodeAssetId(relPath: string): string {
  return encodeMaterialId(relPath);
}

/**
 * 落库（新建或按 `id`/`title` 更新）。
 *
 * **两条硬规则**（都在这里强制，不靠模型自觉）：
 * 1. 新建的行**恒为** `status = 'draft'` + `visibility = 'parent'`——草稿门 + 默认家长可见；
 * 2. `summary` 与资产**至少有一个非空**（更新时把"库里已有的资产"也算上）——
 *    存一条什么都没有的空条目没有意义，只会在清单里制造噪音。
 *
 * 挂资产前用 `resolveMaterialFile()` 校验文件**真实存在**，不存在当场报错（防挂空路径）。
 *
 * 还有一条**安全属性**：已发布条目的 `summary` 被改写时**退回 `draft`**。
 * 否则助手（或一次误操作）可以悄悄改掉一条正在生效的家长口径，孩子下一次问就拿到了新文本，
 * 而家长从未看过。`aliases`/`usage`/`tags` 的改动**不**退回（它们不改变孩子听到的话）。
 */
export function saveKbEntries(
  lib: DatabaseSync,
  dataDir: string,
  parentId: string,
  entries: KbEntryInput[],
  assets: KbAssetInput[] = []
): KbSavedEntry[] {
  const list = (entries ?? []).filter((e) => String(e?.title ?? "").trim());
  if (!list.length) throw new Error("parent_kb_save 需要至少一条 entries（每条要有 title）");

  const now = new Date().toISOString();
  const allAssets = (assets ?? []).filter((a) => String(a?.path ?? "").trim());
  // 先校验全部资产路径（含存在性），任何一条不合法就整批不写——避免"写了一半"
  const checkedAssets = allAssets.map((a) => {
    const rel = assertSafeRelPath(a.path);
    const abs = resolveMaterialFile(dataDir, parentId, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`资产文件不存在：${rel}（已在资料库新根与旧根都找过；先用 parent_list_materials 核对路径）`);
    }
    return { ...a, rel };
  });

  const saved: KbSavedEntry[] = [];
  const idByTitle = new Map<string, string>();

  const run = lib.prepare("SELECT * FROM kb_entries WHERE title = ? LIMIT 1");
  const runById = lib.prepare("SELECT * FROM kb_entries WHERE id = ? LIMIT 1");

  // ── 第一遍：写条目（先建，才能让后面的资产引用本次新建的 entry_title）──
  for (const e of list) {
    const title = String(e.title).trim();
    const summary = String(e.summary ?? "").trim();
    const existing = (e.id ? runById.get(e.id) : undefined) ?? run.get(title);
    const existingRow = existing as
      | { id: string; summary: string; status: string; visibility: string; origin: string }
      | undefined;
    const own = checkedAssets.filter(
      (a) => (a.entry_id && existingRow && a.entry_id === existingRow.id) || (a.entry_title && String(a.entry_title).trim() === title)
    );
    const legacyAssetCount = existingRow
      ? Number(
          (lib.prepare("SELECT COUNT(*) AS n FROM kb_entry_assets WHERE entry_id = ?").get(existingRow.id) as { n: number }).n
        )
      : 0;
    if (!summary && !own.length && !legacyAssetCount) {
      throw new Error(
        `条目「${title}」既没有 summary 也没有资料：至少要有一样（口径类写「可以这样跟她说」那段话；材料类挂一份文件）。`
      );
    }

    const origin = (e.drafted_by ?? "ai") === "parent" ? "manual" : "generated";
    const aliases = String(e.aliases ?? "").trim();
    const tags = String(e.tags ?? "").trim();
    const usage = String(e.usage ?? "").trim();
    const share = String(e.share ?? "").trim() || "all";

    if (!existingRow) {
      const id = String(e.id ?? "").trim() || randomUUID();
      lib.prepare(
        `INSERT INTO kb_entries (id, title, aliases, summary, body, tags, usage, visibility, share, status, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?, 'parent', ?, 'draft', ?, ?, ?)`
      ).run(id, title, aliases, summary, tags, usage, share, origin, now, now);
      idByTitle.set(title, id);
      saved.push({
        id, title, status: "draft", visibility: "parent", origin,
        created: true, requalified: false,
        assetCount: own.length,
      });
    } else {
      // 改写已发布条目的说法 → 退回草稿（见函数头注释：不许悄悄换掉正在生效的口径）
      const summaryChanged = summary !== String(existingRow.summary ?? "");
      const requalified = summaryChanged && existingRow.status === "published";
      // `origin` 描述的是**当前这段 `summary` 是谁写的**：说法没改就别动它
      // （否则只改 `usage` 也会把一条"家长原话"降级成"助手整理"，标签失真）
      const origin2 = summaryChanged
        ? origin
        : (String(existingRow.origin ?? "").trim() || origin);
      lib.prepare(
        `UPDATE kb_entries SET title = ?, aliases = ?, summary = ?, tags = ?, usage = ?, share = ?,
           origin = ?, status = ?, updated_at = ? WHERE id = ?`
      ).run(
        title, aliases, summary, tags, usage, share, origin2,
        requalified ? "draft" : existingRow.status, now, existingRow.id
      );
      idByTitle.set(title, existingRow.id);
      saved.push({
        id: existingRow.id, title,
        status: requalified ? "draft" : existingRow.status,
        visibility: existingRow.visibility,
        origin: origin2, created: false, requalified,
        assetCount: legacyAssetCount + own.length,
      });
    }
  }

  // ── 第二遍：挂资产 ──
  for (const a of checkedAssets) {
    let entryId = String(a.entry_id ?? "").trim();
    if (!entryId) {
      const t = String(a.entry_title ?? "").trim();
      entryId = idByTitle.get(t) ?? ((run.get(t) as { id?: string } | undefined)?.id ?? "");
    }
    if (!entryId) {
      throw new Error(`资产 ${a.rel} 没有指明挂到哪条条目（entry_title / entry_id 至少给一个，且要是真实条目）`);
    }
    lib.prepare(
      `INSERT INTO kb_entry_assets (entry_id, path, seq, title) VALUES (?, ?, ?, ?)
       ON CONFLICT(entry_id, path) DO UPDATE SET seq = excluded.seq, title = excluded.title`
    ).run(entryId, a.rel, Number.isFinite(Number(a.seq)) ? Number(a.seq) : 0, String(a.title ?? "").trim());
  }
  return saved;
}

export interface KbEntryRow {
  id: string;
  title: string;
  aliases: string;
  summary: string;
  tags: string;
  usage: string;
  visibility: string;
  share: string;
  status: string;
  origin: string;
  created_at: string;
  updated_at: string;
  assetCount: number;
}

export interface KbEntryBrief {
  id: string;
  title: string;
  status: string;
  visibility: string;
  origin: string;
  updated_at: string;
  summaryChars: number;
  assetCount: number;
  /** 挂到了哪些课上（`topic/course` 顿号连接；空串 = 没挂）。**只读展示用**，P2 起有值 */
  links: string;
}

export function listKbEntries(
  lib: DatabaseSync,
  opts?: { status?: string; query?: string; limit?: number }
): KbEntryBrief[] {
  const conds: string[] = [];
  const vals: string[] = [];
  const status = String(opts?.status ?? "").trim();
  if (status) {
    conds.push("status = ?");
    vals.push(status);
  }
  const q = String(opts?.query ?? "").trim();
  if (q) {
    conds.push("(title LIKE ? OR aliases LIKE ? OR tags LIKE ?)");
    vals.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(Number(opts?.limit) || 50, 200));
  const rows = lib
    .prepare(
      `SELECT e.id, e.title, e.status, e.visibility, e.origin, e.updated_at,
              LENGTH(e.summary) AS summaryChars,
              (SELECT COUNT(*) FROM kb_entry_assets a WHERE a.entry_id = e.id) AS assetCount,
              (SELECT GROUP_CONCAT(l.topic || '/' || l.course, '、')
                 FROM kb_entry_links l WHERE l.entry_id = e.id) AS links
       FROM kb_entries e${where} ORDER BY e.updated_at DESC LIMIT ${limit}`
    )
    .all(...(vals as string[])) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    status: String(r.status),
    visibility: String(r.visibility),
    origin: String(r.origin),
    updated_at: String(r.updated_at ?? ""),
    summaryChars: Number(r.summaryChars ?? 0),
    assetCount: Number(r.assetCount ?? 0),
    links: String(r.links ?? ""),
  }));
}

export function getKbEntry(lib: DatabaseSync, idOrTitle: string): KbEntryRow | undefined {
  const key = String(idOrTitle ?? "").trim();
  if (!key) return undefined;
  const row = (lib
    .prepare(
      `SELECT e.*, (SELECT COUNT(*) FROM kb_entry_assets a WHERE a.entry_id = e.id) AS assetCount
       FROM kb_entries e WHERE e.id = ? OR e.title = ? LIMIT 1`
    )
    .get(key, key) as unknown) as KbEntryRow | undefined;
  return row;
}

export interface KbAssetRow {
  entry_id: string;
  path: string;
  seq: number;
  title: string;
}

export function listKbAssets(lib: DatabaseSync, entryId: string): KbAssetRow[] {
  return lib
    .prepare("SELECT entry_id, path, seq, title FROM kb_entry_assets WHERE entry_id = ? ORDER BY seq, path")
    .all(entryId) as unknown as KbAssetRow[];
}

export interface KbPublishResult {
  published: string[];
  withdrawn: string[];
  missing: string[];
  /** 发布时被拒的（说话内容为空，只可能是历史脏行） */
  refused: Array<{ id: string; title: string; why: string }>;
}

/**
 * 发布 / 撤回。
 * - `visibility = 'child'` → `status = 'published'` + `visibility = 'child'`（两道门一起开）
 * - `visibility = 'parent'` → 只把 `visibility` 收回来，**`status` 不动**
 *   （「家长审过了，只是不给这个孩子看」是合法状态；撤回不该抹掉"审过"这个事实）
 *
 * 参数可给**完整 id 或精确 title**（模型复述时更容易拿到 title）。
 */
export function publishKbEntries(
  lib: DatabaseSync,
  idsOrTitles: string[],
  visibility: "child" | "parent"
): KbPublishResult {
  const keys = (idsOrTitles ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!keys.length) throw new Error("parent_kb_publish 需要 entry_ids（id 或精确标题）");
  if (visibility !== "child" && visibility !== "parent") throw new Error(`visibility 只能是 child / parent，收到：${visibility}`);
  const now = new Date().toISOString();
  const out: KbPublishResult = { published: [], withdrawn: [], missing: [], refused: [] };
  for (const key of keys) {
    const row = getKbEntry(lib, key);
    if (!row) {
      out.missing.push(key);
      continue;
    }
    if (visibility === "child") {
      if (!String(row.summary ?? "").trim() && !row.assetCount) {
        out.refused.push({ id: row.id, title: row.title, why: "既没有说法也没有资料" });
        continue;
      }
      lib.prepare("UPDATE kb_entries SET status = 'published', visibility = 'child', updated_at = ? WHERE id = ?").run(now, row.id);
      out.published.push(row.title);
    } else {
      lib.prepare("UPDATE kb_entries SET visibility = 'parent', updated_at = ? WHERE id = ?").run(now, row.id);
      out.withdrawn.push(row.title);
    }
  }
  return out;
}

// ==================== 删除条目（KB P2.1） ====================

export interface KbDeleteResult {
  deleted: string[];
  missing: string[];
  /** 找到了、但不许删的 */
  refused: Array<{ title: string; why: string }>;
}

/**
 * 删掉条目（不可逆）。
 *
 * **一条不变式：只能删「此刻孩子看不到的」**（`visibility = 'parent'`，草稿自然满足）。
 *
 * 为什么这么定：撤回（`visibility → parent`）是**可逆**的，删除是**不可逆**的。
 * 让不可逆的动作必须排在可逆的动作之后，家长就有一次"先把它从孩子眼前拿开、再看一眼要不要真的销毁"的机会；
 * 若允许直接删一条正在生效的条目，等于在没有任何预警的情况下改掉孩子听到的话，
 * 而且**删完无法解释"她昨天说的那句怎么没了"**。
 * 报错话术要给出下一步（先撤回），不能只说"不许删"。
 *
 * 连带清理（表之间没有外键，必须手工做）：
 * - `kb_entry_assets` / `kb_entry_links`：条目没了，它们就是悬空行；
 * - `kb_gaps.entry_id`：**回填过这个条目的缺口重新打开**（`entry_id=''` + `status='open'`）——
 *   答案被销毁了，那个问题就**重新是没人回答的问题**，不能留着"已闭环"的假象。
 */
export function deleteKbEntries(lib: DatabaseSync, keys: string[]): KbDeleteResult {
  const list = (keys ?? []).map((k) => String(k ?? "").trim()).filter(Boolean);
  if (!list.length) throw new Error("parent_kb_save 的 delete 需要条目 id 或精确标题");
  const out: KbDeleteResult = { deleted: [], missing: [], refused: [] };
  for (const key of list) {
    const row = getKbEntry(lib, key);
    if (!row) {
      out.missing.push(key);
      continue;
    }
    if (row.visibility === "child") {
      out.refused.push({
        title: row.title,
        why: "现在还能给孩子看到——先撤回（parent_kb_publish 传 visibility:\"parent\"）再删，删了没法恢复",
      });
      continue;
    }
    lib.prepare("DELETE FROM kb_entry_assets WHERE entry_id = ?").run(row.id);
    lib.prepare("DELETE FROM kb_entry_links WHERE entry_id = ?").run(row.id);
    lib.prepare("UPDATE kb_gaps SET entry_id = '', status = 'open' WHERE entry_id = ?").run(row.id);
    lib.prepare("DELETE FROM kb_entries WHERE id = ?").run(row.id);
    out.deleted.push(row.title);
  }
  return out;
}

/**
 * 家长**收回过**的条目数：审过（`published`）但当前不给孩子看（`visibility='parent'`）。
 *
 * 只用来回答一个是非题：**要不要给孩子会话注入那句"先核对再复述"的纪律**（见
 * `agent/kb-withdraw-notice.ts`）。这里的数是**家长维度**的不是某个孩子的——
 * 多一个孩子多一次查询不值得，而多注入一次纪律只是多一段提示词。
 *
 * `sinceDays` 是防噪音的：三个月前撤回的条目，孩子早不可能在当前会话里提过。
 */
export function countWithdrawn(lib: DatabaseSync, sinceDays = 14): number {
  const cutoff = new Date(Date.now() - Math.max(1, sinceDays) * 86_400_000).toISOString();
  const row = lib
    .prepare("SELECT COUNT(*) AS n FROM kb_entries WHERE status = 'published' AND visibility = 'parent' AND updated_at >= ?")
    .get(cutoff) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * 「撤回状态」的指纹：`条数:最近一次撤回时间`。
 *
 * 用途是**判断要不要再注入一次提醒**（见 `agent/kb-withdraw-notice.ts`）：
 * 指纹没变说明这一轮之前已经提醒过了，不必每轮重复；变了（又撤回了一条）就必须再提醒。
 * 它与 `countWithdrawn` 分开，是因为两件事的判断条件不同——
 * 「要不要在 system prompt 里挂纪律」看条数，而「要不要往会话里插一条新提醒」看**变化**。
 */
export function withdrawStamp(lib: DatabaseSync, sinceDays = 14): string {
  const cutoff = new Date(Date.now() - Math.max(1, sinceDays) * 86_400_000).toISOString();
  const row = lib
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS latest
       FROM kb_entries WHERE status = 'published' AND visibility = 'parent' AND updated_at >= ?`
    )
    .get(cutoff) as { n?: number; latest?: string } | undefined;
  const n = Number(row?.n ?? 0);
  return n ? `${n}:${row?.latest ?? ""}` : "";
}

// ==================== 条目 ↔ 课程绑定（KB P2） ====================

/**
 * 门控 SQL：安全过滤真源，**不靠提示词**。`?` = childId。
 *
 * 两个使用者共用它，这不是巧合而是硬要求：
 * - `searchKbForChild`（孩子主动问 → 拉取）
 * - `listEntryBriefsForCourse`（进课注入 → 推送）
 * 两条路都必须只放行同一批条目。**推送比拉取更危险**：拉取至少还经过一次提问，
 * 推送是会话一开始就塞进 system prompt，模型会当成"家长已经定了的事"直接讲。
 */
const GATED_WHERE = "status = 'published' AND visibility = 'child' AND (share = 'all' OR share = ?)";

export interface KbBindResult {
  /** 挂上的条目标题 */
  bound: string[];
  /** 摘下来的条目标题 */
  unbound: string[];
  /** 既不是 id 也不是精确标题 */
  missing: string[];
  /** 找到了、但按三条不变式拒绝的 */
  refused: Array<{ title: string; why: string }>;
}

/**
 * 把条目挂到某节课上 / 从课上摘下来。
 *
 * **三条不变式**（都在这里强制，不靠模型自觉）：
 * 1. 课程**必须真实存在**（`courses(topic, title)`）——否则条目挂在一节永远进不来的课上，
 *    家长以为配好了，上课时什么都没发生；
 * 2. 只能挂 `status = 'published'`；
 * 3. 只能挂 `visibility = 'child'`。
 *
 * 2/3 的理由是**同一条**：`kb_entry_links` 是一条**注入通道**——挂上的条目会在会话建立那一刻
 * 被拼进 system prompt，成为「回答以这些为准」。草稿、或"审过了但先不给她看"的条目一旦被挂上，
 * 就等于绕开 `GATED_WHERE`，把家长没确认过的话直接送进课堂。
 * **门控只有一处真源：能进 prompt 的，必须和能进 `kb_lookup` 的是同一批。**
 */
export function bindEntryToCourse(
  lib: DatabaseSync,
  keys: string[],
  opts: { topic: string; course: string; unbind?: boolean; seq?: number }
): KbBindResult {
  const topic = String(opts?.topic ?? "").trim();
  const course = String(opts?.course ?? "").trim();
  if (!topic || !course) throw new Error("parent_kb_bind 需要 topic 与 course（哪节课）");
  const list = (keys ?? []).map((k) => String(k ?? "").trim()).filter(Boolean);
  if (!list.length) throw new Error("parent_kb_bind 需要 entry_ids（条目 id 或精确标题）");

  const out: KbBindResult = { bound: [], unbound: [], missing: [], refused: [] };

  // 不变式 1：课程真实存在。报错时把该主题下**真实存在**的课程名回给模型，避免它猜第二遍。
  const courseRow = lib.prepare("SELECT title FROM courses WHERE topic = ? AND title = ? LIMIT 1").get(topic, course) as
    | { title?: string }
    | undefined;
  if (!courseRow) {
    const inTopic = lib
      .prepare("SELECT title FROM courses WHERE topic = ? ORDER BY sort_order LIMIT 5")
      .all(topic) as Array<{ title: string }>;
    const hint = inTopic.length
      ? `（该主题下现有课程：${inTopic.map((r) => r.title).join("、")}）`
      : "（该主题下一门课都还没有）";
    throw new Error(`课程不存在：主题 ${topic} / 课程 ${course}${hint}。先核对课程名，别猜。`);
  }

  const now = new Date().toISOString();
  const seqRaw = opts?.seq;
  const explicitSeq = seqRaw === undefined || seqRaw === null || String(seqRaw).trim() === "" ? null : Number(seqRaw);
  if (explicitSeq !== null && !Number.isFinite(explicitSeq)) throw new Error(`seq 必须是数字，收到：${String(seqRaw)}`);
  let nextSeq = Number(
    (
      lib.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM kb_entry_links WHERE topic = ? AND course = ?").get(topic, course) as
        | { n?: number }
        | undefined
    )?.n ?? 1
  );

  for (const key of list) {
    const row = getKbEntry(lib, key);
    if (!row) {
      out.missing.push(key);
      continue;
    }
    if (opts?.unbind) {
      lib.prepare("DELETE FROM kb_entry_links WHERE entry_id = ? AND topic = ? AND course = ?").run(row.id, topic, course);
      out.unbound.push(row.title);
      continue;
    }
    if (row.status !== "published") {
      out.refused.push({ title: row.title, why: "还是草稿（家长还没确认过）——先发布，再挂到课上" });
      continue;
    }
    if (row.visibility !== "child") {
      out.refused.push({ title: row.title, why: "当前是「先不给她看」——挂上去等于绕过这道门，先改成给她看" });
      continue;
    }
    const seq = explicitSeq ?? nextSeq++;
    lib.prepare("INSERT OR REPLACE INTO kb_entry_links (entry_id, topic, course, seq) VALUES (?, ?, ?, ?)").run(
      row.id,
      topic,
      course,
      seq
    );
    lib.prepare("UPDATE kb_entries SET updated_at = ? WHERE id = ?").run(now, row.id);
    out.bound.push(row.title);
  }
  return out;
}

export interface KbCourseEntryBrief {
  id: string;
  title: string;
  summary: string;
  usage: string;
  seq: number;
  assets: Array<{ path: string; title: string; kind: string }>;
}

/** 一节课最多注入几条条目（防御性上限：家长真挂了 50 条也别把 system prompt 撑爆） */
export const KB_COURSE_LIMIT = 8;

/**
 * 某节课挂着的条目（**只返回孩子此刻真能查到的那些**）。
 *
 * 为什么这里必须**再门控一次**、不能只信"绑定时校验过"：绑定之后家长随时可能
 * 把条目**撤回**（`visibility` 回到 `parent`），或**改回草稿**（改了 `summary` 会自动退回草稿）。
 * 那时 `kb_entry_links` 的行还在——**注入必须在读的时候再判一次**，
 * 否则「绑定时只能绑已发布」这道门只挡住了第一秒，之后句句失效。
 * 门控条件与 `kb_lookup` 用的是同一个 `GATED_WHERE`（同一处真源）。
 */
export function listEntryBriefsForCourse(
  lib: DatabaseSync,
  topic: string,
  course: string,
  childId: string,
  limit = KB_COURSE_LIMIT
): KbCourseEntryBrief[] {
  const t = String(topic ?? "").trim();
  const c = String(course ?? "").trim();
  if (!t || !c) return [];
  const rows = lib
    .prepare(
      `SELECT e.id, e.title, e.summary, e.usage, l.seq
       FROM kb_entry_links l JOIN kb_entries e ON e.id = l.entry_id
       WHERE l.topic = ? AND l.course = ? AND ${GATED_WHERE}
       ORDER BY l.seq, e.title
       LIMIT ${Math.max(1, Math.min(Number(limit) || KB_COURSE_LIMIT, 50))}`
    )
    .all(t, c, childId) as Array<Record<string, unknown>>;
  if (!rows.length) return [];

  const ids = rows.map((r) => String(r.id));
  const ph = ids.map(() => "?").join(",");
  const assetRows = lib
    .prepare(`SELECT entry_id, path, title FROM kb_entry_assets WHERE entry_id IN (${ph}) ORDER BY seq, path`)
    .all(...ids) as Array<{ entry_id: string; path: string; title: string }>;
  const byEntry = new Map<string, Array<{ path: string; title: string; kind: string }>>();
  for (const a of assetRows) {
    const list = byEntry.get(a.entry_id) ?? [];
    list.push({ path: a.path, title: a.title ?? "", kind: zhAssetKind(a.path) });
    byEntry.set(a.entry_id, list);
  }

  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    summary: String(r.summary ?? ""),
    usage: String(r.usage ?? ""),
    seq: Number(r.seq ?? 0),
    assets: byEntry.get(String(r.id)) ?? [],
  }));
}

// ==================== 检索（孩子侧唯一入口） ====================

export interface KbHit {
  id: string;
  title: string;
  summary: string;
  usage: string;
  /** 命中方式（给模型交代出处用） */
  via: string;
  assets: KbAssetRow[];
}

/** 剥疑问词与标点。不做这步，`kb_lookup("甲骨文是什么呀？")` 会全条落空。 */
export function normalizeKbQuery(raw: string): string {
  let s = String(raw ?? "").trim();
  s = s.replace(/[\s?？。！!，,、；;：:"'“”「」『』【】（）()]/g, "");
  // 长词在前，避免「是什么」被「什么」先切坏（本表里没有「什么」单列，顺序仍按长度排更稳）
  for (const w of ["是什么", "什么是", "为什么", "怎么回事", "怎么样", "怎么", "哪个", "哪些", "吗", "呢", "呀", "啊", "谁"]) {
    s = s.split(w).join("");
  }
  return s;
}

function aliasTokens(aliases: string): string[] {
  return String(aliases ?? "")
    .split(/[,，、;；|]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 孩子侧检索：**门控在 SQL，匹配在 JS**（家族级 10²~10³ 条，全量取出匹配最稳，
 * 也避免跟中文逗号分隔串较劲）。
 *
 * 匹配三条规则按优先级给分（命中即按最高分排）：
 * 1. `title` 精确（3 分）
 * 2. `aliases` 任一项被问句包含（2 分）——例：「人是女娲造的吗」→ 归一化成「人是女娲造的」，
 *    靠 `aliases` 里的「女娲」兜住（**只靠 title 匹配是不够的**）
 * 3. `title` 与问句互相包含（1 分）
 */
export function searchKbForChild(
  lib: DatabaseSync,
  childId: string,
  query: string,
  limit = 5
): KbHit[] {
  const q = normalizeKbQuery(query);
  if (!q) return [];
  const rows = lib
    .prepare(
      `SELECT id, title, aliases, summary, usage FROM kb_entries WHERE ${GATED_WHERE}`
    )
    .all(childId) as Array<{ id: string; title: string; aliases: string; summary: string; usage: string }>;

  const scored: Array<{ row: (typeof rows)[number]; score: number; via: string }> = [];
  for (const r of rows) {
    const title = String(r.title ?? "").trim();
    if (!title) continue;
    let score = 0;
    let via = "";
    if (q === title) {
      score = 3;
      via = "标题精确";
    } else {
      const hitAlias = aliasTokens(r.aliases).find((t) => q.includes(t) || t.includes(q));
      if (hitAlias) {
        score = 2;
        via = `别名「${hitAlias}」`;
      } else if (q.length >= 2 && (title.includes(q) || (title.length >= 2 && q.includes(title)))) {
        score = 1;
        via = "标题包含";
      }
    }
    if (score > 0) scored.push({ row: r, score, via });
  }
  scored.sort((a, b) => b.score - a.score || String(a.row.title).localeCompare(String(b.row.title)));

  const cap = Math.max(1, Math.min(Number(limit) || 5, 10));
  return scored.slice(0, cap).map((s) => ({
    id: s.row.id,
    title: s.row.title,
    summary: String(s.row.summary ?? ""),
    usage: String(s.row.usage ?? ""),
    via: s.via,
    assets: listKbAssets(lib, s.row.id),
  }));
}

/** 高风险管理上限（`high_risk` 参数名，与工具参数一致） */
export const KB_MATCH_LIMIT = 5;

export interface KbGapRow {
  id: string;
  child_id: string;
  question: string;
  hits_json: string;
  high_risk: number;
  count: number;
  asked_at: string;
  status: string;
  entry_id: string;
}

/**
 * 记一条缺口。**同一孩子同一问题已有 open 行 → `count + 1` 并刷新 `asked_at`**，
 * 不新插一行：孩子会反复问同一个问题，不去重的话家长清单会被同一个问题刷屏。
 */
export function recordKbGap(
  lib: DatabaseSync,
  childId: string,
  question: string,
  highRisk: boolean,
  hits: Array<{ id: string; title: string }> = []
): { count: number; created: boolean } {
  const q = String(question ?? "").trim();
  if (!q) return { count: 0, created: false };
  const now = new Date().toISOString();
  const hitsJson = JSON.stringify(hits.map((h) => ({ id: h.id, title: h.title })));
  const existing = lib
    .prepare("SELECT id, count FROM kb_gaps WHERE child_id = ? AND question = ? AND status = 'open' LIMIT 1")
    .get(childId, q) as { id: string; count: number } | undefined;
  if (existing) {
    const next = Number(existing.count) + 1;
    lib.prepare("UPDATE kb_gaps SET count = ?, asked_at = ?, hits_json = ?, high_risk = ? WHERE id = ?").run(
      next, now, hitsJson, highRisk ? 1 : 0, existing.id
    );
    return { count: next, created: false };
  }
  lib.prepare(
    `INSERT INTO kb_gaps (id, child_id, question, hits_json, high_risk, count, asked_at, status, entry_id)
     VALUES (?, ?, ?, ?, ?, 1, ?, 'open', '')`
  ).run(randomUUID(), childId, q, hitsJson, highRisk ? 1 : 0, now);
  return { count: 1, created: true };
}

export function listKbGaps(
  lib: DatabaseSync,
  opts?: { status?: string; childId?: string; limit?: number }
): KbGapRow[] {
  const conds: string[] = [];
  const vals: string[] = [];
  const status = String(opts?.status ?? "open").trim();
  if (status) {
    conds.push("status = ?");
    vals.push(status);
  }
  if (opts?.childId) {
    conds.push("child_id = ?");
    vals.push(String(opts.childId));
  }
  const where = conds.length ? ` WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(Number(opts?.limit) || 30, 100));
  return lib
    .prepare(
      `SELECT * FROM kb_gaps${where} ORDER BY high_risk DESC, count DESC, asked_at DESC LIMIT ${limit}`
    )
    .all(...(vals as string[])) as unknown as KbGapRow[];
}

// ==================== 冷启动：建议清单 ====================

/**
 * 「家庭口径域」建议清单（§3.9②，最高必要性）。
 *
 * 注意它**不是** wiki 词条清单——下面这些**几乎都不是百科条目**，而是"只有家长能定"的话题：
 * 这恰好反证了"wiki 是不是主轴"这个问题（答案：不是）。
 * 家长用 `parent_kb_list({view:"suggestions"})` 划勾，建前 20 条就够。
 */
export const KB_SEED_SUGGESTIONS: ReadonlyArray<{ domain: string; items: string[] }> = [
  { domain: "生命起源", items: ["我从哪里来", "女娲造人", "人是猴子变的吗", "恐龙为什么灭绝"] },
  { domain: "死亡", items: ["人会死吗", "去世的亲人去哪了", "宠物死了", "清明/扫墓是怎么回事"] },
  { domain: "身体", items: ["男生女生为什么不一样", "亲嘴是什么", "为什么要穿衣服遮住", "流血/受伤怎么办"] },
  { domain: "信仰与节日", items: ["有没有神", "为什么要拜祖先", "过年为什么要做这些", "别人信教我们怎么看"] },
  { domain: "钱", items: ["钱是从哪来的", "爸爸妈妈工资多少", "为什么不能什么都买", "贵和便宜怎么分"] },
  { domain: "规则与权威", items: ["为什么要听老师的", "大人说的都对吗", "可以拒绝大人吗", "家里的规矩为什么这样定"] },
  { domain: "是非", items: ["什么是好人坏人", "说谎一定不对吗", "打抱不平可以动手吗", "捡到东西怎么办"] },
  { domain: "同伴", items: ["同学不跟我玩", "被人取外号", "要不要告老师", "分享到什么程度"] },
  { domain: "失败", items: ["考不好怎么办", "输了很丢脸", "别人比我强", "做不到要不要放弃"] },
  { domain: "网络安全", items: ["网上的人能信吗", "为什么不能给陌生人信息", "看到奇怪的东西怎么办"] },
  { domain: "价值判断", items: ["为什么要学习", "努力和聪明哪个重要", "帮人要不要回报"] },
];

export interface KbSuggestion {
  domain: string;
  title: string;
  /** 库里已经有同名条目（建议清单里不打勾，只是别重复建） */
  exists: boolean;
}

/** 建议清单：静态种子 ⊕ 库里已有标题（已有的标记出来，避免重复建）。 */
export function listKbSuggestions(lib: DatabaseSync): KbSuggestion[] {
  const existing = new Set(
    (lib.prepare("SELECT title FROM kb_entries").all() as Array<{ title: string }>).map((r) => String(r.title))
  );
  return KB_SEED_SUGGESTIONS.flatMap((g) =>
    g.items.map((title) => ({ domain: g.domain, title, exists: existing.has(title) }))
  );
}

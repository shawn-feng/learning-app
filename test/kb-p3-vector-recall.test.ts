/**
 * KB P3 阶段①（2026-09-25）：**语义兜底召回**。
 *
 * 解决的问题是文档里写明的失败判据（§4.2）：`kb_gaps` 里大量是"**别名没写全**"而不是"没建条目"
 * ——精确匹配换个问法就查不到。P3 用既有 `embeddings.ts` 的向量设施补上第二条路。
 *
 * 三条**设计约束**要钉住（比"能不能召回"重要得多）：
 * 1. **向量只排序，内容回表按当前状态重读**——旁表里的向量是"写入那一刻"的快照，
 *    家长后来可能撤回了、改回草稿了、甚至删了。**门控只有一处真源**（`GATED_WHERE`），
 *    不能因为多了一条召回路径就在别处再写一遍过滤。本文件最关键的一组断言就是它。
 * 2. **只在精确零命中时才走**，且**任何失败静默降级**（没配 embedding / 服务超时 / 库读不到）
 *    ——检索失败绝不能变成"拦住孩子提问"。
 * 3. **合成检索文本不落库**：`title + aliases + summary + body(截 600)` 只在嵌入那一刻拼出来，
 *    `kb_entries` 上不加派生列（ISSUE-131 P2 与 `kb_entry_assets.role` 的同一条教训）。
 *
 * 测法：**不依赖 embedding 服务**——往旁表手写向量，直接测排序与门控。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import {
  KB_VECTOR_THRESHOLD,
  deleteKbEntries,
  getGatedEntry,
  publishKbEntries,
  saveKbEntries,
  searchKbForChild,
} from "../server/src/db/kb-entries";
import {
  KB_ENTRY_TEXT_COLUMN,
  VECTOR_DEFAULT_THRESHOLD,
  embeddedColumn,
  invalidateVectorCache,
  kbEntryText,
  parentLibCacheKey,
  topVectorRows,
  vectorThreshold,
  vectorToBlob,
} from "../server/src/agent/embeddings";
import { createChildKbTools, formatHits, formatSemanticHits } from "../server/src/agent/child-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p3v-"));
const parentId = "p-kb-p3v";
const childId = "c-kb-p3v";
const otherChild = "c-kb-p3v-other";

const main = openDb(dataDir);
const nowIso = new Date().toISOString();
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "p3@test", nowIso, nowIso);
for (const [id, n] of [
  [childId, "娃"],
  [otherChild, "弟"],
] as const) {
  main.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(id, parentId, n, nowIso, nowIso);
}

const lib = openParentLib(dataDir, parentId);

afterAll(() => {
  for (const close of [() => main.close(), () => lib.close()]) {
    try {
      close();
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const root = materialsRoot(dataDir, parentId);
fs.mkdirSync(path.join(root, "preqin"), { recursive: true });
fs.writeFileSync(path.join(root, "preqin", "甲骨文.jpg"), "fake-jpg");

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");

function makeEntry(
  title: string,
  opts?: { summary?: string; aliases?: string; share?: string; assets?: string[] }
): string {
  const [s] = saveKbEntries(
    lib,
    dataDir,
    parentId,
    [
      {
        title,
        summary: opts?.summary ?? `${title} 的说法`,
        aliases: opts?.aliases,
        share: opts?.share,
      },
    ],
    (opts?.assets ?? []).map((p) => ({ entry_title: title, path: p }))
  );
  return s.id;
}

/** 往旁表手写一条向量（绕开 embedding 服务）。exact = 与查询向量完全一致 → 余弦 1.0 */
function putVector(entryId: string, vec: number[]): void {
  lib
    .prepare(
      `INSERT OR REPLACE INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash, updated_at)
       VALUES ('kb_entries', ?, ?, 'test', ?, ?, 'h', '')`
    )
    .run(JSON.stringify([entryId]), KB_ENTRY_TEXT_COLUMN, vec.length, vectorToBlob(new Float32Array(vec)));
  invalidateVectorCache(parentLibCacheKey(dataDir, parentId), "kb_entries", KB_ENTRY_TEXT_COLUMN);
}

const QV = () => new Float32Array([1, 0, 0, 0]);
/**
 * 默认 topK 开大：本文件所有用例共用一个库，多条目向量都是 [1,0,0,0]（余弦 1.0），
 * 用 topK=5 会被满分项占满、把要断言的那条挤出去——那是测试自身的坑，不是实现的问题。
 */
const top = (opts?: { topK?: number; threshold?: number }) =>
  topVectorRows(lib, "kb_entries", KB_ENTRY_TEXT_COLUMN, QV(), {
    threshold: opts?.threshold ?? 0.5,
    topK: opts?.topK ?? 50,
    cacheKey: parentLibCacheKey(dataDir, parentId),
  });

describe("KB P3①：合成检索文本（不落库）", () => {
  it("顺序 = title → aliases → summary → body（向量模型不认权重，顺序即重要性）", () => {
    const t = kbEntryText({ title: "甲骨文", aliases: "龟甲,兽骨", summary: "刻在龟甲上的字", body: "正文很长" });
    expect(t.indexOf("甲骨文")).toBeLessThan(t.indexOf("龟甲"));
    expect(t.indexOf("龟甲")).toBeLessThan(t.indexOf("刻在龟甲上的字"));
    expect(t.indexOf("刻在龟甲上的字")).toBeLessThan(t.indexOf("正文很长"));
  });

  it("**body 截到 600 字**（防一篇长资料把条目名与别名淹没在向量里）", () => {
    const long = "字".repeat(900);
    const t = kbEntryText({ title: "T", body: long });
    expect(t).toContain("字".repeat(600));
    expect(t).not.toContain("字".repeat(601));
  });

  it("空白折叠、空字段不占位（不留一串分隔符）", () => {
    expect(kbEntryText({ title: "甲  骨\n文", aliases: "  ", summary: "" })).toBe("甲 骨 文");
  });

  it("kb_entries 注册了**虚拟列**（有 textOf，不读真实列）", () => {
    const ec = embeddedColumn("kb_entries", KB_ENTRY_TEXT_COLUMN);
    expect(ec).toBeTruthy();
    expect(typeof ec!.textOf).toBe("function");
    expect(ec!.pkCols).toEqual(["id"]);
    // 关键：虚拟列名**不是** kb_entries 的真实列（否则就是派生数据入库）
    const cols = (lib.prepare("PRAGMA table_info(kb_entries)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).not.toContain(KB_ENTRY_TEXT_COLUMN);
  });
});

describe("KB P3①：向量只排序，**门控仍然说了算**", () => {
  it("**草稿条目**：向量能把它排出来，但 `getGatedEntry` 拿不到 → 召回结果必须为空", () => {
    const id = makeEntry("向量-草稿条目", { aliases: "骨头上的字" });
    putVector(id, [1, 0, 0, 0]);
    expect(top().map((r) => r.rowPk)).toContain(JSON.stringify([id])); // 向量层面确实排到了
    expect(getGatedEntry(lib, childId, id, "语义匹配")).toBeUndefined(); // 但门控把它挡住
  });

  it("**已发布但「先不给她看」**：同样挡住", () => {
    const id = makeEntry("向量-已撤回");
    publishKbEntries(lib, [id], "child");
    publishKbEntries(lib, [id], "parent");
    putVector(id, [1, 0, 0, 0]);
    expect(top().map((r) => r.rowPk)).toContain(JSON.stringify([id]));
    expect(getGatedEntry(lib, childId, id, "语义匹配")).toBeUndefined();
  });

  it("**share 只给别的孩子**：这个孩子拿不到，另一个孩子拿得到（门控与 kb_lookup 同一处）", () => {
    const id = makeEntry("向量-share限定", { share: otherChild });
    publishKbEntries(lib, [id], "child");
    putVector(id, [1, 0, 0, 0]);
    expect(getGatedEntry(lib, childId, id, "语义匹配")).toBeUndefined();
    expect(getGatedEntry(lib, otherChild, id, "语义匹配")?.id).toBe(id);
  });

  it("已发布 + 给她看 → 拿得到，且带 via（分数）与资料", () => {
    const id = makeEntry("向量-正常", { aliases: "龟甲", assets: ["preqin/甲骨文.jpg"] });
    publishKbEntries(lib, [id], "child");
    const hit = getGatedEntry(lib, childId, id, "语义匹配 0.88")!;
    expect(hit).toBeTruthy();
    expect(hit.via).toContain("语义匹配");
    expect(hit.assets.map((a) => a.path)).toEqual(["preqin/甲骨文.jpg"]);
  });

  it("行已删 → 拿不到（向量旁表可能还残留，读的时候以业务表为准）", () => {
    const id = makeEntry("向量-待删");
    publishKbEntries(lib, [id], "parent");
    putVector(id, [1, 0, 0, 0]);
    const d = deleteKbEntries(lib, [id]);
    expect(d.ids).toEqual([id]); // ids 要回传，才能让 worker 去清旁表向量
    expect(getGatedEntry(lib, childId, id, "语义匹配")).toBeUndefined();
  });
});

describe("KB P3①：topVectorRows 的排序与阈值", () => {
  it("低于阈值的不返回（阈值不过即未命中，与既有 courses/topics 一致）", () => {
    const id = makeEntry("向量-正交");
    putVector(id, [0, 1, 0, 0]); // 与 [1,0,0,0] 余弦 = 0
    expect(top().map((r) => r.rowPk)).not.toContain(JSON.stringify([id]));
  });

  it("按分数降序、按 topK 截断", () => {
    const a = makeEntry("向量-排序A");
    const b = makeEntry("向量-排序B");
    putVector(a, [1, 0, 0, 0]); // 1.0
    putVector(b, [0.8, 0.6, 0, 0]); // 0.8
    const rows = top();
    const ia = rows.findIndex((r) => r.rowPk === JSON.stringify([a]));
    const ib = rows.findIndex((r) => r.rowPk === JSON.stringify([b]));
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ib).toBeGreaterThanOrEqual(0);
    expect(ia).toBeLessThan(ib);
    expect(
      topVectorRows(lib, "kb_entries", KB_ENTRY_TEXT_COLUMN, QV(), {
        threshold: 0.5,
        topK: 1,
        cacheKey: parentLibCacheKey(dataDir, parentId),
      })
    ).toHaveLength(1);
  });

  it("坏 row_pk（脏数据）不抛，只是解不出来（调用方负责 try/catch）", () => {
    lib
      .prepare(
        `INSERT OR REPLACE INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash, updated_at)
         VALUES ('kb_entries', 'not-json', ?, 'test', 4, ?, 'h', '')`
      )
      .run(KB_ENTRY_TEXT_COLUMN, vectorToBlob(new Float32Array([1, 0, 0, 0])));
    invalidateVectorCache(parentLibCacheKey(dataDir, parentId), "kb_entries", KB_ENTRY_TEXT_COLUMN);
    expect(top().map((r) => r.rowPk)).toContain("not-json"); // 排序阶段不解析 row_pk
    expect(() => JSON.parse("not-json")).toThrow(); // 所以解析方必须自己兜住
  });
});

describe("KB P3①：语义命中**只作候选**，不当权威口径（回话契约）", () => {
  const hit: any = { id: "x", title: "恐龙是怎么没的", summary: "大石头砸没的", usage: "", via: "语义匹配 0.51", assets: [] };

  it("精确命中写「可直接引用」；语义命中写「先确认说的确实是这件事」", () => {
    expect(formatHits([hit])).toContain("可直接引用");
    const sem = formatSemanticHits([hit]);
    expect(sem).toContain("先确认说的确实是这件事");
    // 关键：**不能**出现"可直接引用"——块内那行与块外那行打架，模型会听块内的
    expect(sem).not.toContain("可直接引用");
  });

  it("语义回话给出三条退路（是同一件事 / 不确定 / 别把相似当就是）", () => {
    const sem = formatSemanticHits([hit]);
    expect(sem).toContain("确认是同一件事");
    expect(sem).toContain("当没命中处理");
    expect(sem).toContain("不要把「相似」当成「就是」");
    expect(sem).toContain("问爸爸妈妈");
  });

  it("**KB 的阈值必须低于通用默认**（问题→条目的语义分天然低于课程名→课程名；实测同义改写只有 0.51）", () => {
    expect(KB_VECTOR_THRESHOLD).toBeLessThan(VECTOR_DEFAULT_THRESHOLD);
    expect(KB_VECTOR_THRESHOLD).toBeGreaterThan(0.3); // 也别低到"什么都算命中"
  });

  it("家长显式配了 embeddingThreshold 时以家长的为准（vectorThreshold 的 fallback 参数）", () => {
    expect(vectorThreshold({ embeddingThreshold: 0.72 }, KB_VECTOR_THRESHOLD)).toBe(0.72);
    expect(vectorThreshold({}, KB_VECTOR_THRESHOLD)).toBe(KB_VECTOR_THRESHOLD);
    expect(vectorThreshold({ embeddingThreshold: 1.5 }, KB_VECTOR_THRESHOLD)).toBe(KB_VECTOR_THRESHOLD); // 越界回退
  });
});

describe("KB P3①：kb_lookup 的语义兜底行为", () => {
  it("**没配 embedding**（或没传 db）→ 静默降级成「没命中」，绝不能变成拦住提问", async () => {
    const tools = createChildKbTools({ dataDir, parentId, childId, db: main });
    const t = tools.find((x: any) => x.name === "kb_lookup")!;
    const out = text(await (t as any).execute("l1", { query: "这个词库里绝对没有xyz" }));
    expect(out).toMatch(/没有命中/);
    expect(out).not.toMatch(/报错|失败|Error/);
  });

  it("精确命中时不走语义（语义只在零命中时兜底）", async () => {
    const title = "语义兜底-精确优先";
    makeEntry(title, { aliases: "精确优先别名" });
    publishKbEntries(lib, [title], "child");
    const tools = createChildKbTools({ dataDir, parentId, childId, db: main });
    const t = tools.find((x: any) => x.name === "kb_lookup")!;
    const out = text(await (t as any).execute("l2", { query: "精确优先别名" }));
    expect(out).toMatch(/命中 1 条/);
    expect(out).not.toMatch(/语义匹配/);
  });

  it("精确检索本身不受影响（P1 行为不变）", () => {
    const hits = searchKbForChild(lib, childId, "精确优先别名", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].via).toMatch(/别名/);
  });
});

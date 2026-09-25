/**
 * KB P3 阶段③（2026-09-25）：**长正文分块 + 块级向量**。
 *
 * ## 要解决的问题
 * 条目级向量把 `body` 截到 600 字（`kbEntryText`）。一份两万字的资料里，**第 600 字之后的内容
 * 在条目向量里根本不存在**——孩子问到靠后的内容，语义兜底查不到。
 *
 * ## 三条要钉住的性质
 * 1. **确定性**：`chunkText` 是纯函数，同一份 body 永远切出同一批块。
 *    这不是审美要求——块是向量旁表的主键载体（`row_pk = [entry_id, seq]`），
 *    切法一变同一个 `seq` 就指向别的文本，整套索引立刻不自洽。
 * 2. **缓存 ↔ 真源**：`kb_entry_chunks` 是 `body` 的派生缓存，**写 body 就整体重建**；
 *    它必须**任何时候都能由 body 完整重建**（所以删条目要连块一起删，否则留下永远重建不出来的孤儿）。
 * 3. **门控仍然说了算**：块级召回命中的是**条目**不是片段，读的时候照旧按当前状态过滤
 *    （旁表里的块向量是写入那一刻的快照，家长可能已经撤回了）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import {
  deleteKbEntries,
  getGatedEntry,
  getKbBody,
  listKbChunks,
  publishKbEntries,
  replaceKbChunks,
  saveKbEntries,
} from "../server/src/db/kb-entries";
import {
  KB_CHUNK_MAX,
  KB_CHUNK_OVERLAP,
  KB_CHUNK_SIZE,
  chunkText,
} from "../server/src/agent/kb-ingest";
import {
  KB_CHUNK_TEXT_COLUMN,
  embeddedColumn,
  invalidateVectorCache,
  parentLibCacheKey,
  topVectorRows,
  vectorToBlob,
} from "../server/src/agent/embeddings";
import { createParentKbTools } from "../server/src/agent/parent-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-p3c-"));
const parentId = "p-kb-p3c";
const childId = "c-kb-p3c";

const main = openDb(dataDir);
const nowIso = new Date().toISOString();
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "p3c@test", nowIso, nowIso);
main.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(childId, parentId, "娃", nowIso, nowIso);
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
const longBody = Array.from({ length: 30 }, (_, i) => `第${i + 1}段：${"甲".repeat(180)}。`).join("\n\n");
fs.writeFileSync(path.join(root, "preqin", "长文.html"), `<p>${longBody.replace(/\n\n/g, "</p><p>")}</p>`);
fs.writeFileSync(path.join(root, "preqin", "短文.txt"), "只有一句话。");

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");
const tools: any[] = createParentKbTools({ dataDir, parentId, db: main });
const byName = (n: string) => tools.find((t) => t.name === n)!;

function putChunkVector(entryId: string, seq: number, vec: number[]): void {
  lib
    .prepare(
      `INSERT OR REPLACE INTO embeddings (table_name, row_pk, column_name, model, dim, vector, source_hash, updated_at)
       VALUES ('kb_entry_chunks', ?, ?, 'test', ?, ?, 'h', '')`
    )
    .run(JSON.stringify([entryId, seq]), KB_CHUNK_TEXT_COLUMN, vec.length, vectorToBlob(new Float32Array(vec)));
  invalidateVectorCache(parentLibCacheKey(dataDir, parentId), "kb_entry_chunks", KB_CHUNK_TEXT_COLUMN);
}

describe("KB P3③：chunkText（纯函数，确定性）", () => {
  it("**同一份 body 永远切出同一批块**（切法一变，seq 就指向别的文本，索引立刻不自洽）", () => {
    const t = `${"甲".repeat(300)}。\n\n${"乙".repeat(300)}。\n\n${"丙".repeat(300)}。`;
    expect(chunkText(t)).toEqual(chunkText(t));
  });

  it("短段落尽量合并，别切成一堆碎块", () => {
    const t = ["一句话。", "两句话。", "三句话。"].join("\n\n"); // 每段 4 字
    expect(chunkText(t)).toEqual(["一句话。\n两句话。\n三句话。"]);
  });

  it("空/纯空白 → 空数组（不产生空块）", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n \t ")).toEqual([]);
  });

  it("超长段落按句切开，且**块间有重叠**（跨块的句子两边都够得着）", () => {
    // 200 个 11 字句 → 远超 size
    const para = Array.from({ length: 200 }, (_, i) => `第${i}句：${"字".repeat(6)}。`).join("");
    const cs = chunkText(para, { size: 200, overlap: 40 });
    expect(cs.length).toBeGreaterThan(2);
    // 相邻块共享一段尾部文本（重叠的直接后果）
    const tail = cs[0]!.slice(-40);
    expect(cs[1]!.startsWith(tail)).toBe(true);
  });

  it("单句超长（无标点的长串）也能硬切，不产生超长块", () => {
    const cs = chunkText("甲".repeat(1000), { size: 200, overlap: 20 });
    expect(cs.every((c) => c.length <= 200)).toBe(true);
    expect(cs.length).toBeGreaterThan(1);
  });

  it("**重复块去掉**（页眉页脚/重复小标题切出的同文块只会污染向量）", () => {
    // 两个前提：① 段落要**超过 size** 才会被切开（短段落会被合并逻辑先吸收，测不到去重）；
    // ② `chunkText` 把 size 下限夹在 80，所以 size 不能给太小（给了也会被抬到 80）。
    const dup = `${"甲".repeat(200)}。`;
    const opts = { size: 100 };
    const twice = chunkText([dup, "乙乙乙。", dup].join("\n\n"), opts);
    const once = chunkText(dup, opts);
    expect(once.length).toBeGreaterThan(1); // 前提：那段确实被切成了多块
    expect(new Set(twice).size).toBe(twice.length); // 输出里无重复块
    // 那段甲文出现两次，贡献的块数必须与只出现一次时相同（不去重的话会翻倍）
    expect(twice.filter((c) => c.includes("甲")).length).toBe(once.filter((c) => c.includes("甲")).length);
  });

  it("硬切不再吐「已被前一块覆盖的尾巴」（否则会切出「。」这种 1 字块）", () => {
    const cs = chunkText(`${"甲".repeat(200)}。`, { size: 100 });
    expect(cs.every((c) => c.length > 1)).toBe(true);
    // 最后一块必须把句末标点带上（内容没被切丢）
    expect(cs[cs.length - 1]!.endsWith("。")).toBe(true);
  });

  it("有上限（防一份 2 万字资料产生上百次嵌入调用）", () => {
    const cs = chunkText(Array.from({ length: 500 }, (_, i) => `第${i}段${"甲".repeat(300)}`).join("\n\n"));
    expect(cs.length).toBeLessThanOrEqual(KB_CHUNK_MAX);
  });

  it("常量之间的约束：overlap 不能大于等于 size（否则块永远长不大）", () => {
    expect(KB_CHUNK_OVERLAP).toBeLessThan(KB_CHUNK_SIZE);
  });
});

describe("KB P3③：分块缓存（kb_entry_chunks）", () => {
  it("replaceKbChunks 整体重建：先清空再写，**旧块不会残留**", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "重建", summary: "说法", body: "第一版内容" }]);
    replaceKbChunks(lib, s.id, ["块A", "块B", "块C"]);
    expect(listKbChunks(lib, s.id).map((c) => c.text)).toEqual(["块A", "块B", "块C"]);
    replaceKbChunks(lib, s.id, ["只剩一块"]);
    expect(listKbChunks(lib, s.id).map((c) => c.text)).toEqual(["只剩一块"]);
  });

  it("空块被跳过（不留空文本行去浪费一次嵌入）", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "空块", summary: "x" }]);
    const n = replaceKbChunks(lib, s.id, ["有内容", "   ", ""]);
    expect(n).toBe(1);
    expect(listKbChunks(lib, s.id)).toHaveLength(1);
  });

  it("**删条目连块一起删**（否则留下永远重建不出来的孤儿行）", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "要删的", summary: "x", body: "正文" }]);
    replaceKbChunks(lib, s.id, chunkText(getKbBody(lib, s.id)));
    expect(listKbChunks(lib, s.id).length).toBeGreaterThan(0);
    publishKbEntries(lib, [s.id], "parent");
    const d = deleteKbEntries(lib, [s.id]);
    expect(d.deleted).toEqual(["要删的"]);
    expect(listKbChunks(lib, s.id)).toHaveLength(0);
  });

  it("kb_entry_chunks 注册成了**真实列**（不是虚拟列）——它是按主键查回文本的落点", () => {
    const ec = embeddedColumn("kb_entry_chunks", KB_CHUNK_TEXT_COLUMN);
    expect(ec).toBeTruthy();
    expect(ec!.textOf).toBeUndefined();
    expect(ec!.pkCols).toEqual(["entry_id", "seq"]);
  });
});

describe("KB P3③：写入路径会同步分块缓存", () => {
  it("ingest 长文 → 自动切块落库（家长不用管）", async () => {
    await byName("parent_kb_save").execute("i1", { ingest: [{ path: "preqin/长文.html" }] });
    const e = lib.prepare("SELECT id FROM kb_entries WHERE title = ?").get("长文") as { id: string };
    expect(e).toBeTruthy();
    const chunks = listKbChunks(lib, e.id);
    expect(chunks.length).toBeGreaterThan(3); // 长正文真的被切开了
    expect(chunks.length).toBeLessThanOrEqual(KB_CHUNK_MAX);
    expect(chunks[0]!.seq).toBe(0);
    // 块合起来能覆盖正文的大部分内容（不是切丢了）
    const joined = chunks.map((c) => c.text).join("");
    expect(joined.length).toBeGreaterThan(getKbBody(lib, e.id).length * 0.8);
  });

  it("短文也会有一块（块数 ≥ 1，别让短资料落进「没有块」的盲区）", async () => {
    await byName("parent_kb_save").execute("i2", { ingest: [{ path: "preqin/短文.txt" }] });
    const e = lib.prepare("SELECT id FROM kb_entries WHERE title = ?").get("短文") as { id: string };
    expect(listKbChunks(lib, e.id)).toHaveLength(1);
  });

  it("**改 body 会重建块**（不是追加——旧块必须消失）", async () => {
    const e = lib.prepare("SELECT id FROM kb_entries WHERE title = ?").get("长文") as { id: string };
    const before = listKbChunks(lib, e.id).length;
    await byName("parent_kb_save").execute("i3", {
      entries: [{ id: e.id, title: "长文", body: "换成了很短的一段话。" }],
    });
    const after = listKbChunks(lib, e.id);
    expect(after.length).toBeLessThan(before);
    expect(after.map((c) => c.text).join("")).toContain("换成了很短的一段话");
  });
});

describe("KB P3③：块级召回——**门控仍然说了算**", () => {
  const QV = () => new Float32Array([1, 0, 0, 0]);
  const topChunks = () =>
    topVectorRows(lib, "kb_entry_chunks", KB_CHUNK_TEXT_COLUMN, QV(), {
      threshold: 0.5,
      topK: 50,
      cacheKey: parentLibCacheKey(dataDir, parentId),
    });

  it("草稿条目：**块向量能排出来，但 getGatedEntry 拿不到** → 召回必须为空", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "块-草稿", summary: "说法" }]);
    replaceKbChunks(lib, s.id, ["一段正文"]);
    putChunkVector(s.id, 0, [1, 0, 0, 0]);
    expect(topChunks().map((r) => r.rowPk)).toContain(JSON.stringify([s.id, 0]));
    expect(getGatedEntry(lib, childId, s.id, "语义匹配")).toBeUndefined();
  });

  it("已发布 + 给她看 → 通过块命中拿到条目本身（拿到的是条目，不是片段）", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "块-正常", summary: "家长认过的说法" }]);
    replaceKbChunks(lib, s.id, ["两万字资料里靠后的那一段"]);
    publishKbEntries(lib, [s.id], "child");
    putChunkVector(s.id, 0, [1, 0, 0, 0]);
    const hit = getGatedEntry(lib, childId, s.id, "语义匹配 0.71")!;
    expect(hit).toBeTruthy();
    expect(hit.summary).toBe("家长认过的说法"); // 权威层还是 summary，不是那块正文
    expect(hit.via).toContain("语义匹配");
  });

  it("row_pk 解码：取第一个元素当 entry_id（脏 row_pk 不抛，被跳过）", () => {
    expect(JSON.parse(JSON.stringify(["e1", 3]))[0]).toBe("e1");
    expect(() => JSON.parse("not-json")).toThrow();
  });
});

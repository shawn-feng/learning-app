/**
 * KB P3 阶段②（2026-09-25）：**入库管道**——把资料读成文字收进条目。
 *
 * 要钉住的**边界**比"能不能提取"重要：
 *
 * 1. **提取产物永远不是权威**。方案 §3.4.1 的结论是硬的：提取只能产出「描述」，产不出「指令」——
 *    所以提取结果**只能进 `body`**，`summary` 永远留给家长口述；`kb_lookup` 也**从不返回 `body`**。
 *    本文件里"`body` 不算『有内容』"那条断言就是这条边界的代码化：**只有正文的条目必须被拒**
 *    （否则会出现一条孩子问到时什么都拿不到的条目）。
 * 2. **`body` 的更新语义**：`undefined` = 不改动库里已有的正文。提取是"花过成本"的产物，
 *    不能因为一次只改 `aliases` 的更新就被清空。
 * 3. **不支持的格式如实报错**，并给出可操作的下一步——**绝不返回空正文**让上游以为成功了。
 * 4. **灌进已有条目时不许改名**（`saveKbEntries` 会把 title 一起更新，传文件名当标题就等于顺手改了家长的条目名）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import { getKbEntry, listKbAssets, saveKbEntries } from "../server/src/db/kb-entries";
import { createParentKbTools } from "../server/src/agent/parent-kb-tools";
import { KB_BODY_MAX, decodeEntities, htmlToText, ingestKindOf, textify } from "../server/src/agent/kb-ingest";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-ing-"));
const parentId = "p-kb-ing";

const main = openDb(dataDir);
const nowIso = new Date().toISOString();
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "ing@test", nowIso, nowIso);
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
fs.writeFileSync(
  path.join(root, "preqin", "甲骨文.html"),
  `<!doctype html><html><head><title>甲骨文小知识</title>
   <style>body{color:red}</style><script>var secret="不该进正文";alert(1)</script></head>
   <body><!-- 注释也不该进 --><h1>甲骨文</h1><p>商朝人把占卜结果刻在龟甲上。</p>
   <ul><li>龟甲</li><li>兽骨</li></ul>
   <table><tr><td>朝代</td><td>商</td></tr></table>
   <p>这家&amp;那家&nbsp;都用&mdash;它</p></body></html>`
);
fs.writeFileSync(path.join(root, "preqin", "笔记.md"), "# 标题\n\n- 要点一\n- 要点二\n");
fs.writeFileSync(path.join(root, "preqin", "说明.txt"), "这是纯文本说明。\n");
fs.writeFileSync(path.join(root, "preqin", "讲义.pdf"), "%PDF-1.4 fake");

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");
const tools: any[] = createParentKbTools({ dataDir, parentId, db: main });
const byName = (n: string) => tools.find((t) => t.name === n)!;

describe("KB P3②：文本化的取舍（纯函数，不碰盘）", () => {
  it("支持的格式：html/htm/md/txt；其余返回 null（调用方给可操作的话）", () => {
    expect(ingestKindOf("preqin/a.html")).toBe("html");
    expect(ingestKindOf("preqin/a.HTM")).toBe("html");
    expect(ingestKindOf("preqin/a.md")).toBe("md");
    expect(ingestKindOf("preqin/a.txt")).toBe("txt");
    expect(ingestKindOf("preqin/a.pdf")).toBeNull();
    expect(ingestKindOf("preqin/a.jpg")).toBeNull();
  });

  it("**先删 script/style/注释再剥标签**（反过来会把 js 源码当正文灌进 body）", () => {
    const t = htmlToText(`<style>body{color:red}</style><script>var secret="不该进正文"</script><!-- 注释也不该进 --><p>正文</p>`);
    expect(t).toContain("正文");
    expect(t).not.toContain("secret");
    expect(t).not.toContain("color:red");
    expect(t).not.toContain("注释也不该进");
  });

  it("块级标签换成换行（否则整页挤成一行，可读性与分块都废）", () => {
    const t = htmlToText("<h1>甲骨文</h1><p>第一段</p><ul><li>龟甲</li><li>兽骨</li></ul>");
    expect(t.split("\n").filter(Boolean)).toEqual(["甲骨文", "第一段", "龟甲", "兽骨"]);
  });

  it("单元格之间给分隔，别把两列粘成一个词", () => {
    // 分隔最终会与其他空白一起折叠成单个空格——要的是"不粘连"，不是保留制表符
    expect(htmlToText("<table><tr><td>朝代</td><td>商</td></tr></table>")).toBe("朝代 商");
  });

  it("实体解码（含命名实体与数字实体）", () => {
    expect(decodeEntities("a&amp;b&nbsp;c&mdash;d")).toBe("a&b c—d");
    expect(decodeEntities("&#65;&#x42;")).toBe("AB");
    expect(htmlToText("<p>这家&amp;那家</p>")).toBe("这家&那家");
  });

  it("md/txt 原样（只 trim），不擅自改写家长的文本", () => {
    expect(textify("# 标题\n\n- 要点一\n", "a.md").text).toBe("# 标题\n\n- 要点一");
    expect(textify("  纯文本  \n", "a.txt").text).toBe("纯文本");
  });

  it("**超长截断并标出来**（上游要如实告诉家长「只收了前 N 字」）", () => {
    const r = textify("字".repeat(KB_BODY_MAX + 500), "a.txt");
    expect(r.text.length).toBe(KB_BODY_MAX);
    expect(r.truncated).toBe(true);
    expect(r.chars).toBe(KB_BODY_MAX);
    expect(textify("短", "a.txt").truncated).toBe(false);
  });

  it("**不支持的格式如实报错**，并给出可操作的下一步（绝不返回空正文）", () => {
    expect(() => textify("x", "preqin/讲义.pdf")).toThrow(/PDF/);
    expect(() => textify("x", "preqin/讲义.pdf")).toThrow(/口述/); // 给出路：让家长口述成一句说法
    expect(() => textify("x", "preqin/照片.jpg")).toThrow(/还不能自动读成文字/);
  });
});

describe("KB P3②：`body` 的落库与更新语义", () => {
  it("新建时可写 body", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "有正文", summary: "说法", body: "提取来的正文" }]);
    expect(getKbEntry(lib, s.id)!.id).toBe(s.id);
    const row = lib.prepare("SELECT body FROM kb_entries WHERE id = ?").get(s.id) as { body: string };
    expect(row.body).toBe("提取来的正文");
  });

  it("**更新时不传 body → 库里已有正文保留**（不能因为只改 aliases 就清空提取成果）", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "保留正文", summary: "说法", body: "原始正文" }]);
    saveKbEntries(lib, dataDir, parentId, [{ id: s.id, title: "保留正文", summary: "说法", aliases: "别名A" }]);
    const row = lib.prepare("SELECT body, aliases FROM kb_entries WHERE id = ?").get(s.id) as { body: string; aliases: string };
    expect(row.body).toBe("原始正文");
    expect(row.aliases).toBe("别名A");
  });

  it("显式传空字符串 → 才清空", () => {
    const [s] = saveKbEntries(lib, dataDir, parentId, [{ title: "清空正文", summary: "说法", body: "要清掉" }]);
    saveKbEntries(lib, dataDir, parentId, [{ id: s.id, title: "清空正文", summary: "说法", body: "" }]);
    expect((lib.prepare("SELECT body FROM kb_entries WHERE id = ?").get(s.id) as { body: string }).body).toBe("");
  });

  it("**只有 body、既没说法也没资料 → 必须拒绝**（正文不算『有内容』：孩子问到时什么都拿不到）", () => {
    expect(() => saveKbEntries(lib, dataDir, parentId, [{ title: "只有正文", body: "一堆提取文本" }])).toThrow(
      /既没有 summary 也没有资料/
    );
  });
});

describe("KB P3②：家长工具上的 ingest", () => {
  it("读一份 html → 新建草稿条目 + 挂上原文件，正文已去脚本/样式", async () => {
    const out = text(await byName("parent_kb_save").execute("i1", { ingest: [{ path: "preqin/甲骨文.html" }] }));
    expect(out).toMatch(/读成文字收进条目/);
    expect(out).toMatch(/仍是草稿/);
    expect(out).toMatch(/不是「该怎么说」/); // 边界必须说出来
    const e = getKbEntry(lib, "甲骨文");
    expect(e).toBeTruthy();
    expect(e!.status).toBe("draft");
    expect(e!.visibility).toBe("parent");
    const body = (lib.prepare("SELECT body FROM kb_entries WHERE id = ?").get(e!.id) as { body: string }).body;
    expect(body).toContain("商朝人把占卜结果刻在龟甲上");
    expect(body).not.toContain("secret");
    expect(listKbAssets(lib, e!.id).map((a) => a.path)).toEqual(["preqin/甲骨文.html"]);
  });

  it("md / txt 也能收", async () => {
    await byName("parent_kb_save").execute("i2", { ingest: [{ path: "preqin/笔记.md" }, { path: "preqin/说明.txt" }] });
    expect(getKbEntry(lib, "笔记")).toBeTruthy();
    expect(getKbEntry(lib, "说明")).toBeTruthy();
  });

  it("指定 title 时用它当条目标题（缺省才取文件名）", async () => {
    await byName("parent_kb_save").execute("i3", { ingest: [{ path: "preqin/说明.txt", title: "家里那份说明" }] });
    expect(getKbEntry(lib, "家里那份说明")).toBeTruthy();
  });

  it("**灌进已有条目：正文写进去、标题不被文件名改掉**", async () => {
    await byName("parent_kb_save").execute("i4", { entries: [{ title: "已有条目", summary: "家长的说法" }] });
    await byName("parent_kb_save").execute("i5", { ingest: [{ path: "preqin/笔记.md", entry_title: "已有条目" }] });
    const e = getKbEntry(lib, "已有条目")!;
    expect(e.title).toBe("已有条目"); // 没被"笔记.md"改名
    expect(e.summary).toBe("家长的说法"); // 说法没被动
    const body = (lib.prepare("SELECT body FROM kb_entries WHERE id = ?").get(e.id) as { body: string }).body;
    expect(body).toContain("要点一");
  });

  it("灌进不存在的条目 → 报错并指路（不静默新建一条同名的）", async () => {
    await expect(
      byName("parent_kb_save").execute("i6", { ingest: [{ path: "preqin/笔记.md", entry_title: "根本没有这条" }] })
    ).rejects.toThrow(/条目不存在/);
  });

  it("资料不存在 / 不支持格式 → 都报错，且都不是空正文", async () => {
    await expect(byName("parent_kb_save").execute("i7", { ingest: [{ path: "preqin/没有这个.html" }] })).rejects.toThrow(
      /资料不存在/
    );
    await expect(byName("parent_kb_save").execute("i8", { ingest: [{ path: "preqin/讲义.pdf" }] })).rejects.toThrow(/PDF/);
  });

  it("**同一次调用里同时给 entries 与 ingest → 必须只落一次库**（实测踩到的 bug：分两次落库时，`entries` 那条在没有资产的自己那一趟里被「至少要有一样」拒掉）", async () => {
    const out = text(
      await byName("parent_kb_save").execute("i10", {
        entries: [{ title: "恐龙小知识（资料）", aliases: "恐龙小资料", usage: "只让她看撞击那一段" }],
        ingest: [{ path: "preqin/甲骨文.html", title: "恐龙小知识（资料）" }],
      })
    );
    const e = getKbEntry(lib, "恐龙小知识（资料）")!;
    expect(e).toBeTruthy();
    expect(e.usage).toBe("只让她看撞击那一段"); // entries 那部分生效了
    const body = (lib.prepare("SELECT body FROM kb_entries WHERE id = ?").get(e.id) as { body: string }).body;
    expect(body).toContain("商朝人把占卜结果刻在龟甲上"); // ingest 那部分也生效了
    expect(listKbAssets(lib, e.id).map((a) => a.path)).toEqual(["preqin/甲骨文.html"]);
    // 消息里两件事都要说清：这是资料、不是说法
    expect(out).toMatch(/读成文字收进条目/);
    expect(out).toMatch(/不是「该怎么说」/);
  });

  it("五个参数一个都不给 → 报错文案要把 ingest 也列上", async () => {
    await expect(byName("parent_kb_save").execute("i9", {})).rejects.toThrow(/ingest/);
  });
});

describe("KB P3②：backfill（顺手补建缺失的向量）", () => {
  it("parent_kb_list 不因 backfill 出错，且在有条目缺向量时报告补建条数", async () => {
    // 本用例里没有任何 embeddings 行（测试环境没有 embedding 凭证，markStale 会静默退出），
    // 所以"缺向量"的条目就是全部条目 → 清单里应出现补建提示，且清单本身照常返回。
    const out = text(await byName("parent_kb_list").execute("l1", {}));
    expect(out).toMatch(/知识库条目/);
    expect(out).toMatch(/顺手补建了 \d+ 条条目的语义检索索引/);
  });

  it("没有 deps.db 时静默跳过（功能降级为纯精确匹配，清单不受影响）", async () => {
    const noDb = createParentKbTools({ dataDir, parentId });
    const t = noDb.find((x: any) => x.name === "parent_kb_list")!;
    const out = text(await (t as any).execute("l2", {}));
    expect(out).toMatch(/知识库条目/);
    expect(out).not.toMatch(/顺手补建/);
  });
});

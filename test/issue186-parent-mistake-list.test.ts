/**
 * ISSUE-186 F1 回归（2026-10-16）：家长侧**错题/生字逐条清单** `parent_child_mistake_list`。
 *
 * 背景：错题本此前只有聚合口径（`parent_child_mastery_report` 按 kind 聚合、只展开 count 前 3），
 * 家长 agent 拿不到"这周错了哪些字 / 哪些字掌握得不好 / 哪个字错得最多 / 哪些还没题可考"。
 * 本工具＝界面上「错题本」那一页的同款口径（逐条 + 次数 + 首记/最近 + 有没有题可考）。
 *
 * 覆盖：默认 open、时间窗（days/since）、newOnly（按 first_seen）、order=count + minCount、
 * unlinked（补题清单）、limit 截断提示、多孩子不传 child 必须问、kind 过滤、非法参数报错。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { upsertMistake } from "../server/src/db/mistakes";
import { createParentChildReportTools } from "../server/src/agent/parent-child-report-tools";
import {
  attachGeneratedQuestion,
  ensureKnowledgePoint,
  ensureSortingCourse,
  WORD_COURSE,
} from "../server/src/worker/mistake-sorting";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue186-f1-"));
const parentId = "parent-186f1";
const multiParentId = "parent-186f1m";
/** 与下方 `children` 播种保持一致（`${pid}-c1`）——否则错题会写进另一本孩子库 */
const childId = `${parentId}-c1`;
const NOW = new Date().toISOString();
const p2 = (n: number) => String(n).padStart(2, "0");
const dayStr = (offsetDays: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

const db = openDb(dataDir);
for (const [pid, name] of [
  [parentId, "珊珊"],
  [multiParentId, "珊珊"],
] as const) {
  db.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(pid, `${pid}@t`, NOW, NOW);
  db.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(
    `${pid}-c1`,
    pid,
    name,
    NOW,
    NOW
  );
}
db.prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)").run(
  `${multiParentId}-c2`,
  multiParentId,
  "乐乐",
  NOW,
  NOW
);

// —— 家长库：错题整理/字词 课 → 「验」有题、「迫」没题 ——
const kpIds = (() => {
  const pl = openParentLib(dataDir, parentId);
  try {
    const cu = ensureSortingCourse(pl, WORD_COURSE);
    const kpWithQ = ensureKnowledgePoint(pl, cu, "验", "检验、验证");
    const kpNoQ = ensureKnowledgePoint(pl, cu, "迫", "紧迫、逼迫");
    attachGeneratedQuestion(pl, cu, kpWithQ, { stem: "「验」是什么意思？请用「验」说一句话。", answer: "检验" });
    return { withQ: kpWithQ, noQ: kpNoQ };
  } finally {
    pl.close();
  }
})();

// —— 孩子库错题：三条（不同 kind / 次数 / 日期 / 有没有题）——
const rows = {
  验: upsertMistake(dataDir, parentId, childId, {
    kind: "unknown_word",
    content: "验",
    detail: "检验",
    source: "lookup",
    course_ref: WORD_COURSE,
    knowledge_point_id: kpIds.withQ,
    knowledge_point_name: "验",
  }),
  迫: upsertMistake(dataDir, parentId, childId, {
    kind: "unknown_word",
    content: "迫",
    detail: "紧迫",
    source: "lookup",
    course_ref: WORD_COURSE,
    knowledge_point_id: kpIds.noQ,
    knowledge_point_name: "迫",
  }),
  错题: upsertMistake(dataDir, parentId, childId, {
    kind: "wrong_question",
    content: "「不亦说乎」的意思",
    detail: "通假字，读 yuè",
    source: "conversation",
    course_ref: "学而第一",
  }),
};
// 次数 + 日期（第一条 3 次/首记 10 天前/最近今天；第二条 5 次/首记 2 天前/最近昨天；错题 20 天前）
function setRow(content: string, count: number, firstSeen: string, lastSeen: string): void {
  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("UPDATE mistake_book SET count = ?, first_seen = ?, last_seen = ? WHERE content = ?").run(
      count,
      `${firstSeen} 10:00:00`,
      `${lastSeen} 10:00:00`,
      content
    );
  } finally {
    kb.close();
  }
}
setRow("验", 3, dayStr(-10), dayStr(0));
setRow("迫", 5, dayStr(-2), dayStr(-1));
setRow("「不亦说乎」的意思", 1, dayStr(-20), dayStr(-20));

const tools = createParentChildReportTools({ db, dataDir, parentId });
const tool: any = tools.find((t) => t.name === "parent_child_mistake_list")!;

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}
const run = async (params: Record<string, unknown>) => toolText(await tool.execute("x", params));

afterAll(() => {
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL */
  }
});

describe("ISSUE-186 F1 · parent_child_mistake_list", () => {
  it("默认：只看 open、不限时间、逐条带次数与首记/最近、课程/知识点、有没有题可考", async () => {
    const text = await run({ child: "珊珊" });
    expect(text).toContain("共 3 条");
    expect(text).toContain("生字「验」×3");
    expect(text).toContain(`首记 ${dayStr(-10)} / 最近 ${dayStr(0)}`);
    expect(text).toContain("生字「迫」×5");
    expect(text).toContain(`课程：${WORD_COURSE}`);
    expect(text).toContain("知识点：迫");
    // 「验」有题 → 不带 ⚠；「迫」与那条错题都没题可考
    const yanLine = text.split("\n").find((l) => l.includes("「验」"))!;
    expect(yanLine).not.toContain("还没题可考");
    expect(text.split("\n").find((l) => l.includes("「迫」"))!).toContain("还没题可考");
    expect(text).toContain("还没有题可考** 2 条");
    expect(text).toContain("反复出现（≥3 次）2 条");
  });

  it("时间窗：days=7 排除 20 天前那条；newOnly 按首次记录再看", async () => {
    const week = await run({ child: "珊珊", days: 7 });
    expect(week).toContain("共 2 条");
    expect(week).not.toContain("不亦说乎");
    const fresh = await run({ child: "珊珊", newOnly: true });
    expect(fresh).toContain("共 1 条");
    expect(fresh).toContain("「迫」");
    expect(fresh).not.toContain("「验」"); // 验首记在 10 天前 → 不是本周新增
  });

  it("掌握维度：order=count 按次数排 + minCount 只看反复错的", async () => {
    const byCount = await run({ child: "珊珊", order: "count" });
    const lines = byCount.split("\n").filter((l) => l.startsWith("- "));
    expect(lines[0]).toContain("「迫」");
    expect(lines[1]).toContain("「验」");
    const heavy = await run({ child: "珊珊", order: "count", minCount: 4 });
    expect(heavy).toContain("共 1 条");
    expect(heavy).toContain("出现 ≥4 次");
  });

  it("unlinked=true → 只剩还没题可考的（补题清单）", async () => {
    const text = await run({ child: "珊珊", unlinked: true });
    expect(text).toContain("共 2 条");
    expect(text).toContain("「迫」");
    expect(text).toContain("不亦说乎");
    expect(text).not.toContain("「验」");
    expect(text).toContain("只看没题可考");
  });

  it("kind 过滤 + limit 截断提示", async () => {
    const words = await run({ child: "珊珊", kind: "unknown_word" });
    expect(words).toContain("共 2 条");
    expect(words).not.toContain("不亦说乎");
    const one = await run({ child: "珊珊", limit: 1 });
    expect(one).toContain("另有 2 条未列出");
  });

  it("多孩子不传 child → 必须问清（不猜）；非法 kind/status 报可读错", async () => {
    const multi = createParentChildReportTools({ db, dataDir, parentId: multiParentId }).find(
      (t) => t.name === "parent_child_mistake_list"
    )! as any;
    await expect(multi.execute("x", {})).rejects.toThrow(/要看哪个孩子/);
    await expect(tool.execute("x", { kind: "生字" })).rejects.toThrow(/kind 只能是/);
    await expect(tool.execute("x", { status: "opened" })).rejects.toThrow(/status 只能是/);
  });

  it("没有符合条件的记录时给明确空态（不吐空表）", async () => {
    const text = await run({ child: "珊珊", kind: "weak_point" });
    expect(text).toContain("没有符合条件的记录");
  });
});

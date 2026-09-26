/**
 * parent_content（2026-09-25 改版）回归：**准备一节课只需一次工具调用**。
 *
 * 背景：原来「这节课怎么上」靠两处——`parent_content` 分四次调（method / teachingCopy /
 * assessRubric / htmlPath），另有 KB P2 的「进课推送」把挂课条目注进 system prompt。
 * 用户 2026-09-25 定：**推送取消**（一节准备材料 = 教学方法 + 教学文案，本来就在文案与方法里），
 * 改成**工具层一次读出**：`type` 缺省=lesson，一次拿全四段。
 *
 * 这份测试钉住：
 * 1. `type` 缺省（或显式 lesson）一次返回四段：教学方法 / 教学文案 / 考核要点 / 学习资料；
 * 2. **缺项不抛错**——逐项写明"家长未填写"，让孩子能继续上课（而不是因为少填一段整节课卡住）；
 * 3. 课程不存在仍然报错，并把"先列课程名"的下一步说清楚；
 * 4. 单项 type（method / htmlPath）仍可用（补读、单独核对）；
 * 5. 工具描述里 lesson 是**明写的缺省**（模型不看描述就会退化成四次调用——那是这次要消掉的浪费）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openParentLib } from "../server/src/db/parent-lib";
import { openKb } from "../server/src/db/kb";
import { createParentContentTool } from "../server/src/agent/plan-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-lesson-"));
const parentId = "p-pc-lesson";
const childId = "c-pc-lesson";

const METHOD = "每课统一流程：先抛 2~3 个思考问题 → 看片 → 孩子自己讲一遍 → 对关键点。";
const COPY = "思考问题：1. 地势西高东低是怎么形成的？2. 青藏高原为什么那么高？";
const RUBRIC = "讲全关键点即通过：印度板块碰撞 / 三级阶梯 / 亚洲水塔。";
const HTML = "preqin/第一课 中国从哪里来.html";

{
  const lib = openParentLib(dataDir, parentId);
  lib.prepare("INSERT INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("先秦", "preqin", METHOD);
  lib
    .prepare(
      "INSERT INTO courses (topic, title, sort_order, teaching_copy, assess_rubric, html_path) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run("preqin", "第一课 夏商周", 1, COPY, RUBRIC, HTML);
  // 只填了名字的课：课级四段全空，用来验证"缺项不抛错"
  lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, ?)").run("preqin", "第二课 秦汉", 2);
  // 另一个主题：连主题级教学方法也没填（验证方法段的占位）
  lib.prepare("INSERT INTO topics (name, topic_key) VALUES (?, ?)").run("空白主题", "kongbai");
  lib.prepare("INSERT INTO courses (topic, title, sort_order) VALUES (?, ?, ?)").run("kongbai", "第一节", 1);
  lib.close();
}

afterAll(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const tool: any = createParentContentTool({ dataDir, parentId, childId });
const call = async (params: Record<string, unknown>) => {
  const r = await tool.execute("t", params);
  return (r?.content ?? []).map((c: any) => c.text).join("");
};

describe("parent_content：type 缺省 = lesson（一次拿全）", () => {
  it("不传 type → 四段齐全，且资料段带 display_content 用法", async () => {
    const out = await call({ topic: "preqin", course: "第一课 夏商周" });
    expect(out).toContain("## 课程：第一课 夏商周");
    expect(out).toContain("### 教学方法");
    expect(out).toContain(METHOD);
    expect(out).toContain("### 教学文案");
    expect(out).toContain(COPY);
    expect(out).toContain("### 考核要点");
    expect(out).toContain(RUBRIC);
    expect(out).toContain("### 学习资料");
    expect(out).toContain(HTML);
    expect(out).toContain("display_content");
  });

  it("显式 type=lesson 与缺省等价；topic 给中文名也能归一", async () => {
    const a = await call({ type: "lesson", topic: "preqin", course: "第一课 夏商周" });
    const b = await call({ topic: "先秦", course: "第一课 夏商周" });
    expect(a).toBe(b);
    expect(b).toContain("主题 preqin");
  });

  it("**缺项不抛错**：课级缺项逐段写明「家长未填写」，课还能继续上", async () => {
    const out = await call({ topic: "preqin", course: "第二课 秦汉" });
    // 教学方法是**主题级**的，这个主题填过 → 照常带出来（不是缺项）
    expect(out).toContain(METHOD);
    expect(out).toContain("家长未填写教学文案");
    expect(out).toContain("家长未填写考核要点");
    expect(out).toContain("本课未登记 html 学习资料");
  });

  it("连主题级教学方法都没填 → 方法段也给占位（并写明不要编造边界）", async () => {
    const out = await call({ topic: "kongbai", course: "第一节" });
    expect(out).toContain("### 教学方法");
    expect(out).toContain("家长未填写教学方法");
    // 占位必须带"不要编造"的边界，否则模型会自己补具体数字/人名
    expect(out).toMatch(/不要编造具体数字、人名、引文/);
  });

  it("课程不存在 → 报错并把下一步（先列课程名）说清楚", async () => {
    await expect(call({ topic: "preqin", course: "第九课 不存在" })).rejects.toThrow(/未找到课程/);
    await expect(call({ topic: "preqin", course: "第九课 不存在" })).rejects.toThrow(/kb_query/);
  });

  it("lesson 仍需要 course（拿不到是哪节课就不该猜）", async () => {
    await expect(call({ topic: "preqin" })).rejects.toThrow(/需要 course/);
  });
});

describe("parent_content：单项 type 仍可用（补读 / 单独核对）", () => {
  it("type=method 只回教学方法全文", async () => {
    expect(await call({ type: "method", topic: "preqin" })).toBe(METHOD);
  });

  it("type=htmlPath 只回资料路径", async () => {
    expect(await call({ type: "htmlPath", topic: "preqin", course: "第一课 夏商周" })).toBe(HTML);
  });

  it("单项缺项依旧报错（这条路是「明确要一项」，缺了就该说清，而不是给占位）", async () => {
    await expect(call({ type: "teachingCopy", topic: "preqin", course: "第二课 秦汉" })).rejects.toThrow(
      /尚未填写教学文案/
    );
  });
});

describe("parent_content：工具描述把 lesson 写成明写的缺省", () => {
  it("描述里点明 type 缺省=lesson、且不要分四次调用", () => {
    expect(tool.description).toContain("type=lesson");
    expect(tool.description).toContain("缺省");
    expect(tool.description).toMatch(/不要.*分四次/);
  });

  it("type 参数是可选的（模型漏传也能跑）", () => {
    expect(tool.parameters?.properties?.type).toBeTruthy();
    expect(tool.parameters?.required ?? []).not.toContain("type");
  });
});

describe("parent_content lesson 第五段：上次掌握与教学建议（ISSUE-135 P5）", () => {
  it("孩子库有掌握记录 → 档位/累计/建议/待巩固知识点齐全；没有 → 暂无占位且不抛错", async () => {
    // 有数据的课：孩子库 courses 掌握四列 + knowledge_point_progress 待巩固项
    const kb = openKb(dataDir, parentId, childId);
    try {
      kb.prepare(
        "INSERT OR REPLACE INTO courses (topic, topic_key, title, uuid, sort_order, mastery_level, mastery_desc, teaching_advice, mastery_updated_at) VALUES ('preqin','preqin','第一课 夏商周','',1,'needs_review','最开始只能复述原文；最新能自己举例','先用身边例子讲清『世袭』，再让孩子复述','2026-09-26T21:30:00.000Z')"
      ).run();
      kb.prepare(
        "INSERT INTO knowledge_point_progress (parent_id, child_id, knowledge_point_id, knowledge_point_name, course_uuid, course_name, level, mastery_desc, study_count, exam_count, first_at, last_at, updated_at) VALUES (?,?,?,?,?,'第一课 夏商周','needs_review','把『世袭』和『禅让』讲混',1,0,'2026-09-20','2026-09-26','2026-09-26')"
      ).run(parentId, childId, "kp-pc-1", "世袭制", "uuid-pc-1");
    } finally {
      kb.close();
    }
    const out = await call({ topic: "preqin", course: "第一课 夏商周" });
    expect(out).toContain("### 上次掌握与教学建议");
    expect(out).toContain("待巩固");
    expect(out).toContain("最新能自己举例");
    expect(out).toContain("先用身边例子讲清『世袭』");
    expect(out).toContain("待巩固知识点：世袭制");

    // 没数据的课（同主题第二课）：占位、不抛错、教学可继续
    const out2 = await call({ topic: "preqin", course: "第二课 秦汉" });
    expect(out2).toContain("暂无掌握评估记录");
    expect(out2).toContain("### 学习资料");
  });
});
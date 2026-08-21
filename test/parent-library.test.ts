import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron：打桩 app，使 config 走 process.cwd()/data（同 learning-summary.test）。
vi.mock("electron", () => ({ app: undefined }));

// 把 config 的 data 根指向临时目录，避免触碰真实 data/parents 与 data/children。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parent-lib-"));
vi.mock("../electron/lib/config", () => ({
  getDataDir: () => mockTmpRoot,
  getChildrenDir: () => path.join(mockTmpRoot, "children"),
  getSharedDir: () => path.join(mockTmpRoot, "shared"),
  getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
}));

import {
  allocateTopicToChild,
  copyMaterialIntoParent,
  deleteParentCourse,
  getParentContentForChild,
  listChildAllocatedTopics,
  listParentMaterials,
  listParentTopics,
  listParentTopicCourses,
  migrateChildrenToParent,
  moveParentCourse,
  readParentMaterial,
  upsertParentCourse,
  upsertParentTopic,
} from "../electron/lib/parent-library";
import { insertCourse, openKbDb, queryTopicProgress, queryTopicsMeta } from "../electron/lib/kb-sqlite";

const CHILD = "test-child-001";

beforeEach(() => {
  // 每个用例前清空临时根，保证幂等
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  fs.mkdirSync(path.join(mockTmpRoot, "children"), { recursive: true });
});

afterAll(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
});

describe("ISSUE-029 家长库（主题统一管理 + 快照分配 + 存量迁移）", () => {
  it("upsertParentTopic 存 method 全文；listParentTopics 返回主题与资料数", () => {
    upsertParentTopic(
      "default",
      { name: "论语", file: "lunyu", method: "# 教学方法全文\n\n1. 先读\n2. 再背" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读+讲解", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    const topics = listParentTopics("default");
    expect(topics.length).toBe(1);
    const t = topics[0];
    expect(t.name).toBe("论语");
    expect(t.file).toBe("lunyu");
    expect(t.method).toContain("教学方法全文"); // 全文入库，不是文件链接
    expect(t.total).toBe(1);
  });

  it("listParentTopicCourses 返回每课的 lesson_method 与 html_path", () => {
    upsertParentTopic(
      "default",
      { name: "论语", file: "lunyu", method: "m" },
      [
        { title: "论语学而篇第一章", lessonMethod: "朗读+讲解", htmlPath: "materials/lunyu/论语学而篇第一章.html" },
        { title: "论语学而篇第二章", lessonMethod: "跟读", htmlPath: "materials/lunyu/论语学而篇第二章.html" },
      ]
    );
    const courses = listParentTopicCourses("default", "lunyu");
    expect(courses.length).toBe(2);
    const first = courses.find((c) => c.title.includes("第一章"))!;
    expect(first.lessonMethod).toBe("朗读+讲解");
    expect(first.htmlPath).toContain("materials");
    // 家长库课程不带进度（status 一律 ⬜）
    expect(first.status).toBe("⬜");
  });

  it("allocateTopicToChild 快照拷贝主题进孩子库；重复分配不丢孩子进度", () => {
    upsertParentTopic(
      "default",
      { name: "论语", file: "lunyu", method: "# 方法全文" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    fs.mkdirSync(childDir, { recursive: true });
    // 孩子已有该课且已学（进度需保留）
    insertCourse(childDir, { topic: "lunyu", title: "论语学而篇第一章", status: "✅", mastery: "良好" });

    const r1 = allocateTopicToChild("default", CHILD, "lunyu");
    expect(r1.copied).toBe(0); // 已存在 → 不覆盖
    expect(r1.existing).toBe(1);

    // 验证孩子库里课程进度仍在、内容字段已补齐（lesson_method/html_path），但 method/teaching_copy 不拷贝
    const detail = queryTopicProgress(childDir, "lunyu");
    const c = detail[0].items[0];
    expect(c.status).toBe("✅"); // 进度未丢
    expect(c.mastery).toBe("良好");
    expect(c.lessonMethod).toBe("朗读"); // 内容已从父库快照补齐
    expect(c.htmlPath).toContain("lunyu/论语学而篇第一章.html");
    // ISSUE-029：孩子库不存教学方法与教学文案（经 parent_content 工具从家长库取）
    expect(c.teachingCopy).toBe("");
    const metas = queryTopicsMeta(childDir);
    expect(metas.find((m: any) => m.name === "论语")?.method).toBe("");
  });

  it("getParentContentForChild 从家长库取 method/teachingCopy；未分配主题拒绝", () => {
    upsertParentTopic(
      "default",
      { name: "论语", file: "lunyu", method: "# 论语教法全文\n\n三步教学" },
      [
        {
          title: "论语学而篇第一章",
          lessonMethod: "朗读",
          teachingCopy: "# 学而时习之\n\n子曰：学而时习之……",
          htmlPath: "materials/lunyu/论语学而篇第一章.html",
        },
      ]
    );
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    fs.mkdirSync(childDir, { recursive: true });

    // 未分配 → 拒绝
    expect(getParentContentForChild(CHILD, "lunyu", "method").found).toBe(false);

    // 分配后 → 可取 method / teachingCopy / htmlPath（内容在家长库，孩子库为空）
    allocateTopicToChild("default", CHILD, "lunyu");
    const m = getParentContentForChild(CHILD, "lunyu", "method");
    expect(m.found).toBe(true);
    expect(m.content).toContain("论语教法全文");
    const t = getParentContentForChild(CHILD, "lunyu", "teachingCopy", "论语学而篇第一章");
    expect(t.found).toBe(true);
    expect(t.content).toContain("学而时习之");

    // htmlPath：文件不存在时返回 not found（不返回失效指针）
    expect(getParentContentForChild(CHILD, "lunyu", "htmlPath", "论语学而篇第一章").found).toBe(false);
    // 造出 html 文件后 → 返回家长库相对路径，可直接传给 display_content
    const src = path.join(mockTmpRoot, "论语学而篇第一章.html");
    fs.writeFileSync(src, "<html/>", "utf-8");
    copyMaterialIntoParent("default", "lunyu", src);
    const h = getParentContentForChild(CHILD, "lunyu", "htmlPath", "论语学而篇第一章");
    expect(h.found).toBe(true);
    expect(h.content).toBe("materials/lunyu/论语学而篇第一章.html");

    // 未分配的其他主题 → 拒绝
    expect(getParentContentForChild(CHILD, "english", "method").found).toBe(false);
  });

  it("listChildAllocatedTopics 返回孩子已添加的主题（无库孩子返回空）", () => {
    upsertParentTopic(
      "default",
      { name: "论语", file: "lunyu", method: "# 方法全文" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    fs.mkdirSync(childDir, { recursive: true });
    // 未分配前：无 kb.sqlite → 空
    expect(listChildAllocatedTopics(CHILD)).toEqual([]);
    // 分配后：返回该主题（file=目录名）
    allocateTopicToChild("default", CHILD, "lunyu");
    const list = listChildAllocatedTopics(CHILD);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("论语");
    expect(list[0].file).toBe("lunyu");
  });

  it("upsertParentCourse / deleteParentCourse 维护家长库课程（只动内容字段）", () => {
    upsertParentCourse("default", "lunyu", {
      title: "论语学而篇第一章",
      lessonMethod: "朗读+讲解",
      teachingCopy: "# 学而时习之\n\n原文与讲解……",
      htmlPath: "materials/lunyu/论语学而篇第一章.html",
    });
    let courses = listParentTopicCourses("default", "lunyu");
    expect(courses.length).toBe(1);
    expect(courses[0].lessonMethod).toBe("朗读+讲解");
    expect(courses[0].teachingCopy).toContain("学而时习之");
    expect(courses[0].status).toBe("⬜"); // 家长库不带进度

    // 更新内容字段：只覆盖传入的非空字段，html_path/teachingCopy 保留旧值
    upsertParentCourse("default", "lunyu", {
      title: "论语学而篇第一章",
      lessonMethod: "朗读+讲解+跟读",
    });
    courses = listParentTopicCourses("default", "lunyu");
    expect(courses[0].lessonMethod).toBe("朗读+讲解+跟读");
    expect(courses[0].htmlPath).toContain("materials"); // 未传字段保留旧值
    expect(courses[0].teachingCopy).toContain("学而时习之");
  });

  it("copyMaterialIntoParent 把 html 放主题目录、媒体放 media/ 子目录", () => {
    const htmlSrc = path.join(mockTmpRoot, "tmp-课程.html");
    const mp3Src = path.join(mockTmpRoot, "tmp-音频.mp3");
    fs.writeFileSync(htmlSrc, "<html/>", "utf-8");
    fs.writeFileSync(mp3Src, "fake", "utf-8");

    const htmlRel = copyMaterialIntoParent("default", "lunyu", htmlSrc);
    const mp3Rel = copyMaterialIntoParent("default", "lunyu", mp3Src);
    expect(htmlRel).toBe("materials/lunyu/tmp-课程.html");
    expect(mp3Rel).toBe("materials/lunyu/media/tmp-音频.mp3");
    expect(fs.existsSync(path.join(mockTmpRoot, "parents", "default", htmlRel))).toBe(true);
    expect(fs.existsSync(path.join(mockTmpRoot, "parents", "default", mp3Rel))).toBe(true);

    const files = listParentMaterials("default", "lunyu");
    expect(files).toContain("tmp-课程.html");
  });

  it("deleteParentCourse 删除课程；不存在返回 false", () => {
    upsertParentCourse("default", "lunyu", { title: "要删的课", lessonMethod: "x" });
    expect(deleteParentCourse("default", "lunyu", "要删的课")).toBe(true);
    expect(listParentTopicCourses("default", "lunyu").length).toBe(0);
    expect(deleteParentCourse("default", "lunyu", "不存在的课")).toBe(false);
  });

  it("moveParentCourse 上移/下移调整课程顺序；越界返回 false", () => {
    upsertParentCourse("default", "lunyu", { title: "第一课", sortOrder: 0 });
    upsertParentCourse("default", "lunyu", { title: "第二课", sortOrder: 1 });
    upsertParentCourse("default", "lunyu", { title: "第三课", sortOrder: 2 });

    // 第二课上移 → 与第一课交换
    expect(moveParentCourse("default", "lunyu", "第二课", -1)).toBe(true);
    let list = listParentTopicCourses("default", "lunyu").map((c) => c.title);
    expect(list[0]).toBe("第二课");
    expect(list[1]).toBe("第一课");
    // 第一课（下标 1）再上移 → 顶到最前
    expect(moveParentCourse("default", "lunyu", "第一课", -1)).toBe(true);
    list = listParentTopicCourses("default", "lunyu").map((c) => c.title);
    expect(list[0]).toBe("第一课");
    // 顶部课程再上移 → false（已到边界）；末位下移 → false
    expect(moveParentCourse("default", "lunyu", "第一课", -1)).toBe(false);
    expect(moveParentCourse("default", "lunyu", "第三课", 1)).toBe(false);
    expect(moveParentCourse("default", "lunyu", "不存在的课", 1)).toBe(false);
  });

  it("readParentMaterial 读取 html 资料并防目录穿越", () => {
    const src = path.join(mockTmpRoot, "tmp-课程.html");
    fs.writeFileSync(src, "<html><body>课程资料</body></html>", "utf-8");
    const rel = copyMaterialIntoParent("default", "lunyu", src);
    const r = readParentMaterial("default", rel);
    expect(r.found).toBe(true);
    expect(r.format).toBe("html");
    expect(r.content).toContain("课程资料");
    // 穿越/越界拒绝
    expect(readParentMaterial("default", "../parent.sqlite").found).toBe(false);
    expect(readParentMaterial("default", "materials/../../parent.sqlite").found).toBe(false);
    expect(readParentMaterial("default", "不存在的文件.html").found).toBe(false);
  });

  it("migrateChildrenToParent 把 html 移到父库共享目录、method 改全文、回填 html_path、清空孩子 materials", () => {
    // 造一个带 method.md + materials/*.html + 课程行的孩子
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    const lunyuDir = path.join(childDir, "learning", "lunyu");
    fs.mkdirSync(path.join(lunyuDir, "materials"), { recursive: true });
    fs.writeFileSync(path.join(lunyuDir, "method.md"), "# 论语教法全文", "utf-8");
    fs.writeFileSync(path.join(lunyuDir, "materials", "论语学而篇第一章.html"), "<html><body>资料</body></html>", "utf-8");
    fs.writeFileSync(path.join(childDir, "learning", "topics.md"), "---\ntopics:\n  - {name: 论语, file: lunyu/lunyu.md, method: learning/lunyu/method.md}\n---\n", "utf-8");
    // 孩子课程行（title 与 html 文件名一致）
    insertCourse(childDir, { topic: "lunyu", title: "论语学而篇第一章", status: "✅" });
    // 打开一次库让 topics 表有主题行（真实环境由迁移产生，这里直接用 openKbDb 建库）
    const db = openKbDb(childDir);
    db.prepare("INSERT INTO topics (name, file, method, progress, rules_json) VALUES (?, ?, ?, '', '{}')").run(
      "论语",
      "lunyu",
      "learning/lunyu/method.md",
    );
    db.close();

    const stats = migrateChildrenToParent("default");

    expect(stats.htmlMoved).toBe(1);
    expect(stats.coursesUpdated).toBe(1);
    expect(stats.materialsDirsRemoved).toBe(1);

    // html 已到父库共享目录，孩子侧 materials 已删
    expect(fs.existsSync(path.join(mockTmpRoot, "parents", "default", "materials", "lunyu", "论语学而篇第一章.html"))).toBe(true);
    expect(fs.existsSync(path.join(lunyuDir, "materials"))).toBe(false);

    // 孩子库 courses.html_path 已回填；method 不写孩子库（经 parent_content 工具从家长库取）
    const detail = queryTopicProgress(childDir, "lunyu");
    expect(detail[0].items[0].htmlPath).toContain("materials/lunyu/论语学而篇第一章.html");
    const metas = queryTopicsMeta(childDir);
    expect(metas.find((m: any) => m.name === "论语")?.method).not.toContain("论语教法全文");

    // 父库 topics.method 全文、listParentTopics 有该主题
    const topics = listParentTopics("default");
    const lunyu = topics.find((t) => t.file === "lunyu")!;
    expect(lunyu.method).toContain("论语教法全文");
    expect(lunyu.total).toBe(1);
    expect(lunyu.htmlCount).toBe(1);
  });

  it("migrateChildrenToParent 把 materials/*.md 教学文案回填父库 courses.teaching_copy（孩子库不存）", () => {
    const childDir = path.join(mockTmpRoot, "children", CHILD);
    const lunyuDir = path.join(childDir, "learning", "lunyu");
    fs.mkdirSync(path.join(lunyuDir, "materials"), { recursive: true });
    fs.writeFileSync(path.join(lunyuDir, "method.md"), "# 论语教法全文", "utf-8");
    fs.writeFileSync(
      path.join(lunyuDir, "materials", "论语学而篇第一章.md"),
      "# 学而时习之\n\n子曰：学而时习之，不亦说乎……",
      "utf-8"
    );
    fs.writeFileSync(path.join(childDir, "learning", "topics.md"), "---\ntopics:\n  - {name: 论语, file: lunyu/lunyu.md, method: learning/lunyu/method.md}\n---\n", "utf-8");
    insertCourse(childDir, { topic: "lunyu", title: "论语学而篇第一章", status: "✅" });
    const db = openKbDb(childDir);
    db.prepare("INSERT INTO topics (name, file, method, progress, rules_json) VALUES (?, ?, ?, '', '{}')").run(
      "论语",
      "lunyu",
      "learning/lunyu/method.md",
    );
    db.close();

    const stats = migrateChildrenToParent("default");
    expect(stats.teachingCopyBackfilled).toBeGreaterThanOrEqual(1);

    // 孩子库 teaching_copy 保持为空（不冗余存）
    const detail = queryTopicProgress(childDir, "lunyu");
    expect(detail[0].items[0].teachingCopy).toBe("");
    // 父库 teaching_copy 已回填
    const parentCourses = listParentTopicCourses("default", "lunyu");
    expect(parentCourses[0].teachingCopy).toContain("学而时习之");
  });
});

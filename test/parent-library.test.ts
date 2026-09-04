import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// 纯 node 环境没有 electron：打桩 app，使 config 走 process.cwd()/data（同 learning-summary.test）。
vi.mock("electron", () => ({ app: undefined }));

// 把 config 的 data 根指向临时目录，避免触碰真实 data/parents 与 data/children。
// 用 importOriginal 保留全部真实导出（含 SPLIT 新增的 getServerUrl/getLicensePath/getAuthPath 等），
// 只覆盖数据根——否则 vi.mock 手写导出会因缺导出报 No "xxx" export is defined（SPLIT 后踩坑）。
const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "parent-lib-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    // ⚠️ 真实 getLicensePath 内部引用真实 getDataDir（读 PI_TEST_DATA_DIR），mock 的 getDataDir
    // 只对外部导入生效——必须显式覆盖 getLicensePath，否则 currentSessionToken 读不到测试 license。
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
  };
});

// SPLIT：家长库数据唯一真源在服务端（parent_lib.* / kb.* RPC + materials HTTP）。
// 测试连本地测试服务端 127.0.0.1:8788；每个用例签一个**独立随机测试家长**的 token 写入
// 临时目录 license.json（getCachedLicense 每次读文件，无缓存）→ 服务端按 token parent_id
// 自动建全新空库（openParentLib mkdir + schema），用例间数据完全隔离、不污染真实家长。
import { writeTestLicense, registerTestChild } from "./helpers/server-token";
import { dbExec, dbQuery } from "../electron/lib/client-data";
import {
  allocateTopicToChild,
  copyMaterialIntoParent,
  deleteParentCourse,
  getParentContentForChild,
  listChildAllocatedTopics,
  listParentMaterials,
  listParentTopics,
  listParentTopicCourses,
  moveParentCourse,
  readParentMaterial,
  upsertParentCourse,
  upsertParentTopic,
} from "../electron/lib/parent-library";

// 服务端 children.id 必须是 UUID 格式；children.id 是全局主键（非 parent 维度），
// 每个用例生成随机 childId 避免跨用例冲突。
let CHILD = "";

beforeEach(async () => {
  // 每个用例前清空临时根，保证幂等
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
  fs.mkdirSync(mockTmpRoot, { recursive: true });
  fs.mkdirSync(path.join(mockTmpRoot, "children"), { recursive: true });
  // 独立随机家长 → 服务端全新空库，用例互不影响
  writeTestLicense(mockTmpRoot, crypto.randomUUID());
  // 随机 childId + 在服务端注册该家长名下的测试孩子（assertChildOwned 校验 children 表）
  CHILD = crypto.randomUUID();
  await registerTestChild(mockTmpRoot, CHILD);
});

afterAll(() => {
  fs.rmSync(mockTmpRoot, { recursive: true, force: true });
});

describe("ISSUE-029 家长库（主题统一管理 + 快照分配，SPLIT 服务端模式）", () => {
  it("upsertParentTopic 存 method 全文；listParentTopics 返回主题与资料数", async () => {
    await upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "# 教学方法全文\n\n1. 先读\n2. 再背" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读+讲解", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    const topics = await listParentTopics("default");
    expect(topics.length).toBe(1);
    const t = topics[0];
    expect(t.name).toBe("论语");
    expect(t.topicKey).toBe("lunyu");
    expect(t.method).toContain("教学方法全文"); // 全文入库，不是文件链接
    expect(t.total).toBe(1);
  });

  it("listParentTopicCourses 返回每课的 lesson_method 与 html_path", async () => {
    await upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "m" },
      [
        { title: "论语学而篇第一章", lessonMethod: "朗读+讲解", htmlPath: "materials/lunyu/论语学而篇第一章.html" },
        { title: "论语学而篇第二章", lessonMethod: "跟读", htmlPath: "materials/lunyu/论语学而篇第二章.html" },
      ]
    );
    const courses = await listParentTopicCourses("default", "lunyu");
    expect(courses.length).toBe(2);
    const first = courses.find((c) => c.title.includes("第一章"))!;
    expect(first.lessonMethod).toBe("朗读+讲解");
    expect(first.htmlPath).toContain("materials");
    // 家长库课程不带进度（status 一律 ⬜）
    expect(first.status).toBe("⬜");
  });

  it("allocateTopicToChild 快照拷贝主题进孩子库；重复分配不丢孩子进度", async () => {
    await upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "# 方法全文" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    // 孩子已有该课且已学（SPLIT：孩子 kb 在服务端，用 kb.courses.upsert 预置进度）
    await dbExec("kb.courses.upsert", {
      child_id: CHILD,
      topic: "lunyu",
      title: "论语学而篇第一章",
      sort_order: 0,
      status: "✅",
      mastery: "良好",
      first_learned: "",
      last_review: "",
      review_count: 0,
      material: "",
      send_material: "",
      tags: "",
      lesson_method: "",
      html_path: "",
      teaching_copy: "",
    });

    const r1 = await allocateTopicToChild("default", CHILD, "lunyu");
    expect(r1.copied).toBe(0); // 已存在 → 不覆盖
    expect(r1.existing).toBe(1);

    // 验证孩子库课程进度仍在、内容字段已补齐（lesson_method/html_path）
    const rows = await dbQuery<any[]>("kb.courses.list", { child_id: CHILD, topic: "lunyu" });
    const c = rows.find((r) => r.title === "论语学而篇第一章")!;
    expect(c.status).toBe("✅"); // 进度未丢
    expect(c.mastery).toBe("良好");
    expect(c.lesson_method).toBe("朗读"); // 内容已从父库快照补齐
    expect(c.html_path).toContain("lunyu/论语学而篇第一章.html");
    // teaching_copy 随快照拷贝（本用例父库课未传 teachingCopy，故为空）
    expect(c.teaching_copy).toBe("");
    // 用户拍板（2026-09-04）：主题级教学方法**不快照**进孩子库（method 恒为空串）——
    // 教法真源始终在家长库，孩子端经服务端 kb.courses.get / parent_content 实时读家长库。
    const kt = await dbQuery<any[]>("kb.topics.list", { child_id: CHILD });
    expect(kt.find((m: any) => m.name === "论语")?.method).toBe("");
  });

  it("getParentContentForChild 从家长库取 method/teachingCopy；未分配主题拒绝", async () => {
    await upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "# 论语教法全文\n\n三步教学" },
      [
        {
          title: "论语学而篇第一章",
          lessonMethod: "朗读",
          teachingCopy: "# 学而时习之\n\n子曰：学而时习之……",
          htmlPath: "materials/lunyu/论语学而篇第一章.html",
        },
      ]
    );

    // 未分配 → 拒绝
    expect((await getParentContentForChild(CHILD, "lunyu", "method")).found).toBe(false);

    // 分配后 → 可取 method / teachingCopy / htmlPath（内容在家长库，孩子库为空）
    await allocateTopicToChild("default", CHILD, "lunyu");
    const m = await getParentContentForChild(CHILD, "lunyu", "method");
    expect(m.found).toBe(true);
    expect(m.content).toContain("论语教法全文");
    const t = await getParentContentForChild(CHILD, "lunyu", "teachingCopy", "论语学而篇第一章");
    expect(t.found).toBe(true);
    expect(t.content).toContain("学而时习之");

    // htmlPath：文件未上传到服务端 → 远程 404 → not found（不返回失效指针）
    expect((await getParentContentForChild(CHILD, "lunyu", "htmlPath", "论语学而篇第一章")).found).toBe(false);
    // 上传 html 后 → 返回家长库相对路径，可直接传给 display_content
    const src = path.join(mockTmpRoot, "论语学而篇第一章.html");
    fs.writeFileSync(src, "<html/>", "utf-8");
    await copyMaterialIntoParent("default", "lunyu", src);
    const h = await getParentContentForChild(CHILD, "lunyu", "htmlPath", "论语学而篇第一章");
    expect(h.found).toBe(true);
    expect(h.content).toContain("lunyu/论语学而篇第一章.html");

    // 未分配的其他主题 → 拒绝
    expect((await getParentContentForChild(CHILD, "english", "method")).found).toBe(false);
  });

  it("listChildAllocatedTopics 返回孩子已添加的主题（无库孩子返回空）", async () => {
    await upsertParentTopic(
      "default",
      { name: "论语", topicKey: "lunyu", method: "# 方法全文" },
      [{ title: "论语学而篇第一章", lessonMethod: "朗读", htmlPath: "materials/lunyu/论语学而篇第一章.html" }]
    );
    // 未分配前：无 kb → 空
    expect(await listChildAllocatedTopics(CHILD)).toEqual([]);
    // 分配后：返回该主题（topicKey=目录名）
    await allocateTopicToChild("default", CHILD, "lunyu");
    const list = await listChildAllocatedTopics(CHILD);
    expect(list.length).toBe(1);
    expect(list[0].name).toBe("论语");
    expect(list[0].topicKey).toBe("lunyu");
  });

  it("upsertParentCourse / deleteParentCourse 维护家长库课程（只动内容字段）", async () => {
    await upsertParentCourse("default", "lunyu", {
      title: "论语学而篇第一章",
      lessonMethod: "朗读+讲解",
      teachingCopy: "# 学而时习之\n\n原文与讲解……",
      htmlPath: "materials/lunyu/论语学而篇第一章.html",
    });
    let courses = await listParentTopicCourses("default", "lunyu");
    expect(courses.length).toBe(1);
    expect(courses[0].lessonMethod).toBe("朗读+讲解");
    expect(courses[0].teachingCopy).toContain("学而时习之");
    expect(courses[0].status).toBe("⬜"); // 家长库不带进度

    // 更新内容字段：只覆盖传入的非空字段，html_path/teachingCopy 保留旧值
    await upsertParentCourse("default", "lunyu", {
      title: "论语学而篇第一章",
      lessonMethod: "朗读+讲解+跟读",
    });
    courses = await listParentTopicCourses("default", "lunyu");
    expect(courses[0].lessonMethod).toBe("朗读+讲解+跟读");
    expect(courses[0].htmlPath).toContain("materials"); // 未传字段保留旧值
    expect(courses[0].teachingCopy).toContain("学而时习之");
  });

  it("copyMaterialIntoParent 上传 html 到主题目录、媒体到 media/ 子目录（服务端材料库）", async () => {
    const htmlSrc = path.join(mockTmpRoot, "tmp-课程.html");
    const mp3Src = path.join(mockTmpRoot, "tmp-音频.mp3");
    fs.writeFileSync(htmlSrc, "<html/>", "utf-8");
    fs.writeFileSync(mp3Src, "fake", "utf-8");

    // SPLIT：上传到服务端材料库，返回相对路径（新格式 <topic>/<file>，无 materials/ 前缀）
    const htmlRel = await copyMaterialIntoParent("default", "lunyu", htmlSrc);
    const mp3Rel = await copyMaterialIntoParent("default", "lunyu", mp3Src);
    expect(htmlRel).toBe("lunyu/tmp-课程.html");
    expect(mp3Rel).toBe("lunyu/media/tmp-音频.mp3");

    // 服务端材料列表可查到（列表走 GET /materials/list）
    const files = await listParentMaterials("default", "lunyu");
    expect(files).toContain("tmp-课程.html");
  });

  it("deleteParentCourse 删除课程；不存在返回 false", async () => {
    await upsertParentCourse("default", "lunyu", { title: "要删的课", lessonMethod: "x" });
    expect(await deleteParentCourse("default", "lunyu", "要删的课")).toBe(true);
    expect((await listParentTopicCourses("default", "lunyu")).length).toBe(0);
    expect(await deleteParentCourse("default", "lunyu", "不存在的课")).toBe(false);
  });

  it("moveParentCourse 上移/下移调整课程顺序；越界返回 false", async () => {
    await upsertParentCourse("default", "lunyu", { title: "第一课", sortOrder: 0 });
    await upsertParentCourse("default", "lunyu", { title: "第二课", sortOrder: 1 });
    await upsertParentCourse("default", "lunyu", { title: "第三课", sortOrder: 2 });

    // 第二课上移 → 与第一课交换
    expect(await moveParentCourse("default", "lunyu", "第二课", -1)).toBe(true);
    let list = (await listParentTopicCourses("default", "lunyu")).map((c) => c.title);
    expect(list[0]).toBe("第二课");
    expect(list[1]).toBe("第一课");
    // 第一课（下标 1）再上移 → 顶到最前
    expect(await moveParentCourse("default", "lunyu", "第一课", -1)).toBe(true);
    list = (await listParentTopicCourses("default", "lunyu")).map((c) => c.title);
    expect(list[0]).toBe("第一课");
    // 顶部课程再上移 → false（已到边界）；末位下移 → false
    expect(await moveParentCourse("default", "lunyu", "第一课", -1)).toBe(false);
    expect(await moveParentCourse("default", "lunyu", "第三课", 1)).toBe(false);
    expect(await moveParentCourse("default", "lunyu", "不存在的课", 1)).toBe(false);
  });

  it("readParentMaterial 读取 html 资料并防目录穿越（服务端拉取）", async () => {
    const src = path.join(mockTmpRoot, "tmp-课程.html");
    fs.writeFileSync(src, "<html><body>课程资料</body></html>", "utf-8");
    const rel = await copyMaterialIntoParent("default", "lunyu", src);
    const r = await readParentMaterial("default", rel);
    expect(r.found).toBe(true);
    expect(r.format).toBe("html");
    expect(r.content).toContain("课程资料");
    // 穿越/越界拒绝（服务端 404 → not found）
    expect((await readParentMaterial("default", "../parent.sqlite")).found).toBe(false);
    expect((await readParentMaterial("default", "materials/../../parent.sqlite")).found).toBe(false);
    expect((await readParentMaterial("default", "不存在的文件.html")).found).toBe(false);
  });
});

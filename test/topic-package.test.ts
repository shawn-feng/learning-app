/**
 * 学习主题打包导出/导入测试（2026-09-25 方案，server/src/routes/topic-package.ts）。
 *
 * 覆盖：预览（计数/引用数）、收集+打包（manifest 字段/文件条目/sha256）、
 * 跨库导入（行/文件/uuid 保留/缺资料清单）、同名冲突自动重命名（四处前缀改写）、
 * 幂等刷新（同包重导）、manifest 校验（kind/schema_version）、路径穿越拒绝、
 * 白名单外条目忽略、文件篡改（sha256 不符）拒收。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import { zipPack, zipUnpack } from "../server/src/routes/backup";
import {
  collectTopicPackage,
  buildTopicPackageZip,
  applyTopicImport,
  previewTopicExport,
  parseManifest,
  safePackageFilePath,
  resolveImportIdentity,
  rewriteTopicRef,
} from "../server/src/routes/topic-package";

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "topic-pkg-"));
}

/** 造一个完整主题：2 门课、1 个知识点、1 道题、2 个资料文件（lesson2.html 故意缺，考 missing_files）。 */
function seedLunyu(dataDir: string): void {
  const db = openParentLib(dataDir, "p1");
  db.prepare(
    "INSERT INTO topics (name, topic_key, method, assess_method, progress, rules_json) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("论语", "lunyu", "逐句讲解释义", "每课背诵抽查", "已讲到第三课", '{"type":"必学"}');
  const course = db.prepare(
    `INSERT INTO courses (topic, title, sort_order, material, send_material, tags, lesson_method, html_path, teaching_copy, assess_rubric, uuid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  course.run("lunyu", "第一课", 1, "lunyu/a.mp4", "1", "经典", "先读后讲", "lunyu/lesson1.html", "教学副本1", "背诵《学而》", "uuid-c1");
  course.run("lunyu", "第二课", 2, "", "0", "", "跟读", "lunyu/lesson2.html", "", "", "uuid-c2");
  db.prepare("INSERT INTO question_bank (id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    "q1", "「学而时习之」出自哪篇？", "《学而》", "答对得满分", 10, "generic", "备注", "出处", "[]"
  );
  db.prepare("INSERT INTO knowledge_points (id, course_uuid, name, detail, seq) VALUES (?, ?, ?, ?, ?)").run(
    "kp1", "uuid-c1", "学而时习之", "原文+释义+用法", 1
  );
  db.prepare("INSERT INTO course_knowledge_questions (course_id, knowledge_point_id, question_id, seq, overview) VALUES (?, ?, ?, ?, ?)").run(
    "uuid-c1", "kp1", "q1", 1, "出处题"
  );
  db.close();
  const root = materialsRoot(dataDir, "p1");
  fs.mkdirSync(path.join(root, "lunyu"), { recursive: true });
  fs.writeFileSync(path.join(root, "lunyu", "lesson1.html"), "<h1>lesson1</h1>");
  fs.writeFileSync(path.join(root, "lunyu", "a.mp4"), Buffer.from([1, 2, 3, 4, 5]));
}

/** 导出端打包（带全部资料）；返回 zip。 */
function exportZip(dataDir: string, withFiles: boolean): Buffer {
  const files = withFiles ? ["lunyu/lesson1.html", "lunyu/a.mp4"] : [];
  const { manifest, fileData } = collectTopicPackage(dataDir, "p1", "lunyu", files);
  return buildTopicPackageZip(manifest, fileData);
}

describe("previewTopicExport", () => {
  it("返回主题信息、内容计数与资料清单（含被引用次数）", () => {
    const dir = makeDataDir();
    seedLunyu(dir);
    const pv = previewTopicExport(dir, "p1", "lunyu");
    expect(pv.topic).toEqual({ name: "论语", topicKey: "lunyu" });
    expect(pv.counts).toEqual({ courses: 2, knowledgePoints: 1, questions: 1 });
    const paths = pv.files.map((f) => f.path).sort();
    expect(paths).toEqual(["lunyu/a.mp4", "lunyu/lesson1.html"]);
    const lesson1 = pv.files.find((f) => f.path === "lunyu/lesson1.html")!;
    expect(lesson1.refCount).toBe(1); // 第一课 html_path 引用
    const mp4 = pv.files.find((f) => f.path === "lunyu/a.mp4")!;
    expect(mp4.type).toBe("video");
    expect(mp4.refCount).toBe(1); // material 引用
  });

  it("主题不存在时报 404 语义错误", () => {
    const dir = makeDataDir();
    expect(() => previewTopicExport(dir, "p1", "nope")).toThrow(/未找到主题/);
  });
});

describe("collectTopicPackage + buildTopicPackageZip", () => {
  it("纯数据包：manifest 四表齐全、files 为空、zip 内只有 manifest", () => {
    const dir = makeDataDir();
    seedLunyu(dir);
    const { manifest, fileData } = collectTopicPackage(dir, "p1", "lunyu", []);
    expect(fileData.size).toBe(0);
    expect(manifest.kind).toBe("learning-topic-package");
    expect(manifest.topic).toMatchObject({ name: "论语", topic_key: "lunyu", method: "逐句讲解释义" });
    expect(manifest.courses.map((c) => c.title)).toEqual(["第一课", "第二课"]);
    expect(manifest.courses[0]).toMatchObject({ uuid: "uuid-c1", html_path: "lunyu/lesson1.html", teaching_copy: "教学副本1" });
    expect(manifest.question_bank).toHaveLength(1);
    expect(manifest.question_bank[0]).toMatchObject({ id: "q1", behavior: "generic" });
    expect(manifest.knowledge_points).toEqual([{ id: "kp1", course_uuid: "uuid-c1", name: "学而时习之", detail: "原文+释义+用法", seq: 1 }]);
    expect(manifest.course_knowledge_questions).toHaveLength(1);
    expect(manifest.files).toEqual([]);

    const entries = zipUnpack(buildTopicPackageZip(manifest, fileData));
    expect(entries.map((e) => e.path)).toEqual(["manifest.json"]);
  });

  it("带资料包：files/ 条目齐全、sha256 与实际内容一致、未勾选文件不入包", () => {
    const dir = makeDataDir();
    seedLunyu(dir);
    const { manifest, fileData } = collectTopicPackage(dir, "p1", "lunyu", ["lunyu/lesson1.html"]);
    expect(manifest.files.map((f) => f.path)).toEqual(["lunyu/lesson1.html"]);
    expect(fileData.get("lunyu/lesson1.html")!.toString()).toBe("<h1>lesson1</h1>");

    const zip = buildTopicPackageZip(manifest, fileData);
    const entries = zipUnpack(zip);
    const entry = entries.find((e) => e.path === "files/lunyu/lesson1.html")!;
    expect(entry.data.toString()).toBe("<h1>lesson1</h1>");
    expect(entries.some((e) => e.path.startsWith("files/lunyu/a.mp4"))).toBe(false);
    const mf = JSON.parse(entries.find((e) => e.path === "manifest.json")!.data.toString()) as typeof manifest;
    expect(mf.files[0]).toMatchObject({ path: "lunyu/lesson1.html", size: 16 });
  });

  it("勾选不存在的文件时报错", () => {
    const dir = makeDataDir();
    seedLunyu(dir);
    expect(() => collectTopicPackage(dir, "p1", "lunyu", ["lunyu/ghost.html"])).toThrow(/不存在/);
  });
});

describe("applyTopicImport（跨库导入）", () => {
  it("全量导入：行/文件/uuid 原样落地，缺资料清单列未随包引用", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const zip = exportZip(src, true);

    const dst = makeDataDir();
    const report = applyTopicImport(dst, "p1", zipUnpack(zip));
    expect(report.ok).toBe(true);
    expect(report.renamed).toBe(false);
    expect(report.refreshed).toBe(false);
    expect(report.topic).toEqual({ name: "论语", topicKey: "lunyu" });
    expect(report).toMatchObject({ courses: 2, knowledge_points: 1, questions: 1, files: 2 });
    expect(report.missing_files).toEqual(["第二课 → lunyu/lesson2.html"]);

    const db = openParentLib(dst, "p1");
    const topic = db.prepare("SELECT * FROM topics WHERE name = '论语'").get() as any;
    expect(topic).toMatchObject({ topic_key: "lunyu", method: "逐句讲解释义", assess_method: "每课背诵抽查" });
    const c1 = db.prepare("SELECT * FROM courses WHERE topic = 'lunyu' AND title = '第一课'").get() as any;
    expect(c1).toMatchObject({ uuid: "uuid-c1", html_path: "lunyu/lesson1.html", material: "lunyu/a.mp4" });
    expect(db.prepare("SELECT COUNT(*) AS c FROM knowledge_points").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM question_bank").get()).toMatchObject({ c: 1 });
    expect(db.prepare("SELECT COUNT(*) AS c FROM course_knowledge_questions").get()).toMatchObject({ c: 1 });
    db.close();
    expect(fs.readFileSync(path.join(materialsRoot(dst, "p1"), "lunyu", "lesson1.html")).toString()).toBe("<h1>lesson1</h1>");
    expect([...fs.readFileSync(path.join(materialsRoot(dst, "p1"), "lunyu", "a.mp4"))]).toEqual([1, 2, 3, 4, 5]);
  });

  it("纯数据包导入：缺资料清单齐全，孩子库不受影响", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const dst = makeDataDir();
    const report = applyTopicImport(dst, "p1", zipUnpack(exportZip(src, false)));
    expect(report.files).toBe(0);
    expect(report.missing_files.sort()).toEqual([
      "第一课 → lunyu/a.mp4",
      "第一课 → lunyu/lesson1.html",
      "第二课 → lunyu/lesson2.html",
    ]);
  });

  it("同名不同源主题：自动重命名，课程归属/指针/落盘目录四处前缀同步改写", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const dst = makeDataDir();
    // 目标库先有一个别的「论语」（topic_key=other）
    const db = openParentLib(dst, "p1");
    db.prepare("INSERT INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("论语", "other", "别的教法");
    db.close();

    const report = applyTopicImport(dst, "p1", zipUnpack(exportZip(src, true)));
    expect(report.renamed).toBe(true);
    expect(report.topic).toEqual({ name: "论语 (2)", topicKey: "lunyu-2" });

    const db2 = openParentLib(dst, "p1");
    expect((db2.prepare("SELECT COUNT(*) AS c FROM topics WHERE name = '论语 (2)' AND topic_key = 'lunyu-2'").get() as any).c).toBe(1);
    const c1 = db2.prepare("SELECT * FROM courses WHERE topic = 'lunyu-2' AND title = '第一课'").get() as any;
    expect(c1).toMatchObject({ html_path: "lunyu-2/lesson1.html", material: "lunyu-2/a.mp4", uuid: "uuid-c1" });
    db2.close();
    // 文件落在改名后的目录
    expect(fs.existsSync(path.join(materialsRoot(dst, "p1"), "lunyu-2", "lesson1.html"))).toBe(true);
    expect(fs.existsSync(path.join(materialsRoot(dst, "p1"), "lunyu-2", "a.mp4"))).toBe(true);
  });

  it("同包重复导入（同名同 key）：幂等刷新，行数不翻倍", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const dst = makeDataDir();
    const zip = exportZip(src, true);
    applyTopicImport(dst, "p1", zipUnpack(zip));
    const report2 = applyTopicImport(dst, "p1", zipUnpack(zip));
    expect(report2.refreshed).toBe(true);
    const db = openParentLib(dst, "p1");
    expect((db.prepare("SELECT COUNT(*) AS c FROM courses WHERE topic = 'lunyu'").get() as any).c).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS c FROM knowledge_points").get() as any).c).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS c FROM question_bank").get() as any).c).toBe(1);
    db.close();
  });
});

describe("导入防护", () => {
  it("manifest 校验：kind 不符 / 版本过新 / 缺字段 拒收", () => {
    expect(() => parseManifest(JSON.stringify({ kind: "other" }))).toThrow(/kind/);
    expect(() => parseManifest(JSON.stringify({ kind: "learning-topic-package", schema_version: 99 }))).toThrow(/版本过新/);
    expect(() =>
      parseManifest(JSON.stringify({ kind: "learning-topic-package", schema_version: 1, topic: { name: "x" } }))
    ).toThrow(/topic_key/);
    expect(() =>
      parseManifest(JSON.stringify({ kind: "learning-topic-package", schema_version: 1, topic: { name: "x", topic_key: "x" }, courses: [], question_bank: [], knowledge_points: [], course_knowledge_questions: [], files: [] }))
    ).not.toThrow();
  });

  it("路径穿越条目一律拒绝（../、绝对路径、盘符、越出主题目录）", () => {
    expect(safePackageFilePath("files/lunyu/../evil.txt", "lunyu")).toBeNull();
    expect(safePackageFilePath("files//abs.txt", "lunyu")).toBeNull();
    expect(safePackageFilePath("files/C:/windows/evil.txt", "lunyu")).toBeNull();
    expect(safePackageFilePath("files/other-topic/f.txt", "lunyu")).toBeNull();
    expect(safePackageFilePath("manifest.json", "lunyu")).toBeNull();
    expect(safePackageFilePath("files/lunyu/sub/f.txt", "lunyu")).toBe("lunyu/sub/f.txt");
  });

  it("白名单外条目忽略并告警；manifest 登记但包内缺失的文件告警", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const { manifest, fileData } = collectTopicPackage(src, "p1", "lunyu", ["lunyu/lesson1.html"]);
    // 塞一个未登记条目
    fileData.set("lunyu/extra.txt", Buffer.from("hack"));
    const zip = buildTopicPackageZip(manifest, fileData);

    const dst = makeDataDir();
    const report = applyTopicImport(dst, "p1", zipUnpack(zip));
    expect(report.files).toBe(1); // extra.txt 被忽略
    expect(report.warnings.some((w) => w.includes("lunyu/extra.txt"))).toBe(true);
    expect(fs.existsSync(path.join(materialsRoot(dst, "p1"), "lunyu", "extra.txt"))).toBe(false);
  });

  it("文件被篡改（sha256 不符）时拒收", () => {
    const src = makeDataDir();
    seedLunyu(src);
    const { manifest, fileData } = collectTopicPackage(src, "p1", "lunyu", ["lunyu/lesson1.html"]);
    fileData.set("lunyu/lesson1.html", Buffer.from("<h1>tampered</h1>"));
    const zip = buildTopicPackageZip(manifest, fileData);
    const dst = makeDataDir();
    expect(() => applyTopicImport(dst, "p1", zipUnpack(zip))).toThrow(/sha256/);
  });

  it("缺 manifest 的包拒收", () => {
    const dst = makeDataDir();
    const zip = zipPack([{ path: "files/lunyu/f.txt", data: Buffer.from("x") }]);
    expect(() => applyTopicImport(dst, "p1", zipUnpack(zip))).toThrow(/manifest/);
  });
});

describe("冲突裁决与指针改写（纯函数）", () => {
  it("resolveImportIdentity 三分支：新主题 / 幂等刷新 / 自动重命名", () => {
    const dir = makeDataDir();
    const db = openParentLib(dir, "p1");
    db.prepare("INSERT INTO topics (name, topic_key, method) VALUES (?, ?, ?)").run("论语", "other", "");
    db.close();
    const db2 = openParentLib(dir, "p1");
    expect(resolveImportIdentity(db2, "新主题", "xin")).toEqual({ name: "新主题", topicKey: "xin", renamed: false, refreshed: false });
    expect(resolveImportIdentity(db2, "论语", "lunyu")).toEqual({ name: "论语 (2)", topicKey: "lunyu-2", renamed: true, refreshed: false });
    expect(resolveImportIdentity(db2, "论语", "other")).toEqual({ name: "论语", topicKey: "other", renamed: false, refreshed: true });
    db2.close();
  });

  it("rewriteTopicRef 只改本主题前缀，不动其他主题的同名子路径", () => {
    expect(rewriteTopicRef("lunyu/a.html", "lunyu", "lunyu-2")).toBe("lunyu-2/a.html");
    expect(rewriteTopicRef("lunyu", "lunyu", "lunyu-2")).toBe("lunyu-2");
    expect(rewriteTopicRef("other/a.html", "lunyu", "lunyu-2")).toBe("other/a.html");
    expect(rewriteTopicRef("lunyu2/a.html", "lunyu", "lunyu-2")).toBe("lunyu2/a.html");
  });
});

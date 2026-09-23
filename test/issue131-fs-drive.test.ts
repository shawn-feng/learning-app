/**
 * ISSUE-131 P1 回归：文件区网盘（双端文件管理）服务端核心。
 *
 * 守住：
 * ① scope 解析：家长虚拟根（materials/ uploads/ + workspaces/<pid> 整棵树）；孩子 scope 锚定
 *    workspaces/<pid>/<cid>；
 * ② 越权（R-6）：孩子 scope 摸 ../materials、../uploads、兄弟目录一律拒绝；孩子归属断言；
 * ③ 三区操作：workspace 全量管理；materials 写走 putMaterial 语义（topic 约束 + 索引登记，
 *    跨区转存进 materials）；uploads 只开 list/upload/delete（uuid + files 表）；
 * ④ R-1 引用影响：courses.html_path / display_contents / exam_plans scope 命中时
 *    delete/move/rename 不带 confirm → needsConfirm（带 confirm 才真正执行）；
 * ⑤ R-8 边界：重名冲突、目录移进自身、保留区根不可删改、家长根保留名。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { listMaterialsMeta } from "../server/src/db/materials";
import {
  normalizeRelPath,
  safeName,
  resolveEntry,
  fsList,
  fsMkdir,
  fsRename,
  fsMove,
  fsDelete,
  fsSaveUpload,
  fsSearch,
  findMaterialReferences,
  withChild,
  type FsCtx,
} from "../server/src/routes/fs";
import { ApiError } from "../server/src/auth/proxy";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue131-"));
const PID = "p131";
const CID = "c131";
const db = openDb(dataDir);

const now = new Date().toISOString();
db.prepare("INSERT INTO parents (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(PID, "p131@test", now, now);
db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(CID, PID, "娃", now, now);
// 第二个孩子（兄弟目录越权用）
db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("c131-sib", PID, "弟", now, now);

const parentCtx: FsCtx = { dataDir, db, parentId: PID, childId: null };
const childCtx: FsCtx = { dataDir, db, parentId: PID, childId: CID };

const WS_ROOT = path.join("workspaces", PID);
const CHILD_ROOT = path.join(WS_ROOT, CID);
// P2 布局：materials/uploads 物理并入家长工作区；旧根（materials/<pid>、files/<pid>）只读兜底
const MAT_ROOT = path.join(WS_ROOT, "materials");
const LEGACY_MAT_ROOT = path.join("materials", PID);
const FILES_ROOT = path.join(WS_ROOT, "uploads");
const LEGACY_FILES_ROOT = path.join("files", PID);

function writeFileSync(rel: string, content: string): void {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
}

const status = (rel: string) => fs.existsSync(path.join(dataDir, rel));

function expectApiError(fn: () => unknown, re: RegExp): void {
  try {
    fn();
    expect.fail(`应抛 ApiError：${re}`);
  } catch (err) {
    if (err instanceof ApiError) expect(err.message).toMatch(re);
    else throw err;
  }
}

/** 造一个已落盘的临时文件充当上传源（fsSaveUpload 的 tmpPath 入参）。 */
let tmpSeq = 0;
function makeTmp(content: string): string {
  const tmpDir = path.join(dataDir, "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const p = path.join(tmpDir, `test-${++tmpSeq}.upload`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("ISSUE-131 路径解析与归一化", () => {
  it("normalizeRelPath：正斜杠归一、去前导斜杠、拒 . / .. 段", () => {
    expect(normalizeRelPath("materials/lunyu/a.html")).toBe("materials/lunyu/a.html");
    expect(normalizeRelPath("/a//b/")).toBe("a/b");
    expect(normalizeRelPath("")).toBe("");
    expect(() => normalizeRelPath("../escape")).toThrow();
    expect(() => normalizeRelPath("a/../../b")).toThrow();
    expect(() => normalizeRelPath("a\\..\\b")).toThrow();
  });

  it("safeName：允许点开头文件名（.pi），拒分隔符与纯点段", () => {
    expect(safeName(".pi")).toBe(".pi");
    expect(safeName("a.b.html")).toBe("a.b.html");
    expect(() => safeName("..")).toThrow();
    expect(() => safeName("a/b")).toThrow();
  });

  it("家长 scope：materials/ uploads/ 前缀映射到物理三区，其余落 workspaces/<pid>", () => {
    const m = resolveEntry(parentCtx, "materials/lunyu/a.html");
    expect(m.zone).toBe("materials");
    expect(m.abs).toBe(path.join(dataDir, MAT_ROOT, "lunyu", "a.html"));
    const u = resolveEntry(parentCtx, "uploads/x.mp3");
    expect(u.zone).toBe("uploads");
    expect(u.abs).toBe(path.join(dataDir, FILES_ROOT, "x.mp3"));
    const w = resolveEntry(parentCtx, `${CID}/outputs/a.html`);
    expect(w.zone).toBe("workspace");
    expect(w.abs).toBe(path.join(dataDir, CHILD_ROOT, "outputs", "a.html"));
  });

  it("孩子 scope：全部路径锚定自己工作区（无区映射）", () => {
    const r = resolveEntry(childCtx, "outputs/a.html");
    expect(r.zone).toBe("workspace");
    expect(r.abs).toBe(path.join(dataDir, CHILD_ROOT, "outputs", "a.html"));
    // 孩子上下文里不存在 materials/uploads 虚拟区（首段不触发映射）
    const m = resolveEntry(childCtx, "materials/x.html");
    expect(m.abs).toBe(path.join(dataDir, CHILD_ROOT, "materials", "x.html"));
  });

  it("R-6 越权：孩子 scope 摸 ../materials、../uploads、兄弟目录一律拒绝", () => {
    expect(() => resolveEntry(childCtx, "../materials/lunyu/a.html")).toThrow();
    expect(() => resolveEntry(childCtx, "../uploads/x.mp3")).toThrow();
    expect(() => resolveEntry(childCtx, "../c131-sib/outputs/a.html")).toThrow();
    expect(() => fsList(childCtx, "..")).toThrow();
    expect(() => fsDelete(childCtx, "../c131-sib/outputs/a.html", { confirm: true })).toThrow();
  });

  it("R-6 越权：孩子 id 不属于该家长 → 归属断言拒绝（网盘 API 侧隔离）", () => {
    db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "child-of-other",
      "other-p",
      "别家娃",
      now,
      now
    );
    expectApiError(() => withChild(parentCtx, "child-of-other"), /无权/);
  });
});

describe("ISSUE-131 workspace 区（家长/孩子全量管理）", () => {
  it("家长虚拟根列表 = materials/ + uploads/ + workspaces 子项（孩子目录带人名标签）", () => {
    fs.mkdirSync(path.join(dataDir, CHILD_ROOT), { recursive: true });
    writeFileSync(path.join(WS_ROOT, "parent", "scratch.md"), "hi");
    const r = fsList(parentCtx, "");
    const names = r.entries.map((e) => e.path);
    expect(names).toContain("materials");
    expect(names).toContain("uploads");
    expect(names).toContain(CID);
    expect(names).toContain("parent");
    const byPath = new Map(r.entries.map((e) => [e.path, e]));
    expect(byPath.get(CID)?.label).toBe("娃 的工作区");
    expect(byPath.get("parent")?.label).toBe("家长工作区");
    expect(byPath.get("materials")?.label).toBe("课程资料库");
  });

  it("新建文件夹 → 重命名 → 移动 → 删除 全链路（孩子 scope）", () => {
    const mk = fsMkdir(childCtx, "", "outputs");
    expect(mk.path).toBe("outputs");
    expect(status(path.join(CHILD_ROOT, "outputs"))).toBe(true);

    writeFileSync(path.join(CHILD_ROOT, "outputs", "a.html"), "<p>x</p>");
    const rn = fsRename(childCtx, "outputs/a.html", "b.html", { confirm: true });
    expect(rn.path).toBe("outputs/b.html");
    expect(status(path.join(CHILD_ROOT, "outputs", "b.html"))).toBe(true);

    const mv = fsMove(childCtx, "outputs/b.html", "", { confirm: true });
    expect(mv.path).toBe("b.html");
    expect(status(path.join(CHILD_ROOT, "b.html"))).toBe(true);

    fsDelete(childCtx, "b.html", { confirm: true });
    expect(status(path.join(CHILD_ROOT, "b.html"))).toBe(false);
  });

  it("R-8 边界：重名上传冲突、目录移进自身拒绝、家长根保留名拒绝", () => {
    writeFileSync(path.join(CHILD_ROOT, "dup.txt"), "1");
    const conflict = fsSaveUpload(childCtx, "", "dup.txt", makeTmp("x"), "text/plain");
    expect(conflict.conflict).toBe(true);
    expectApiError(() => fsRename(childCtx, "dup.txt", "dup.txt", { confirm: true }), /已存在/);
    fs.mkdirSync(path.join(dataDir, CHILD_ROOT, "outputs", "newdir"), { recursive: true });
    expectApiError(() => fsMove(childCtx, "outputs", "outputs/newdir", { confirm: true }), /自己或它的子目录/);
    expectApiError(() => fsMkdir(parentCtx, "", "materials"), /保留区名/);
    expectApiError(() => fsMkdir(parentCtx, "", "uploads"), /保留区名/);
  });
});

describe("ISSUE-131 materials 区（putMaterial 语义 + R-1 引用检查）", () => {
  it("上传进 materials/<topic>：落新根（putMaterial 语义，无索引表）；topic 规则拒绝坏段", () => {
    const r = fsSaveUpload(parentCtx, "materials/lunyu", "lesson-01.html", makeTmp("<h1>l1</h1>"), "text/html");
    expect(r.entry.path).toBe("materials/lunyu/lesson-01.html");
    expect(status(path.join(MAT_ROOT, "lunyu", "lesson-01.html"))).toBe(true);
    expect(listMaterialsMeta(dataDir, PID).map((m) => m.path)).toContain("lunyu/lesson-01.html");

    // topic（第一段）必须 ^[a-zA-Z0-9_-]+$：materials 根下直接传带点文件名、中文目录都拒绝
    expectApiError(() => fsSaveUpload(parentCtx, "materials", "lesson-x.html", makeTmp("x"), "text/html"), /topic/);
    expectApiError(() => fsSaveUpload(parentCtx, "materials", "论语.html", makeTmp("x"), "text/html"), /topic/);
    expectApiError(() => fsMkdir(parentCtx, "materials", "论语学而篇"), /topic/);
  });

  it("跨区转存：workspace 文件 move 进 materials = putMaterial 流程（复制 + 删源 + 索引）", () => {
    writeFileSync(path.join(CHILD_ROOT, "scratch", "game.html"), "<p>g</p>");
    const r = fsMove(parentCtx, `${CID}/scratch/game.html`, "materials/lunyu", { confirm: true });
    expect(r.path).toBe("materials/lunyu/game.html");
    expect(status(path.join(CHILD_ROOT, "scratch", "game.html"))).toBe(false);
    expect(status(path.join(MAT_ROOT, "lunyu", "game.html"))).toBe(true);
    expect(listMaterialsMeta(dataDir, PID).map((m) => m.path)).toContain("lunyu/game.html");
  });

  it("R-1：materials 文件被 courses.html_path / display_contents / exam_plans 引用时，删除不带 confirm → needsConfirm", () => {
    // 课程引用（家长库）
    const lib = openParentLib(dataDir, PID);
    lib.prepare("INSERT INTO topics (name, topic_key) VALUES ('lunyu', 'lunyu')").run();
    lib.prepare("INSERT INTO courses (topic, title, html_path) VALUES ('lunyu', '第一章', 'lunyu/lesson-02.html')").run();
    lib.close();
    // 孩子库：展示登记 + 考核计划（scope 引用课程名）
    const kb = openKb(dataDir, PID, CID);
    kb.prepare(
      "INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES ('main', 'materials/lunyu/lesson-02.html', 'l2', 'materials', '', 1)"
    ).run();
    kb.prepare(
      "INSERT INTO exam_plans (id, title, scope_json, active, created_at, updated_at) VALUES ('ep1', '论语考核', ?, 1, ?, ?)"
    ).run(JSON.stringify({ courses: ["第一章"] }), now, now);
    kb.close();

    writeFileSync(path.join(LEGACY_MAT_ROOT, "lunyu", "lesson-02.html"), "<p>l2</p>"); // 存量在旧根
    const refs = findMaterialReferences(parentCtx, "lunyu/lesson-02.html");
    expect(refs.map((x) => x.source).sort()).toEqual(["course", "display", "exam_plan"]);

    const blocked = fsDelete(parentCtx, "materials/lunyu/lesson-02.html", { confirm: false });
    expect((blocked as { needsConfirm?: boolean }).needsConfirm).toBe(true);
    expect((blocked as { refs: unknown[] }).refs.length).toBeGreaterThan(0);
    // 未确认不落盘
    expect(status(path.join(LEGACY_MAT_ROOT, "lunyu", "lesson-02.html"))).toBe(true);

    // confirm:true → 真删（索引行同步清理）
    const done = fsDelete(parentCtx, "materials/lunyu/lesson-02.html", { confirm: true });
    expect((done as { ok?: boolean }).ok).toBe(true);
    expect(status(path.join(LEGACY_MAT_ROOT, "lunyu", "lesson-02.html"))).toBe(false);
  });

  it("R-1：目录删除按前缀聚合引用（courses 行仍指向已删文件时目录级也被拦截）；无引用改名放行", () => {
    // 第一章的 html_path 仍指向 lunyu/lesson-02.html（上一步文件已删、课程行还在）→ lunyu 目录级命中
    const refs = findMaterialReferences(parentCtx, "lunyu");
    expect(refs.map((x) => x.source)).toContain("course");
    const blocked = fsDelete(parentCtx, "materials/lunyu", {});
    expect((blocked as { needsConfirm?: boolean }).needsConfirm).toBe(true);
    expect(status(path.join(MAT_ROOT, "lunyu", "game.html"))).toBe(true);

    // 无引用的改名不需要确认
    const rn = fsRename(parentCtx, "materials/lunyu/game.html", "game2.html", { confirm: false });
    expect(rn.path).toBe("materials/lunyu/game2.html");
    expect(status(path.join(MAT_ROOT, "lunyu", "game2.html"))).toBe(true);
  });

  it("R-8 保留区根不可删改", () => {
    expectApiError(() => fsDelete(parentCtx, "materials", {}), /保留区/);
    expectApiError(() => fsDelete(parentCtx, "uploads", {}), /保留区/);
    expectApiError(() => fsRename(parentCtx, "materials", "m2", {}), /保留区/);
    expectApiError(() => fsMove(parentCtx, "materials", CID, {}), /保留区/);
  });

  it("子树检索：范围内向下命中（含目录），返回虚拟路径；空词/越界拒绝", () => {
    writeFileSync(path.join(MAT_ROOT, "lunyu", "deep", "needle.html"), "<p>n</p>");
    const r = fsSearch(parentCtx, "", "needle");
    expect(r.entries.map((e) => e.path)).toContain("materials/lunyu/deep/needle.html");
    // 目录也参与命中（点击可跳转）
    const dirHit = fsSearch(parentCtx, "materials", "lunyu").entries.find((e) => e.type === "dir");
    expect(dirHit?.path).toBe("materials/lunyu");

    // 孩子 scope：只能搜自己工作区；越界基础目录拒绝
    writeFileSync(path.join(CHILD_ROOT, "outputs", "my-game.html"), "<p>g</p>");
    const cr = fsSearch(childCtx, "", "my-game");
    expect(cr.entries.map((e) => e.path)).toContain("outputs/my-game.html");
    expect(fsSearch(childCtx, "", "game").entries.every((e) => !e.path.startsWith("../"))).toBe(true);
    expect(() => fsSearch(childCtx, "..", "x")).toThrow();
    expectApiError(() => fsSearch(parentCtx, "", "  "), /检索词/);
    expectApiError(() => fsSearch(parentCtx, "no/such/dir", "x"), /目录不存在/);

    // 运行时目录（.pi/node_modules/.git）不进检索：烧预算的 agent 状态目录不是用户内容
    writeFileSync(path.join(MAT_ROOT, "lunyu", ".pi", "node_modules", "needle.js"), "x");
    const r2 = fsSearch(parentCtx, "materials", "needle");
    expect(r2.entries.map((e) => e.path)).not.toContain("materials/lunyu/.pi/node_modules/needle.js");
    expect(r2.entries.map((e) => e.path)).toContain("materials/lunyu/deep/needle.html");
  });
});

describe("ISSUE-131 uploads 区（files 通道原始件）", () => {
  it("上传进 uploads：uuid 落新根 + files 表登记 original_name；列表带展示名与 fileId（合旧根）", () => {
    const r = fsSaveUpload(parentCtx, "uploads", "作业.txt", makeTmp("hw"), "text/plain");
    expect(r.entry.name).toBe("作业.txt");
    expect(r.entry.fileId).toBeTruthy();
    expect(r.entry.path).toMatch(/^uploads\/[0-9a-f-]{36}\.txt$/);
    const stored = r.entry.path.slice("uploads/".length);
    expect(status(path.join(FILES_ROOT, stored))).toBe(true); // 新根 workspaces/<pid>/uploads
    const row = db
      .prepare("SELECT original_name FROM files WHERE parent_id = ? AND stored_path = ?")
      .get(PID, stored) as { original_name: string } | undefined;
    expect(row?.original_name).toBe("作业.txt");

    // 存量在旧根（files/<pid>）也可见，files 表补展示名
    writeFileSync(path.join(LEGACY_FILES_ROOT, "legacy-uuid.mp3"), "old");
    db.prepare(
      "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, NULL, ?, ?, ?, 3, ?)"
    ).run("f-legacy-1", PID, "旧录音.mp3", "legacy-uuid.mp3", "audio/mpeg", now);
    const list = fsList(parentCtx, "uploads");
    const legacy = list.entries.find((e) => e.path === "uploads/legacy-uuid.mp3");
    expect(legacy?.name).toBe("旧录音.mp3");
    expect(legacy?.fileId).toBe("f-legacy-1");
    const hit = list.entries.find((e) => e.name === "作业.txt");
    expect(hit?.fileId).toBeTruthy();
  });

  it("P2 uploads 区放开：改名（同步 files 行 stored_path）/自建目录可用；跨区移动仍拒；删除连行一起清", () => {
    const list = fsList(parentCtx, "uploads");
    const hit = list.entries.find((e) => e.name === "作业.txt")!;
    // 跨区移动仍拒（files/<id> 引用语义）
    expectApiError(() => fsMove(parentCtx, hit.path, "materials", { confirm: true }), /跨区移动/);
    expectApiError(() => fsMove(parentCtx, `${CID}/dup.txt`, "uploads", { confirm: true }), /跨区移动/);

    // 区内改名：磁盘与 files 表 stored_path 同步
    const rn = fsRename(parentCtx, hit.path, "renamed-作业.txt", { confirm: true });
    expect(rn.path).toBe(`uploads/${(rn.path as string).slice("uploads/".length)}`);
    const newStored = (rn.path as string).slice("uploads/".length);
    expect(status(path.join(FILES_ROOT, newStored))).toBe(true);
    const movedRow = db
      .prepare("SELECT id FROM files WHERE parent_id = ? AND stored_path = ?")
      .get(PID, newStored);
    expect(movedRow).toBeTruthy();
    const oldRow = db
      .prepare("SELECT id FROM files WHERE parent_id = ? AND stored_path = ?")
      .get(PID, hit.path.slice("uploads/".length));
    expect(oldRow).toBeFalsy();

    fsMkdir(parentCtx, "uploads", "sub"); // P2 新根支持子目录

    fsDelete(parentCtx, `uploads/${newStored}`, { confirm: true });
    const row = db
      .prepare("SELECT id FROM files WHERE parent_id = ? AND stored_path = ?")
      .get(PID, newStored);
    expect(row).toBeFalsy();
  });
});

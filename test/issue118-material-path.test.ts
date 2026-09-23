/**
 * ISSUE-118 修复回归（2026-09-19）：parent_build_material 的输出路径路由。
 *
 * 修复前：path 不带 `materials/` 虚拟前缀（如 `lunyu/x.html`，与 parent_put_material 同语法）会
 * 静默落到家长工作区 `workspaces/<parentId>/parent/`——display_content 不可穿管、无管理入口。
 * 修复后（家长侧恒落资料真源）：
 * - 根相对路径 `<topic>/<file>.html` → `<dataDir>/materials/<parentId>/<topic>/<file>.html`；
 * - 兼容旧 `materials/` 前缀（剥掉后同根）；
 * - topic 段（第一级目录）必须 `^[a-zA-Z0-9_-]+$`（与 /materials/upload、parent_put_material 同规则）；
 * - 孩子侧行为不变（materials/ 前缀 → 真源；outputs/… → 孩子工作区）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { resolveLessonOutputPath } from "../server/src/agent/programming-agent";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue118-"));
const parentId = "parent-118";
const deps = { dataDir, db: openDb(dataDir), parentId };

afterAll(() => {
  try {
    deps.db.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

// ISSUE-131 P2：资料真源物理根已并入家长工作区（workspaces/<pid>/materials）；旧根 materials/<pid> 只读兜底
const MAT_ROOT = path.join(dataDir, "workspaces", parentId, "materials");

describe("ISSUE-118 parent_build_material 输出路径路由", () => {
  it("家长侧根相对路径（与 parent_put_material 同语法）→ 资料真源", () => {
    const r = resolveLessonOutputPath(deps, "lunyu/lesson-01.html");
    expect(r.base).toBe(MAT_ROOT);
    expect(r.resolved).toBe(path.join(MAT_ROOT, "lunyu", "lesson-01.html"));
    expect(r.relPath).toBe("materials/lunyu/lesson-01.html");
  });

  it("家长侧兼容旧 materials/ 前缀 → 同一落点（前缀剥掉）", () => {
    const r = resolveLessonOutputPath(deps, "materials/lunyu/lesson-01.html");
    expect(r.resolved).toBe(path.join(MAT_ROOT, "lunyu", "lesson-01.html"));
    expect(r.relPath).toBe("materials/lunyu/lesson-01.html");
  });

  it("家长侧任意合法路径都锚定 materials 根（ISSUE-131 P2 后真源在 workspaces/<pid>/materials 内）", () => {
    const r = resolveLessonOutputPath(deps, "english/01-什么是英语/index.html");
    expect(r.base).toBe(MAT_ROOT);
    expect(r.resolved).toBe(path.join(MAT_ROOT, "english", "01-什么是英语", "index.html"));
  });

  it("家长侧 topic 段非法（中文/点段）→ 明确报错", () => {
    expect(() => resolveLessonOutputPath(deps, "论语学而篇/lesson.html")).toThrow(/topic/);
    expect(() => resolveLessonOutputPath(deps, "../escape.html")).toThrow();
  });

  it("仅允许 .html/.htm", () => {
    expect(() => resolveLessonOutputPath(deps, "lunyu/lesson-01.htm")).not.toThrow();
    expect(() => resolveLessonOutputPath(deps, "lunyu/lesson-01.txt")).toThrow(/\.html/);
  });

  it("孩子侧行为不变：outputs/… → 孩子工作区；materials/… → 资料真源", () => {
    const childRoot = path.join(dataDir, "workspaces", parentId, "child-116");
    const r1 = resolveLessonOutputPath(deps, "outputs/番茄钟.html", childRoot);
    expect(r1.resolved).toBe(path.join(childRoot, "outputs", "番茄钟.html"));
    expect(r1.relPath).toBe("outputs/番茄钟.html");
    const r2 = resolveLessonOutputPath(deps, "materials/lunyu/shared.html", childRoot);
    expect(r2.resolved).toBe(path.join(MAT_ROOT, "lunyu", "shared.html"));
    expect(r2.relPath).toBe("materials/lunyu/shared.html");
  });

  it("越界路径仍被沙箱拦截", () => {
    expect(() => resolveLessonOutputPath(deps, "lunyu/../../escape.html")).toThrow();
  });
});

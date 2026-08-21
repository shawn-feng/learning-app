import { describe, it, expect } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { lintMethodKbRefs } from "../electron/lib/kb-lint";

function makeChild(methodContent: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lint-"));
  const learning = path.join(dir, "learning", "testtopic");
  fs.mkdirSync(learning, { recursive: true });
  fs.writeFileSync(path.join(learning, "method.md"), methodContent, "utf-8");
  return dir;
}

describe("lintMethodKbRefs (ISSUE-022，SQLite 化后工具名)", () => {
  it("规范 method.md 不产生任何 warning", () => {
    const good = [
      "### 记录",
      "1. 更新进度用 `kb_update`：`kb_update {table:\"progress\", topic:\"testtopic\", item:\"x\", field:\"状态\", value:\"✅\"}`",
      "2. 写 daily「学习」记录用 `kb_insert`：`kb_insert {table:\"daily\", date:\"2026-08-20\", block:\"学习\", content:\"### x\"}`",
      "3. 查询生活事件用 `kb_query`：`kb_query {query:\"daily\", date:\"2026-08-20\", block:\"生活\", listOnly:true}`",
    ].join("\n");
    const dir = makeChild(good);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues).toHaveLength(0);
  });

  it("检测过时工具名 kb_get", () => {
    const bad = "用 `kb_get {file:\"daily/2026-08-20.md\"}` 读取";
    const dir = makeChild(bad);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("kb_get"))).toBe(true);
  });

  it("检测 SQLite 化前旧工具名 kb_append（应报过时）", () => {
    const bad = "用 `kb_append {file:\"daily/2026-08-20.md\", block:\"学习\", content:\"### x\"}` 写";
    const dir = makeChild(bad);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("kb_append"))).toBe(true);
  });

  it("检测 kb_insert 缺少 table", () => {
    const bad = "用 `kb_insert {date:\"2026-08-20\", block:\"学习\"}` 写";
    const dir = makeChild(bad);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("kb_insert") && i.message.includes("table"))).toBe(true);
  });

  it("检测 kb_update 缺少 field/value", () => {
    const bad = "用 `kb_update {table:\"progress\", topic:\"testtopic\", item:\"x\"}` 更新";
    const dir = makeChild(bad);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("kb_update") && i.message.includes("value"))).toBe(true);
  });

  it("检测数据文件裸 write 调用", () => {
    const bad = '用 `write("daily/2026-08-20.md")` 写';
    const dir = makeChild(bad);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("不应裸 write/edit"))).toBe(true);
  });

  it("不误伤「禁止 write/edit 裸写」教学文案", () => {
    const txt =
      '用 kb_update（禁止 write/edit 裸写）：`kb_update {table:"course", topic:"testtopic", item:"x", field:"状态", value:"✅"}`';
    const dir = makeChild(txt);
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues.some((i) => i.message.includes("不应裸 write/edit"))).toBe(false);
    // 规范的 kb_update 调用不应报缺参
    expect(issues).toHaveLength(0);
  });

  it("对真实 lunyu method.md 零误报", () => {
    // 直接读取项目内真实文件验证（若存在）
    const real = path.resolve(__dirname, "../data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/method.md");
    if (!fs.existsSync(real)) return; // 数据缺失时跳过
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-lint-real-"));
    const learning = path.join(dir, "learning", "lunyu");
    fs.mkdirSync(learning, { recursive: true });
    fs.copyFileSync(real, path.join(learning, "method.md"));
    const issues: any[] = [];
    lintMethodKbRefs(dir, issues);
    expect(issues).toHaveLength(0);
  });
});

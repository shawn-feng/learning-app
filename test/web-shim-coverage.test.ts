/**
 * web shim 覆盖回归（2026-09-22，ISSUE-129 白屏事件后续）：
 * 渲染层调用的每个 window.api.* 方法都必须在 web shim 里有定义——
 * 此前 parentReportGet（ISSUE-108）只在 preload 里加，web shim 缺失 →
 * 家长 Dashboard 挂载时同步 TypeError → web 家长模式整页白屏。
 * 本测试用「多行感知」的源码扫描做静态比对，新增 window.api 方法时若漏配 shim 会直接红。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const EXCLUDE = ["out", "node_modules", "dist"];

function listFiles(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE.includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) listFiles(full, exts, acc);
    else if (exts.some((x) => e.name.endsWith(x))) acc.push(full);
  }
  return acc;
}

function collectUsed(): Set<string> {
  const used = new Set<string>();
  for (const f of listFiles(path.join(ROOT, "src"), [".tsx", ".ts"])) {
    const src = fs.readFileSync(f, "utf-8");
    for (const m of src.matchAll(/window\.api\s*\.\s*([A-Za-z_]\w*)/g)) used.add(m[1]);
  }
  return used;
}

function collectShimKeys(): Set<string> {
  const defined = new Set<string>();
  const shimDir = path.join(ROOT, "web", "src", "shim");
  for (const f of listFiles(shimDir, [".ts"])) {
    const src = fs.readFileSync(f, "utf-8");
    // 域对象/组合对象的顶层键（两格缩进 key:）
    for (const m of src.matchAll(/^ {2}([A-Za-z_]\w*)\s*:/gm)) defined.add(m[1]);
  }
  return defined;
}

describe("web shim 覆盖（家长白屏回归）", () => {
  it("渲染层使用的 window.api.* 在 web shim 中全部有定义", () => {
    const used = collectUsed();
    const defined = collectShimKeys();
    const missing = [...used].filter((u) => u !== "__web" && !defined.has(u));
    expect(missing, `以下方法渲染层在用但 web shim 未实现（Electron-only 新增时必须同步 shim）：\n${missing.join("\n")}`).toEqual([]);
  });
});

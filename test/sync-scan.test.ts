import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

// 纯 node 环境没有 electron；config.ts 顶部 `import { app } from "electron"` 需打桩。
vi.mock("electron", () => ({ app: undefined }));

import { scanDirectory, hashFile } from "../electron/lib/sync-manager";

// ISSUE-011：所有测试用 os.tmpdir() 下的临时目录，不碰真实 data/（避免沙箱 EPERM）
const tmpRoots: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-scan-test-"));
  tmpRoots.push(dir);
  return dir;
}

function write(root: string, rel: string, content: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
});

describe("ISSUE-011 scanDirectory：异步扫描 + 流式哈希", () => {
  it("递归扫描返回相对路径 + size + mtimeMs，排除 .pi 目录，. 开头的文件不排除", async () => {
    const root = makeTmpDir();
    write(root, "a.txt", "hello");
    write(root, "sub/b.md", "world");
    write(root, ".gitignore", "# ignore\n");
    write(root, ".pi/session.jsonl", "{}"); // 应被排除
    write(root, "sub/.hidden-dir/x.txt", "x"); // 隐藏目录不在排除名单，不应排除

    const files = await scanDirectory(root);
    const paths = files.map((f) => f.path).sort();

    expect(paths).toEqual([".gitignore", "a.txt", "sub/.hidden-dir/x.txt", "sub/b.md"]);
    expect(paths).not.toContain(".pi/session.jsonl");

    const a = files.find((f) => f.path === "a.txt")!;
    expect(a.size).toBe(5);
    expect(a.mtimeMs).toBeGreaterThan(0);
  });

  it("不存在的目录返回空数组，不抛错", async () => {
    const files = await scanDirectory(path.join(os.tmpdir(), "definitely-not-exist-xyz"));
    expect(files).toEqual([]);
  });

  it("流式哈希与同步 sha256 结果一致（含较大内容）", async () => {
    const root = makeTmpDir();
    const content = crypto.randomBytes(256 * 1024).toString("hex"); // 512KB，模拟大文件
    const p = write(root, "big.txt", content);

    const streamed = await hashFile(p);
    const syncHash = crypto.createHash("sha256").update(content).digest("hex");
    expect(streamed).toBe(syncHash);
  });

  it("扫描期间让出事件循环：25+ 文件时 scanDirectory 内部调用 setImmediate", async () => {
    const root = makeTmpDir();
    for (let i = 0; i < 40; i++) {
      write(root, `f${i}.txt`, `content-${i}`);
    }

    // scanDirectory 每 SCAN_YIELD_EVERY 个文件 await setImmediate() 让出事件循环。
    // 验证方式：spy 全局 setImmediate（保留原行为），统计扫描期间的调用次数。
    // 不用 setInterval 计数，避免 interval 残留导致 vitest threads worker 无法退出。
    const origImmediate = global.setImmediate;
    let yieldCalls = 0;
    const spy = vi.spyOn(global, "setImmediate").mockImplementation(((cb: () => void, ...args: unknown[]) => {
      yieldCalls++;
      return origImmediate(cb as () => void, ...(args as []));
    }) as typeof setImmediate);

    try {
      const files = await scanDirectory(root);
      expect(files).toHaveLength(40);
    } finally {
      spy.mockRestore();
    }

    expect(yieldCalls, "扫描 40 个文件应至少让出一次事件循环").toBeGreaterThanOrEqual(1);
  });
});

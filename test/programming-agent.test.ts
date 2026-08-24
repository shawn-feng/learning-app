import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateHtmlLesson } from "../electron/lib/programming-agent";
import { getProgrammingModelKey, setProgrammingModelKey } from "../electron/lib/app-settings";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * ISSUE-020 编程 agent 守卫逻辑测试。
 * 只测「不触碰真实 SDK 会话」的纯逻辑：
 *  1. 路径守卫（越界/非 html 扩展名）在会话创建前拦截；
 *  2. 未配置编程模型时报错并提示去设置页（不创建目录、不写文件）；
 *  3. 配置项读写往返。
 *
 * ⚠️ 数据隔离：本测试依赖 vitest 配置注入的环境变量 PI_TEST_DATA_DIR（指向 os.tmpdir 下的临时目录），
 * getDataDir() 会优先使用该目录，故所有读写都落在临时目录、**绝不碰真实的 data/app-settings.json**，
 * 避免测试运行/中断导致用户已保存的编程模型配置被清空（2026-08-24 珊珊会话实测丢失的根因）。
 * 因此这里不再需要在 beforeAll/afterAll 里保存/恢复用户真实配置。
 */
describe("programming-agent（ISSUE-020）", () => {
  // 基线：确保隔离目录下的编程模型为「未配置」（空），以断言「未配置」行为。
  // 由于使用独立临时目录，这只是清空测试自己的文件，不影响用户真实配置。
  beforeAll(() => {
    setProgrammingModelKey("");
  });

  it("outputPath 越界（../）时拒绝，即使模型未配置", async () => {
    await expect(
      generateHtmlLesson({
        childId: "test-child",
        title: "越界测试",
        requirement: "x",
        outputPath: "../evil.html",
      })
    ).rejects.toThrow("输出路径超出允许范围");
  });

  it("非 .html/.htm 输出路径被拒绝", async () => {
    await expect(
      generateHtmlLesson({
        childId: "test-child",
        title: "扩展名测试",
        requirement: "x",
        outputPath: "learning/a/materials/b.txt",
      })
    ).rejects.toThrow("只产出 .html/.htm");
  });

  it("合法路径但未配置编程模型时，报错并提示家长去设置页配置", async () => {
    await expect(
      generateHtmlLesson({
        childId: "test-child",
        title: "未配置测试",
        requirement: "x",
        outputPath: "learning/a/materials/b.html",
      })
    ).rejects.toThrow("未配置模型");
  });

  it("编程模型配置项读写往返（设置 → 读取 → 清空）", () => {
    setProgrammingModelKey("qwen/qwen-max");
    expect(getProgrammingModelKey()).toBe("qwen/qwen-max");
    setProgrammingModelKey("");
    expect(getProgrammingModelKey()).toBe("");
  });

  // 收尾：清理临时数据目录，避免残留。
  afterAll(() => {
    const dir = process.env["PI_TEST_DATA_DIR"];
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


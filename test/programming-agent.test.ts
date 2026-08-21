import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateHtmlLesson } from "../electron/lib/programming-agent";
import { getProgrammingModelKey, setProgrammingModelKey } from "../electron/lib/app-settings";

/**
 * ISSUE-020 编程 agent 守卫逻辑测试。
 * 只测「不触碰真实 SDK 会话」的纯逻辑：
 *  1. 路径守卫（越界/非 html 扩展名）在会话创建前拦截；
 *  2. 未配置编程模型时报错并提示去设置页（不创建目录、不写文件）；
 *  3. 配置项读写往返。
 * 注：generateHtmlLesson 在「未配置模型」时于 getProgrammingAgentSession 内抛错，
 * mkdirSync 位于会话创建之后，故合法路径 + 未配置场景不会产生任何文件副作用。
 */
describe("programming-agent（ISSUE-020）", () => {
  // 基线：确保测试环境未配置编程模型（若真实用户已配置，断言会失真）
  beforeAll(() => {
    setProgrammingModelKey("");
  });
  afterAll(() => {
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
    ).rejects.toThrow("输出路径超出学习目录范围");
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
});

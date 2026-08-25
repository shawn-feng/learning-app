import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

describe("config: 开发模式接入公网（getCloudApiBase / getUpdateFeedUrl）", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.CLOUD_API_URL;
    delete process.env.UPDATE_FEED_URL;
    vi.resetModules();
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it("未打包（开发模式）默认返回公网认证地址", async () => {
    const { getCloudApiBase } = await import("../electron/lib/config");
    expect(getCloudApiBase()).toBe("https://www.aixuexihao.top");
  });

  it("CLOUD_API_URL 环境变量仍可覆盖（本地联调）", async () => {
    process.env.CLOUD_API_URL = "http://localhost:8000";
    const { getCloudApiBase } = await import("../electron/lib/config");
    expect(getCloudApiBase()).toBe("http://localhost:8000");
  });

  it("getUpdateFeedUrl 开发模式默认返回公网 download 地址", async () => {
    const { getUpdateFeedUrl } = await import("../electron/lib/config");
    expect(getUpdateFeedUrl()).toBe("https://www.aixuexihao.top/download/");
  });

  it("UPDATE_FEED_URL 环境变量仍可覆盖", async () => {
    process.env.UPDATE_FEED_URL = "http://localhost:8000/download/";
    const { getUpdateFeedUrl } = await import("../electron/lib/config");
    expect(getUpdateFeedUrl()).toBe("http://localhost:8000/download/");
  });
});

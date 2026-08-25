import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ISSUE-041 层 C：云端事件轮询配置（默认开启 2 分钟、保存钳制 1-60）
import {
  getEventPollConfig,
  setEventPollConfig,
} from "../electron/lib/scheduler.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-eventpoll-test-"));

beforeAll(() => {
  process.env.PI_TEST_DATA_DIR = TEST_DIR;
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  delete process.env.PI_TEST_DATA_DIR;
});

describe("eventPoll 配置（scheduler-config.json 的 eventPoll 段）", () => {
  it("默认：开启、2 分钟", () => {
    const c = getEventPollConfig();
    expect(c.enabled).toBe(true);
    expect(c.intervalMinutes).toBe(2);
  });

  it("保存后读取一致；间隔钳制在 1-60 分钟", () => {
    const saved = setEventPollConfig({ enabled: false, intervalMinutes: 999 });
    expect(saved.intervalMinutes).toBe(60);
    expect(getEventPollConfig().enabled).toBe(false);
    expect(getEventPollConfig().intervalMinutes).toBe(60);

    const tiny = setEventPollConfig({ enabled: true, intervalMinutes: 0 });
    expect(tiny.intervalMinutes).toBe(1);
    expect(getEventPollConfig().intervalMinutes).toBe(1);
  });
});

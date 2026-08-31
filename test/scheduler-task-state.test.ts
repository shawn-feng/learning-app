import { describe, it, expect } from "vitest";
import { getChildState, type TaskState } from "../electron/lib/scheduler";

// 回归测试：getChildState 必须容忍磁盘上已有的 task-state.json 缺失后续新增的任务键，
// 否则 cron 读到 undefined.lastRun 会崩溃（见 auto-new-session 上线后 node-cron 报错）。
describe("getChildState 向前兼容老结构", () => {
  it("老结构（仅 recording）缺失 auto-new-session/event-poll/class-reminder 时不崩溃且补齐该键", () => {
    const state: TaskState = {
      children: {
        // 模拟升级前已存在于磁盘上的孩子状态，没有 auto-new-session/event-poll/class-reminder 键
        "kid-1": {
          recording: { lastRun: "2026-08-17T12:00:00.000Z" },
        },
      },
    };

    const cs = getChildState(state, "kid-1");
    // 关键：不抛错，且后续新增的任务键被补齐为合法对象
    expect(cs["auto-new-session"]).toBeDefined();
    expect(cs["auto-new-session"].lastRun).toBe("");
    expect(cs["event-poll"]).toBeDefined();
    expect(cs["event-poll"].lastRun).toBe("");
    // ISSUE-019：课程提醒键（lastKey，非 lastRun）
    expect(cs["class-reminder"]).toBeDefined();
    expect(cs["class-reminder"].lastKey).toBe("");
    // 旧字段的 lastRun 必须保留，不能被覆盖
    expect(cs.recording.lastRun).toBe("2026-08-17T12:00:00.000Z");
  });

  it("嵌套键缺失 lastRun 时用空串兜底（不丢失已有 lastRun）", () => {
    const state: TaskState = {
      children: {
        "kid-2": {
          recording: { lastRun: "2026-08-10T08:00:00.000Z" },
          "auto-new-session": { lastRun: "2026-08-18T21:00:00.000Z" },
          "event-poll": { lastRun: "2026-08-18T21:02:00.000Z" },
          "class-reminder": { lastKey: "2026-08-18:start:08:00:语文" },
        },
      },
    };
    const cs = getChildState(state, "kid-2");
    expect(cs["auto-new-session"].lastRun).toBe("2026-08-18T21:00:00.000Z");
    expect(cs["event-poll"].lastRun).toBe("2026-08-18T21:02:00.000Z");
    expect(cs.recording.lastRun).toBe("2026-08-10T08:00:00.000Z");
    expect(cs["class-reminder"].lastKey).toBe("2026-08-18:start:08:00:语文");
  });

  it("全新孩子初始化出完整四键结构（recording / auto-new-session / event-poll / class-reminder）", () => {
    const state: TaskState = { children: {} };
    const cs = getChildState(state, "kid-3");
    expect(Object.keys(cs).sort()).toEqual(
      ["auto-new-session", "class-reminder", "event-poll", "recording"].sort()
    );
    expect(cs.recording.lastRun).toBe("");
    expect(cs["auto-new-session"].lastRun).toBe("");
    expect(cs["event-poll"].lastRun).toBe("");
    expect(cs["class-reminder"].lastKey).toBe("");
  });
});

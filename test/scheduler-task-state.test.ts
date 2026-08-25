import { describe, it, expect } from "vitest";
import { getChildState, type TaskState } from "../electron/lib/scheduler";

// 回归测试：getChildState 必须容忍磁盘上已有的 task-state.json 缺失后续新增的任务键，
// 否则 cron 读到 undefined.lastRun 会崩溃（见 auto-new-session 上线后 node-cron 报错）。
describe("getChildState 向前兼容老结构", () => {
  it("老结构（仅 recording/session-reset）缺失 auto-new-session 时不崩溃且补齐该键", () => {
    const state: TaskState = {
      children: {
        // 模拟升级前已存在于磁盘上的孩子状态，没有 auto-new-session 键
        "kid-1": {
          recording: { lastRun: "2026-08-17T12:00:00.000Z" },
          "session-reset": { lastRun: "" },
        },
      },
    };

    const cs = getChildState(state, "kid-1");
    // 关键：不抛错，且 auto-new-session 被补齐为合法对象
    expect(cs["auto-new-session"]).toBeDefined();
    expect(cs["auto-new-session"].lastRun).toBe("");
    // 旧字段的 lastRun 必须保留，不能被覆盖
    expect(cs.recording.lastRun).toBe("2026-08-17T12:00:00.000Z");
    expect(cs["session-reset"].lastRun).toBe("");
  });

  it("嵌套键缺失 lastRun 时用空串兜底（不丢失已有 lastRun）", () => {
    const state: TaskState = {
      children: {
        "kid-2": {
          recording: { lastRun: "2026-08-10T08:00:00.000Z" },
          "session-reset": { lastRun: "2026-08-10T22:00:00.000Z" },
          "auto-new-session": { lastRun: "2026-08-18T21:00:00.000Z" },
        },
      },
    };
    const cs = getChildState(state, "kid-2");
    expect(cs["auto-new-session"].lastRun).toBe("2026-08-18T21:00:00.000Z");
    expect(cs.recording.lastRun).toBe("2026-08-10T08:00:00.000Z");
  });

  it("全新孩子初始化出完整四键结构（含 ISSUE-041 层 C 的 event-poll）", () => {
    const state: TaskState = { children: {} };
    const cs = getChildState(state, "kid-3");
    expect(Object.keys(cs).sort()).toEqual(
      ["auto-new-session", "event-poll", "recording", "session-reset"].sort()
    );
    for (const key of Object.keys(cs)) {
      expect((cs as any)[key].lastRun).toBe("");
    }
  });
});

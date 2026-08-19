import { describe, it, expect } from "vitest";
import { displayContentTool, getDateTool, getProgressTool } from "../electron/lib/custom-tools";

/**
 * 回归测试：ISSUE-006 配套修复。
 *
 * SDK（agent-session.js _refreshToolRegistry）的激活规则：
 *   - `tools` 字段同时充当 allowedToolNames（白名单）；
 *   - 所有 customTools 会先按 isAllowedTool(name) 过滤，名字不在白名单的被丢弃；
 *   - 只有白名单里的工具名才会被推进 active。
 * 因此 customTools 里每个工具的 name 都必须在 `tools` 白名单中出现，否则 agent 拿不到它。
 *
 * 此前 get_progress 漏列进 tools，导致 agent 报告"没有 get_progress 技能"。
 * 下面用与源码一致的白名单断言该不变量，防止再次漏列。
 */
const TOOLS_ALLOWLIST = ["read", "write", "edit", "display_content", "get_date", "get_progress"];

describe("customTools 必须在 tools 白名单内才能激活", () => {
  it("每个 customTool 的 name 都出现在 tools 白名单", () => {
    for (const tool of [displayContentTool, getDateTool, getProgressTool]) {
      expect(TOOLS_ALLOWLIST, `customTool "${tool.name}" 未加入 tools 白名单`).toContain(tool.name);
    }
  });

  it("get_progress 经 isAllowedTool 过滤后仍被保留（即会被注册并激活）", () => {
    const allowed = new Set(TOOLS_ALLOWLIST);
    const isAllowedTool = (name: string) => allowed.has(name);
    expect(getProgressTool.name).toBe("get_progress");
    expect(isAllowedTool(getProgressTool.name)).toBe(true);
  });
});

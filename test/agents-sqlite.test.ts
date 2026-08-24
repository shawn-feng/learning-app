import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("electron", () => ({ app: undefined }));

import { resolveChildAgents, getDefaultPrompt } from "../electron/lib/pi-session";
import { getChildDir, getDataDir } from "../electron/lib/config";
import { saveAgentPrompt, getAgentPrompt } from "../electron/lib/agent-prompts";

const CHILD_ID = "test-child-033";
const PROFILE = {
  childId: CHILD_ID,
  aiName: "小伴",
  name: "宝宝",
  aiEmoji: "🌟",
  aiPersonality: "温柔耐心",
  age: 7,
  grade: "一年级",
  interests: "恐龙",
} as any;

// ISSUE-033（2026-08-24 终版）：AGENTS 纯 SQLite（data/agents.sqlite）存储——
// 不落任何物理文件（孩子目录、家长目录均无 AGENTS.md）；孩子 agent 只读（buildChildPrompt
// 内联注入 resolveChildAgents 的结果）、不可写（无文件可写）；查看/编辑均在家长页面
// （AgentPromptEditor 经 agents:* 接口读写 SQLite）。本测试锁定这些不变量。
describe("ISSUE-033：AGENTS 纯 SQLite 存储，无任何物理 AGENTS 文件", () => {
  const childDir = getChildDir(CHILD_ID);
  const parentAgentsDir = path.join(getDataDir(), "parents", "default", "agents");

  beforeAll(() => {
    // 清理可能残留的用户版本，保证用例独立（空内容=恢复默认）
    saveAgentPrompt("child", CHILD_ID, "");
    // getDefaultPrompt("child") 依赖磁盘 profile.json——写入测试 profile（测试环境走 PI_TEST_DATA_DIR 临时目录）
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(path.join(childDir, "profile.json"), JSON.stringify(PROFILE), "utf-8");
    // 清理旧测试可能残留的家长目录 agents/（保证「不创建物理文件」断言独立）
    fs.rmSync(parentAgentsDir, { recursive: true, force: true });
  });
  afterAll(() => {
    saveAgentPrompt("child", CHILD_ID, "");
  });

  it("resolveChildAgents / getDefaultPrompt 不创建任何 AGENTS 物理文件", () => {
    fs.mkdirSync(childDir, { recursive: true });
    resolveChildAgents(CHILD_ID, PROFILE);
    getDefaultPrompt("child", CHILD_ID);

    // 孩子目录不得出现 AGENTS.md（孩子不可写）
    expect(fs.existsSync(path.join(childDir, "AGENTS.md"))).toBe(false);
    // 家长目录也不得出现 agents/ 目录（AGENTS 纯 SQLite，无同步产物）
    expect(fs.existsSync(parentAgentsDir)).toBe(false);
  });

  it("resolveChildAgents 无用户版本时返回代码默认（buildAgentsMd 内容）", () => {
    expect(getAgentPrompt("child", CHILD_ID)).toBeNull();
    const agents = resolveChildAgents(CHILD_ID, PROFILE);
    expect(agents).toContain(PROFILE.aiName);
    expect(agents).toContain("交流准则");
    expect(agents).toContain("parent_content");
  });

  it("resolveChildAgents 有用户版本时返回用户版本（整体替换，代码默认不叠加）", () => {
    const custom = "你是自定义规范：只陪聊不教学。";
    saveAgentPrompt("child", CHILD_ID, custom);
    try {
      const agents = resolveChildAgents(CHILD_ID, PROFILE);
      expect(agents).toBe(custom);
    } finally {
      saveAgentPrompt("child", CHILD_ID, "");
    }
  });

  it("getDefaultPrompt child 分支返回代码默认（编辑器初始填充用）", () => {
    expect(getDefaultPrompt("child", CHILD_ID)).toContain("交流准则");
  });
});

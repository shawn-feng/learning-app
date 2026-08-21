import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: undefined }));

import { buildAgentsMd } from "../electron/lib/pi-session";

const FAKE_PROFILE = {
  aiName: "小伴",
  name: "宝宝",
  aiEmoji: "🌟",
  aiPersonality: "温柔耐心",
  age: 7,
  grade: "一年级",
  interests: "恐龙",
} as any;

describe("ISSUE-029 孩子 AGENTS.md 内容必须 DB 工具化（不变量锁定）", () => {
  const md = buildAgentsMd(FAKE_PROFILE);

  it("学习方法/教学文案指引用 parent_content 工具，不再读 method.md", () => {
    expect(md).toContain("parent_content");
    expect(md).not.toContain("读该主题的 `method.md`");
    expect(md).not.toContain("先读 `learning/topics.md`");
  });

  it("数据读写一律 kb 工具，禁止 read/write/edit 碰数据文件；不含参数级调用 JSON", () => {
    expect(md).toContain("kb_query");
    expect(md).toContain("kb_insert");
    expect(md).toContain("kb_update");
    expect(md).toContain("禁止用 read/write/edit 碰数据文件");
    expect(md).toContain("一律用 parent_content 获取");
    // ISSUE-029 去重：AGENTS 只写策略红线，不重复工具参数级调用语法
    expect(md).not.toContain('{table:"course"');
    expect(md).not.toContain('{query:"topics"');
    expect(md).not.toContain('{query:"tags"');
    expect(md).not.toContain('{query:"progress"');
  });

  it("进度查询禁读进度文件正文（省上下文）", () => {
    expect(md).toContain("严禁");
    expect(md).toContain("get_progress");
  });
});

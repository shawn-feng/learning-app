/**
 * ISSUE-175 回归：家长 agent「自定义提示词层」（家长补充说明）。
 * ① 未自定义 → system prompt 与现状逐字节一致（不含追加小节）；
 * ② 自定义后 → 以「## 家长补充说明」小节追加，内容原样到位；
 * ③ getAgentPrompt 空内容（存过但清空）→ 同未自定义。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildServerParentPrompt } from "../server/src/agent/parent-registry";
import { saveAgentPrompt, getAgentPrompt } from "../server/src/db/agents";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue175-"));
const PID = "p175";

describe("ISSUE-175 家长自定义层注入", () => {
  it("未自定义 → 不含追加小节（零回归）", () => {
    expect(getAgentPrompt(dir, "parent", PID)).toBeNull();
    const p = buildServerParentPrompt({ parentId: PID, workspace: "/w", today: "2026-10-06" });
    expect(p).not.toContain("家长补充说明");
    expect(p).toContain("场景技能"); // 基底完整
  });

  it("自定义后 → 「## 家长补充说明」小节追加在末尾，内容原样", () => {
    saveAgentPrompt(dir, "parent", PID, "汇报先给结论，再列细节。");
    const note = getAgentPrompt(dir, "parent", PID) ?? "";
    expect(note).toBe("汇报先给结论，再列细节。");
    const p = buildServerParentPrompt({
      parentId: PID,
      workspace: "/w",
      today: "2026-10-06",
      customNote: note,
    });
    expect(p).toContain("## 家长补充说明");
    expect(p).toContain("汇报先给结论，再列细节。");
    expect(p).toContain("与上面的规则同样遵守");
    // 追加段在基底之后（铁律/工作原则已出现）
    expect(p.indexOf("## 家长补充说明")).toBeGreaterThan(p.indexOf("## 工作原则"));
  });

  it("存过但清空（trim 后为空）→ 同未自定义", () => {
    saveAgentPrompt(dir, "parent", PID, "   ");
    expect(getAgentPrompt(dir, "parent", PID)).toBeNull();
    const p = buildServerParentPrompt({ parentId: PID, workspace: "/w", today: "2026-10-06" });
    expect(p).not.toContain("家长补充说明");
  });
});

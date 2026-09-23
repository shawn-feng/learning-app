/**
 * ISSUE-108 回归（2026-09-21 简化定案）：家长报表 = markdown 经 parent_display_report 推送。
 * - 工具：空 markdown 拒绝；正常推送 → settings 留存 + SSE display_content（source=report）；
 * - saveParentReport/getParentReport 往返（重启读回的持久化语义）。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { agentStreamHub } from "../server/src/agent/stream-hub";
import { createParentReportTool, getParentReport, saveParentReport } from "../server/src/agent/parent-report-tool";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue108-"));
const parentId = "parent-108";
const db = openDb(dataDir);
db.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(
  parentId,
  "p108@test",
  new Date().toISOString(),
  new Date().toISOString()
);

afterAll(() => {
  try {
    db.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

function toolText(r: { content: Array<{ type: string; text: string }> }): string {
  return r.content.map((c) => (c as { text: string }).text).join("");
}

describe("ISSUE-108 parent_display_report", () => {
  const pushed: Array<{ type: string; data: any }> = [];
  const streamKey = `parent:${parentId}:parent`;
  const unsub = agentStreamHub.subscribe(streamKey, (e) => pushed.push({ type: e.type, data: e.data as any }));
  const tool = createParentReportTool({ db, parentId, streamKey });

  it("空 markdown → 拒绝", async () => {
    await expect(tool.execute("x", { markdown: "   " })).rejects.toThrow(/markdown/);
  });

  it("正常推送 → settings 留存 + display_content 事件（source=report, content=markdown）", async () => {
    const md = "# 学习周报\n\n- 珊珊：论语 3 课全部通过\n- 闻闻：英语 Unit1 待巩固";
    const r = toolText(await tool.execute("x", { markdown: md, title: "学习周报" }));
    expect(r).toContain("学习周报");
    const saved = getParentReport(db, parentId);
    expect(saved?.title).toBe("学习周报");
    expect(saved?.content).toContain("闻闻");
    const ev = pushed.find((p) => p.type === "display_content");
    expect(ev).toBeTruthy();
    expect(ev!.data.source).toBe("report");
    expect(ev!.data.content).toBe(md);
    expect(ev!.data.path).toMatch(/^report\/\d+\.md$/);
    unsub();
  });

  it("持久化往返（模拟重启后读回）", () => {
    saveParentReport(db, parentId, { title: "T", content: "C", ts: 123 });
    expect(getParentReport(db, parentId)).toEqual({ title: "T", content: "C", ts: 123 });
  });

  it("无报表 → null；坏 JSON → null（不抛）", () => {
    expect(getParentReport(db, "parent-nobody")).toBeNull();
    db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?,?,?)").run(
      "report:bad-json",
      "{broken",
      new Date().toISOString()
    );
    expect(getParentReport(db, "bad-json")).toBeNull();
  });
});

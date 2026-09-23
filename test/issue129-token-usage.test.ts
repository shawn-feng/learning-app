/**
 * ISSUE-129 回归（2026-09-21）：token 用量统计扫描器 + 聚合查询。
 *
 * 守住：
 * ① scanTokenUsageIntoDb：assistant 消息 usage 原样入库（含 model/scope/child_id 归属）；
 *    游标增量（重扫不重复计）；非 assistant / 无 usage / 坏行跳过；尾部半行不推进游标；
 * ② slot 归属：parent* → scope=parent；<childId>-main → child；-scene → scene；-course-* → course；
 * ③ 聚合：queryTokenUsageDays 按日期×渠道、queryTokenUsageSessions 按会话（含多模型 GROUP_CONCAT）。
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { openDb } from "../server/src/db";
import {
  scanTokenUsageIntoDb,
  queryTokenUsageDays,
  queryTokenUsageSessions,
  listTokenUsageDates,
} from "../server/src/db/token-usage";

const PID = "p1";
const CID = "c1";

let dataDir = "";

/** 本地时区安全的时间戳（2026-09-day hour:00 本地时间 → ISO）。 */
function iso(day: number, hour = 10): string {
  return new Date(2026, 8, day, hour, 0, 0).toISOString();
}

function writeSession(relFile: string, lines: unknown[]): void {
  const full = path.join(dataDir, "agent-sessions", PID, relFile);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(
    full,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf-8"
  );
}

function assistantEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "message",
    id: Math.random().toString(16).slice(2, 10),
    parentId: "root",
    timestamp: iso(21, 10),
    message: {
      role: "assistant",
      model: "mimo-v2.5",
      stopReason: "stop",
      usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: 5, totalTokens: 175, cost: { total: 0 } },
    },
    ...overrides,
  };
}

beforeEach(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "token-usage-"));
});

afterEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

describe("scanTokenUsageIntoDb（ISSUE-129）", () => {
  it("assistant usage 原样入库；user 消息与无 usage 条目跳过；slot 归属正确", () => {
    const db = openDb(dataDir);
    try {
      writeSession(`${CID}-main/s1.jsonl`, [
        { type: "session", id: "x" },
        { type: "message", id: "u1", timestamp: iso(21, 9), message: { role: "user", content: "hi" } },
        assistantEntry({ id: "a1", timestamp: iso(21, 10) }),
        { type: "message", id: "n1", timestamp: iso(21, 10), message: { role: "assistant", content: [] } },
        assistantEntry({ id: "a2", timestamp: iso(21, 10), message: { role: "assistant", model: "glm-5", stopReason: "error", usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 7 } } }),
      ]);
      writeSession("parent/ps1.jsonl", [assistantEntry({ id: "p1", timestamp: iso(21, 11) })]);
      writeSession(`${CID}-scene/sc1.jsonl`, [assistantEntry({ id: "s1", timestamp: iso(20, 23) })]);
      writeSession(`${CID}-course-lunyu/c1.jsonl`, [assistantEntry({ id: "c1", timestamp: iso(21, 12) })]);

      const n = scanTokenUsageIntoDb(db, dataDir, PID, [CID]);
      expect(n).toBe(5);

      const days = queryTokenUsageDays(db, PID);
      // 孩子 main：input 107（100+7），error 轮也计
      const childDay = days.find((r) => r.scope === "child");
      expect(childDay?.input).toBe(107);
      expect(childDay?.rounds).toBe(2);
      expect(days.find((r) => r.scope === "scene")?.rounds).toBe(1);
      expect(days.find((r) => r.scope === "course")?.rounds).toBe(1);
      expect(days.find((r) => r.scope === "parent")?.rounds).toBe(1);

      const sessions = queryTokenUsageSessions(db, PID, "2026-09-21");
      expect(sessions.length).toBe(3); // main / parent / course（场景是 09-20）
      const main = sessions.find((s) => s.session_file === `${CID}-main/s1.jsonl`);
      expect(main?.models).toBe("mimo-v2.5,glm-5"); // 热切换过模型 → 逗号串
      expect(main?.rounds).toBe(2);
      const dates = listTokenUsageDates(db, PID);
      expect(dates.map((d) => d.date)).toEqual(["2026-09-21", "2026-09-20"]);
    } finally {
      db.close();
    }
  });

  it("游标增量：重扫不重复；追加只入新行；尾部半行不推进游标", () => {
    const db = openDb(dataDir);
    try {
      const rel = `${CID}-main/s1.jsonl`;
      writeSession(rel, [assistantEntry({ id: "a1" })]);
      expect(scanTokenUsageIntoDb(db, dataDir, PID, [CID])).toBe(1);
      expect(scanTokenUsageIntoDb(db, dataDir, PID, [CID])).toBe(0); // 幂等

      // 追加一条完整行 + 留一行半行（无结尾换行）
      const full = path.join(dataDir, "agent-sessions", PID, rel);
      fs.appendFileSync(full, JSON.stringify(assistantEntry({ id: "a2" })) + "\n" + '{"type":"mess', "utf-8");
      expect(scanTokenUsageIntoDb(db, dataDir, PID, [CID])).toBe(1); // 只入 a2，半行跳过
      const curAfterPartial =
        (db.prepare("SELECT line_count FROM token_usage_files WHERE file = ?").get(rel) as { line_count: number })
          ?.line_count ?? 0;
      expect(curAfterPartial).toBe(2); // 半行未推进

      // 补全半行（"mess" + "age…" = "message"）后再扫：新行入库
      fs.appendFileSync(
        full,
        'age","id":"a3","timestamp":"' + iso(21, 10) + '","message":{"role":"assistant","usage":{"input":1,"totalTokens":1}}}\n',
        "utf-8"
      );
      expect(scanTokenUsageIntoDb(db, dataDir, PID, [CID])).toBe(1);

      const childDay = queryTokenUsageDays(db, PID, { scope: "child" });
      expect(childDay[0]?.rounds).toBe(3);
      expect(queryTokenUsageSessions(db, PID, "2026-09-21")[0]?.input).toBe(201); // 100+100+1
    } finally {
      db.close();
    }
  });

  it("未知 slot（不在孩子列表且非 parent*）不崩溃，归 child/空 childId", () => {
    const db = openDb(dataDir);
    try {
      writeSession("ghost-main/g.jsonl", [assistantEntry({ id: "g1" })]);
      expect(scanTokenUsageIntoDb(db, dataDir, PID, [CID])).toBe(1);
      const day = queryTokenUsageDays(db, PID);
      expect(day[0]?.scope).toBe("child");
      expect(day[0]?.child_id).toBe("");
    } finally {
      db.close();
    }
  });
});

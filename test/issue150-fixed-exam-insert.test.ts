/**
 * ISSUE-150 回归（2026-09-25 发现）：**固定考核从未生成** —— exam_plans 的 INSERT 列数/值数不一致。
 *
 * 现场：`server/data/logs`（本机跑 server 时）每 2 分钟一条
 *   `[worker:plan] exam-fixed parent=… failed: 22 values for 23 columns`
 * ⇒ `ensureTodayExamPlans()` 每次 plan tick 都在抛错，**「每日/每周固定考核」自 2026-09-14 起一条都没生成**
 * （本机实证：配置 `exam_fixed:<pid> = {frequencies:["weekly"], weekly:{weekday:5}}`，孩子库最后一条
 *  `kind='fixed'` 计划的 created_at 停在 2026-09-11，其后 09-18 / 09-25 两个周五都没有）。
 *
 * 根因：`exam_plans` 的列在历史演进中增删（`retake` 等），`server/src/routes/exam.ts` 里两条 INSERT 的
 * `VALUES` 被改坏——一处把占位符写成了**字面量 `'?'`**，且值与列的对应整体错位一格：
 *   - 固定档（worker 调用）：列 23 值 22 → `22 values for 23 columns`；
 *   - 自定义档（`POST /exam/schedules`）：列 24 值 23 → `23 values for 24 columns`。
 * 因为**没有任何测试覆盖这两条 INSERT**，坏了 11 天没人发现（只有日志里有痕）。
 *
 * 本文件做两件事：
 *   A. 静态自检：`server/src/**\/*.ts` 里所有"静态可判定"的 INSERT，列数必须等于值数（这是本轮抓出问题的判据，
 *      同一类错法以后一律在测试里红）；
 *   B. 端到端：真调 `ensureTodayExamPlans()`，断言**确实落库一条 fixed 计划**、字段映射正确、且幂等。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openKb } from "../server/src/db/kb";
import { openParentLib } from "../server/src/db/parent-lib";
import { getCourseUuid, getOrCreateKnowledgePoint, saveQuestion, replaceCourseContent } from "../server/src/db/assess-content";
import { ensureTodayExamPlans } from "../server/src/routes/exam";

// ==================== A. 静态自检 ====================

/** 逗号切分（跳过单引号内与 (){} 内的逗号） */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = false;
  let cur = "";
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === "'") quote = false;
      continue;
    }
    if (c === "'") {
      quote = true;
      cur += c;
      continue;
    }
    if (c === "(" || c === "{") depth++;
    if (c === ")" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("ISSUE-150 A：所有 INSERT 的列数 == 值数（静态自检）", () => {
  it("server/src 下静态可判定的 INSERT 全部一致", () => {
    const root = path.resolve(__dirname, "..", "server", "src");
    const re =
      /INSERT\s+(?:OR\s+REPLACE\s+|OR\s+IGNORE\s+)?INTO\s+([A-Za-z_]\w*)\s*\(([^()]*)\)\s*VALUES\s*\(([^()]*)\)/gis;
    const bad: string[] = [];
    let checked = 0;
    for (const f of walkTs(root)) {
      const src = fs.readFileSync(f, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const cols = splitTop(m[2]);
        const vals = splitTop(m[3]);
        checked++;
        if (cols.length !== vals.length) {
          const line = src.slice(0, m.index).split("\n").length;
          bad.push(
            `${path.relative(root, f)}:${line} ${m[1]} 列 ${cols.length} / 值 ${vals.length}（差 ${cols.length - vals.length}）`
          );
        }
      }
    }
    expect(checked, "至少要扫到几十条才说明正则没失效").toBeGreaterThan(50);
    expect(bad, `INSERT 列数/值数不一致：\n${bad.join("\n")}`).toEqual([]);
  });
});

// ==================== B. 端到端：固定考核真的落库 ====================

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue150-"));
const parentId = "parent-150";
const childId = "child-150";
const COURSE = "论语为政篇第一章";
const today = (() => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

const mainDb = openDb(dataDir);
const nowIso = new Date().toISOString();
mainDb
  .prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)")
  .run(parentId, "p150@test", nowIso, nowIso);
mainDb
  .prepare("INSERT INTO children (id,parent_id,name,created_at,updated_at) VALUES (?,?,?,?,?)")
  .run(childId, parentId, "珊珊", nowIso, nowIso);
// 固定考核配置：每天（daily 恒定命中今天，不受星期影响）
mainDb
  .prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)")
  .run(`exam_fixed:${parentId}`, JSON.stringify({ frequencies: ["daily"], courseCount: 3, time: "20:00" }), nowIso);

function seedContent(): void {
  let pl = openParentLib(dataDir, parentId);
  pl.prepare("INSERT INTO topics (name, topic_key, method, progress, rules_json) VALUES ('lunyu','lunyu','','','{}')").run();
  pl.prepare("INSERT INTO courses (topic, title, sort_order) VALUES ('lunyu', ?, 1)").run(COURSE);
  pl.close();
  pl = openParentLib(dataDir, parentId); // 重开触发 uuid 回填
  const uuid = getCourseUuid(pl, "lunyu", COURSE);
  if (!uuid) throw new Error("seed 失败：course uuid 未生成");
  const kp = getOrCreateKnowledgePoint(pl, uuid, "背诵", "背诵原文");
  const qid = saveQuestion(pl, { stem: "背诵本章原文", answer: "为政以德，譬如北辰", pointMax: 10 });
  replaceCourseContent(pl, uuid, [{ knowledgePointId: kp.id, overview: "", questionIds: [qid] }]);
  pl.close();

  const kb = openKb(dataDir, parentId, childId);
  try {
    kb.prepare("INSERT INTO topics (topic_key, name, rules_json) VALUES ('lunyu','论语','{}')").run();
    kb.prepare("INSERT INTO courses (topic, topic_key, title) VALUES ('lunyu','lunyu', ?)").run(COURSE);
  } finally {
    kb.close();
  }
  // 今日计划里要有这门课（固定考核的候选＝窗口内计划课程）
  mainDb
    .prepare(
      "INSERT INTO study_plan_items (id,parent_id,child_id,date,topic_key,course_name,course_uuid,mode,origin,status,active,created_at,updated_at) VALUES (?,?,?,?,?,?,'','new','conversation','pending',1,?,?)"
    )
    .run("spi_150", parentId, childId, today, "lunyu", COURSE, nowIso, nowIso);
}

afterAll(() => {
  try {
    mainDb.close();
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows WAL 句柄滞后，忽略 */
  }
});

describe("ISSUE-150 B：ensureTodayExamPlans 真的生成固定考核", () => {
  it("首次 tick 生成 1 条 fixed 计划，字段映射正确；再次 tick 幂等返回 0", () => {
    seedContent();
    const created = ensureTodayExamPlans(mainDb, dataDir, parentId);
    expect(created, "固定考核必须真的落库（修复前这里抛 22 values for 23 columns）").toBe(1);

    const kb = openKb(dataDir, parentId, childId);
    try {
      const row = kb
        .prepare("SELECT * FROM exam_plans WHERE kind = 'fixed' AND freq = 'daily'")
        .get() as Record<string, unknown>;
      expect(row, "行没落库").toBeTruthy();
      expect(String(row.title)).toContain("固定");
      expect(String(row.creator)).toBe("parent");
      expect(String(row.origin)).toBe("config");
      expect(String(row.status)).toBe("pending");
      expect(String(row.task_type), "固定考核是必做项").toBe("required");
      expect(Number(row.count_in_rate)).toBe(1);
      expect(Number(row.points)).toBe(0);
      expect(Number(row.active)).toBe(1);
      expect(String(row.attempt_id)).toBe("");
      expect(String(row.done_at)).toBe("");
      expect(String(row.retake), "服务端生成的计划不带重考标准（防连环重考）").toBe("");
      expect(String(row.created_at).length).toBeGreaterThan(10);
      expect(String(row.start_at).startsWith(today)).toBe(true);
      const scope = JSON.parse(String(row.scope_json)) as { courses: Array<{ title: string; kps: unknown[] }> };
      expect(scope.courses.map((c) => c.title)).toContain(COURSE);
    } finally {
      kb.close();
    }

    // 同一天再 tick：同日同 freq 已有 active 计划 → 不再生成
    expect(ensureTodayExamPlans(mainDb, dataDir, parentId)).toBe(0);
  });
});

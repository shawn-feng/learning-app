/**
 * ISSUE-168 护栏：服务端源码禁止直接调 `.toISOString()` 写时间戳（那是 UTC，
 * 与库内本地日期列错位 8 小时）——统一走 `util/time.ts` 的 nowLocalIso/toLocalIso。
 * 白名单仅 util/time.ts 自身（实现）与本测试文件。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { nowLocalIso, toLocalIso } from "../server/src/util/time";

const SRC = path.resolve(__dirname, "../server/src");
const WHITELIST = /util[\\/]time\.ts$/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...walk(p));
    else if (f.endsWith(".ts")) out.push(p);
  }
  return out;
}

describe("ISSUE-168 时区护栏", () => {
  it("server/src 源码不含 .toISOString()（白名单：util/time.ts）", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      if (WHITELIST.test(f)) continue;
      const s = fs.readFileSync(f, "utf8");
      if (s.includes(".toISOString()")) offenders.push(path.relative(SRC, f));
    }
    expect(offenders, `以下文件直接调 .toISOString()，请改用 nowLocalIso()/toLocalIso()：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("datetime('now') 一律带 localtime（题库 touch/建表默认）", () => {
    const offenders: string[] = [];
    for (const f of walk(SRC)) {
      const s = fs.readFileSync(f, "utf8");
      const bare = s.match(/datetime\('now'\)/g);
      if (bare) offenders.push(`${path.relative(SRC, f)} ×${bare.length}`);
    }
    expect(offenders, `裸 datetime('now') 是 UTC，请加 ,'localtime'：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("toLocalIso/nowLocalIso 形态对齐 toISOString（无 Z 后缀、毫秒精度、本地日期）", () => {
    const d = new Date(2026, 9, 6, 14, 30, 5, 123); // 本地 2026-10-06 14:30:05.123
    expect(toLocalIso(d)).toBe("2026-10-06T14:30:05.123");
    const now = nowLocalIso();
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/);
    expect(now).not.toMatch(/Z$/);
    // 与本地日期同口径（和 formatLocalDate 的 YYYY-MM-DD 一致）
    expect(now.slice(0, 10)).toBe(
      `${d.getFullYear()}`.padStart(4, "0") && new Date().toLocaleDateString("sv-SE")
    );
  });
});

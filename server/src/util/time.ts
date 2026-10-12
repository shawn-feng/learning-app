/**
 * 本地时区时间戳收口（ISSUE-168，方案 A）：服务端写库/写日志的时间戳一律用本地时区、
 * 无时区后缀的 ISO 形态（YYYY-MM-DDTHH:mm:ss.sss）——与库内 `YYYY-MM-DD` 日期列同口径，
 * 读侧零转换、按日筛选不再错位 8 小时。
 *
 * ⚠️ server/src 内禁止直接调 `.toISOString()` 写时间戳（那是 UTC）——
 * 护栏：test/issue168-timezone.test.ts 源码扫描（白名单仅本文件）。
 * 存量 UTC 行不回写（历史时间少 8 小时可接受，新旧混存期接受偏差）。
 */

/** Date → 本地时区 ISO（无 Z 后缀，毫秒精度，形态对齐 toISOString）。 */
export function toLocalIso(d: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}

/** 当前时刻的本地时区 ISO。 */
export function nowLocalIso(): string {
  return toLocalIso(new Date());
}

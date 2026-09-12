/** 本地时区 YYYY-MM-DD（不用 toISOString：那是 UTC 日期，东八区晚上会跨到错误的「今天」）。 */
export function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

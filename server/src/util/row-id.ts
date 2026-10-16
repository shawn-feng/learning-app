/**
 * 计划域行 id 定位（ISSUE-185）。
 *
 * 背景：家长/孩子 agent 的列表工具过去只回 `id.slice(0, 8)`，定位时又用
 * `rows.find(r => r.id === want || r.id.startsWith(want))` **取第一条**。
 * 而 `exam_plans` 的自定义考核 id 形如 `ep_<Date.now()>_<rand6>`——同一天建的场次
 * 前 8 位完全相同（现场：珊珊/闻闻当天全部 `ep_17921…`）。结果：agent 手里没有唯一标识，
 * 前缀匹配还可能**撤错行**。
 *
 * 现在的口径：
 * - 列表工具一律回**完整 id**；
 * - 定位一律走本函数：**精确匹配优先**；只有历史习惯传前缀时才退化为 startsWith，
 *   且**多个命中直接报错并列出候选**——绝不猜。
 */
export function resolveRowById<T extends { id: string }>(rows: T[], wantId: unknown, what: string): T {
  const want = String(wantId ?? "").trim();
  if (!want) throw new Error(`${what}需要 id`);
  const exact = rows.find((r) => r.id === want);
  if (exact) return exact;
  const hits = rows.filter((r) => r.id.startsWith(want));
  if (!hits.length) throw new Error(`找不到${what}（active 行里匹配不到 id「${want}」；先列表核对）`);
  if (hits.length > 1) {
    throw new Error(
      `${what} id「${want}」是**前缀**且匹配到 ${hits.length} 行，无法确定是哪一条——` +
        `请用列表里给出的**完整行 id** 重试：\n${hits
          .slice(0, 20)
          .map((r) => `- ${r.id}`)
          .join("\n")}`
    );
  }
  return hits[0]!;
}

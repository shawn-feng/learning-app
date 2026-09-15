/**
 * 考核计划 `scope` 的渲染前归一化（家长端 UI 用）。
 *
 * ⚠️ 为什么必须有这一层（2026-09-15 现场事故）：
 * `scope_json.courses` 有两种历史格式——
 *  - 旧（家长端 UI 早期自建排期）：`["课程名", ...]`
 *  - 新（2026-09-14 起「计划生成时即约定出题参数」）：`[{title, kps:[{name,count}]}, ...]`
 * 渲染端若直接把数组项当字符串渲染，遇到旧格式没事、遇到新格式就会把**对象当 React 子节点**渲染，
 * React 抛 `Objects are not valid as a React child` → 整棵渲染树卸载 → **白屏**。
 * 因此：任何展示 scope 的地方都要先过本模块，禁止直接 `{c}` 渲染。
 */

export interface PlanKpSpec {
  name: string;
  count: number;
}
export interface PlanCourseSpec {
  title: string;
  kps: PlanKpSpec[];
}

/** 解析 courses（两种格式都认）→ 统一结构；非法项丢弃，绝不抛错。 */
export function normalizePlanCourses(raw: unknown): PlanCourseSpec[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanCourseSpec[] = [];
  for (const c of raw) {
    if (typeof c === "string") {
      const title = c.trim();
      if (title) out.push({ title, kps: [] });
      continue;
    }
    if (!c || typeof c !== "object") continue;
    const o = c as { title?: unknown; kps?: unknown };
    const title = String(o.title ?? "").trim();
    if (!title) continue;
    const kps: PlanKpSpec[] = (Array.isArray(o.kps) ? o.kps : [])
      .filter((k): k is Record<string, unknown> => !!k && typeof k === "object")
      .map((k) => ({ name: String(k.name ?? "").trim(), count: Math.max(1, Number(k.count) || 1) }))
      .filter((k) => k.name);
    out.push({ title, kps });
  }
  return out;
}

/** 主题列表（字符串或对象）→ 名称数组。 */
export function normalizePlanTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((t) => {
      if (typeof t === "string") return t.trim();
      if (t && typeof t === "object") {
        const o = t as { title?: unknown; name?: unknown };
        return String(o.title ?? o.name ?? "").trim();
      }
      return "";
    })
    .filter(Boolean);
}

/** 单课展示文本：`论语学而篇第八章（字词×1、道理×1）`；无出题约定时只显示课程名。 */
export function formatCourseSpec(c: PlanCourseSpec): string {
  return c.kps.length ? `${c.title}（${c.kps.map((k) => `${k.name}×${k.count}`).join("、")}）` : c.title;
}

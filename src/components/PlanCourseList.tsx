/**
 * 考核计划「要考核的课程」列表（家长端只读展示）。
 *
 * ⚠️ 单独抽成组件是为了**可测**：2026-09-15 这里曾白屏——`scope.courses` 从
 * `["课程名"]` 变成 `[{title,kps}]` 后，直接把数组项 `{c}` 当 React 子节点渲染会抛
 * `Objects are not valid as a React child`，整棵渲染树卸载 → 白屏。
 * 现在渲染前一律走 `normalizePlanCourses`（两种格式都认），并有回归用例守着
 * （`test/plan-scope.test.tsx`）。
 */
import { formatCourseSpec, normalizePlanCourses } from "../lib/plan-scope";

export default function PlanCourseList({ courses, emptyHint }: { courses: unknown; emptyHint: string }) {
  const list = normalizePlanCourses(courses);
  if (!list.length) {
    return <p style={{ color: "#b9770a", fontSize: 12, margin: 0 }}>{emptyHint}</p>;
  }
  return (
    <div style={{ background: "#fff", border: "1px solid #e6eaf0", borderRadius: 8, padding: "6px 10px" }}>
      {list.map((c, i) => (
        <div
          key={`${i}-${c.title}`}
          style={{ fontSize: 13, padding: "4px 0", borderBottom: i < list.length - 1 ? "1px solid #f4f4f4" : "none" }}
        >
          {i + 1}. {formatCourseSpec(c)}
        </div>
      ))}
    </div>
  );
}

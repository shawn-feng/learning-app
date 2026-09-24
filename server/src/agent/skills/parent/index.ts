/**
 * 家长场景技能注册表（ISSUE-144）。
 *
 * 8 个场景技能 = 讨论稿 §2 的清单；**覆盖台账 34 条对话场景**（另 3 条界面自足见 UI_ONLY_SCENARIOS），
 * 每条只落一个场景（PARENT_SKILL_COVERAGE 同时是台账 → 场景的映射，测试会核对不重不漏）。
 */
import type { ParentSkill } from "./shared.js";
import { automationSkill } from "./automation.js";
import { childSkill } from "./child.js";
import { configSkill } from "./config.js";
import { courseSkill } from "./course.js";
import { materialsSkill } from "./materials.js";
import { planSkill } from "./plan.js";
import { pointsSkill } from "./points.js";
import { progressSkill } from "./progress.js";

export type { ParentSkill } from "./shared.js";

/** 8 个入口技能（顺序即索引顺序：高频在前） */
export const PARENT_SKILLS: ParentSkill[] = [
  progressSkill,
  courseSkill,
  planSkill,
  automationSkill,
  materialsSkill,
  childSkill,
  pointsSkill,
  configSkill,
];

/** 台账条目 → 场景技能（一条只落一个场景；测试用它核对覆盖） */
export const PARENT_SKILL_COVERAGE: Record<string, string[]> = {
  "parent-scene-progress": ["D1", "D2", "D3", "D4", "D5", "D7"],
  "parent-scene-course": ["B1", "B2", "B3", "B4", "B5", "B6", "C5", "C6"],
  "parent-scene-plan": ["E1", "E2", "E3", "E4", "E5", "E7", "E8"],
  "parent-scene-automation": ["E6"],
  "parent-scene-materials": ["C1", "C2", "C3", "C4", "C7", "C8"],
  "parent-scene-child": ["A1", "A2", "A3"],
  "parent-scene-points": ["F2", "F3"],
  "parent-scene-config": ["F4"],
};

/** 界面自足、不需要技能的场景（计入台账总数，但不进技能） */
export const UI_ONLY_SCENARIOS = ["A4", "A5", "F1"];

/** 当前可见的技能（灰度：把某个技能的 visible 置 false 即可下线，无需改装配） */
export function visibleParentSkills(): ParentSkill[] {
  return PARENT_SKILLS.filter((s) => s.visible !== false);
}

export function findParentSkill(name: string): ParentSkill | undefined {
  const key = String(name ?? "").trim().toLowerCase();
  return visibleParentSkills().find((s) => s.name === key);
}

/**
 * 常驻层里的「场景技能索引」：只放**标题 + 家长原话 + 技能名**（渐进披露：正文按需 load_skill 加载）。
 * 措辞要求见讨论稿 §5：像家长的原话，不像功能清单。
 */
export function buildSkillIndexBlock(): string {
  const lines = visibleParentSkills().map(
    (s) => `- **${s.title}**（${s.triggers}）→ \`${s.name}\``
  );
  return [
    "## 场景技能（按需加载）",
    "家长说的事落在下面哪个场景，就**先调 `load_skill(\"<技能名>\")` 把该场景的完整做法与口径读进来，再动手**；一次只读真正需要的那一两个（一件事跨两个场景时可以连着读两份）。",
    ...lines,
    "都不是上面这些时，按下面的工作原则正常答。",
    "「每天 / 每周」这类**重复**说法在 `parent-scene-plan` 与 `parent-scene-automation` 里都有说明；拿不准先问一句「是要排进日程，还是要到点自动做」。",
  ].join("\n");
}

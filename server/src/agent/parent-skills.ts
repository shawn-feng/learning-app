/**
 * 家长场景技能（ISSUE-144）：**家长覆盖层合并** + `load_skill` 工具。
 *
 * 设计要点（详见 docs/家长agent-场景skill实施方案-2026-09-25.md）：
 * - 内置正文随代码发布（`agent/skills/parent/*`）；家长覆盖存 `agents.sqlite`
 *   （`scope="parent"`, `ref="skill:<name>"`），**DB 优先、内置兜底**；
 * - 技能正文以"工具结果"进入消息，**不动 system prompt、不动工具集**（避免前缀缓存失效）；
 * - **不启用 SDK 自带的 Agent Skills**：它给出的是绝对路径（我们的 read 拒绝绝对路径），
 *   且默认发现目录会扫 cwd 及其祖先（cwd 是模型可写的地方 → 等于让模型给自己写指令）。
 */
import { Type } from "typebox";
import { defineTool } from "./tool-kit.js";
import { listAgentPrompts } from "../db/agents.js";
import { findParentSkill, visibleParentSkills, type ParentSkill } from "./skills/parent/index.js";

/** 覆盖层在 agents.sqlite 里的 ref 前缀（scope 固定为 parent，天然按家长隔离） */
export const SKILL_REF_PREFIX = "skill:";
/** 工具名（装配时加进 toolNames，**常驻不切**） */
export const LOAD_SKILL_TOOL_NAME = "load_skill";
/** 单个技能正文上限（覆盖层可能写很长，防灌爆上下文） */
export const MAX_SKILL_CHARS = 64 * 1024;

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

// ==================== 会话级技能状态 + 场景守卫（ISSUE-144 试点） ====================

/**
 * 会话级技能加载状态：`load_skill` 与"场景守卫"共用同一份。
 *
 * 为什么要它：工具的 `description` 与参数说明正在**下沉到场景技能**（按需才进上下文），
 * 于是"没加载技能就调用"变成一种新的错法——参数语义与红线都不在模型手里，
 * 它会**靠猜**写数据，而结构校验拦不住语义错误。守卫把这件事从"建议"变成**机制**：
 * 未加载所属场景 → 直接拒绝并告诉它先 `load_skill`。
 */
export interface ParentSkillState {
  /** 本会话已加载过的技能名 */
  loaded: Set<string>;
}

/** 每个家长会话建一份（在 `ensureEntry` 里创建，注入 `load_skill` 与相关工具）。 */
export function createParentSkillState(): ParentSkillState {
  return { loaded: new Set<string>() };
}

/**
 * 场景守卫：工具所属场景**本会话还没加载**时返回一段可读提示，否则返回 `null`。
 *
 * - `state` 为空（脚本/测试直调工具）→ 不拦（保持这些工具可独立使用）；
 * - `scenario` 可给**多个场景**（同一工具可能同时属于多个场景，如 `parent_list_children`
 *   被 progress / plan / child 共用）——**任一场景已加载即放行**，全都未加载才拒跑；
 * - 调用点写法：`const denied = scenarioGuard(state, "parent-scene-course"); if (denied) throw new Error(denied);`
 *   （抛错会被 SDK 转成模型可见的 isError 结果，模型据此补上 `load_skill` 再重试）。
 */
export function scenarioGuard(
  state: ParentSkillState | undefined | null,
  scenario: string | string[]
): string | null {
  if (!state) return null;
  const scenes = (Array.isArray(scenario) ? scenario : [scenario]).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!scenes.length) return null;
  if (scenes.some((s) => state.loaded.has(s))) return null;
  const list = scenes.map((s) => `「${findParentSkill(s)?.title ?? s}」（${s}）`).join(" 或 ");
  const load = scenes.map((s) => `load_skill({ name: "${s}" })`).join(" 或 ");
  return (
    `本次会话还没加载本工具所属的场景技能：${list}。\n` +
    `本工具的参数语义与必须遵守的红线都写在那个技能里——未加载就调用很容易写错数据，因此本工具**拒绝执行**。\n` +
    `请先调用 ${load}，再重试本工具。`
  );
}

export function skillRefOf(name: string): string {
  return `${SKILL_REF_PREFIX}${String(name ?? "").trim()}`;
}

/** 家长覆盖层：技能名 → 覆盖正文（只取 `skill:` 前缀的行，其余 ref 是家长级提示词，与本模块无关） */
export function listParentSkillOverrides(dataDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of listAgentPrompts(dataDir, "parent")) {
    if (!row.ref.startsWith(SKILL_REF_PREFIX)) continue;
    const name = row.ref.slice(SKILL_REF_PREFIX.length);
    if (row.content && row.content.trim()) out.set(name, row.content);
  }
  return out;
}

export interface ResolvedParentSkill {
  skill: ParentSkill;
  /** 实际生效的正文（覆盖优先） */
  body: string;
  /** 是否来自家长覆盖层 */
  overridden: boolean;
  /** 是否因超长被截断 */
  truncated: boolean;
}

/** 解析一个技能：先找可见技能，再套家长覆盖，最后做长度上限。 */
export function resolveParentSkill(dataDir: string, name: string): ResolvedParentSkill | undefined {
  const skill = findParentSkill(name);
  if (!skill) return undefined;
  const override = listParentSkillOverrides(dataDir).get(skill.name);
  const raw = override ?? skill.body;
  const truncated = raw.length > MAX_SKILL_CHARS;
  return {
    skill,
    body: truncated ? raw.slice(0, MAX_SKILL_CHARS) : raw,
    overridden: !!override,
    truncated,
  };
}

/**
 * `load_skill`：把某个场景的完整做法与口径读进当前会话。
 * 会话内**幂等**（同一技能重复调用只回一句提醒——正文已在上下文里，不必再占 token）。
 *
 * `state` 传入时与"场景守卫"共用（同一会话内加载过的场景，属于该场景的工具才肯执行）。
 */
export function createLoadSkillTool(deps: { dataDir: string; state?: ParentSkillState }) {
  // 未接管状态时退回内部 Set（脚本/测试直调 `load_skill` 也能保持会话内幂等）
  const loadedInSession = deps.state ? deps.state.loaded : new Set<string>();

  return defineTool({
    name: LOAD_SKILL_TOOL_NAME,
    label: "加载场景技能",
    description:
      "读取一个「场景技能」的完整做法与口径（家长工作台的业务场景说明书）。\n\n" +
      "**何时调用**：家长说的事落在某个场景（见系统提示词里的「场景技能」索引）时，先加载对应技能再动手。\n" +
      "**必须先加载**：属于该场景的工具在未加载时会**拒绝执行**并提示你先加载（参数语义与红线都在技能里）。\n" +
      "**参数**：技能名，如 `parent-scene-progress`（了解学习情况）、`parent-scene-course`（备/改一门课）。\n" +
      "**边界**：技能名必须来自索引；同一会话内重复加载同一技能只返回一句提醒（正文已在上下文里）。\n" +
      "**不会改变任何数据**，也不改变你能用的工具。",
    parameters: Type.Object({
      name: Type.String({ description: "技能名（来自系统提示词的场景技能索引，如 parent-scene-progress）" }),
    }),
    execute: async (_id: string, params: { name?: string }) => {
      const name = String(params?.name ?? "").trim();
      const resolved = resolveParentSkill(deps.dataDir, name);
      if (!resolved) {
        const list = visibleParentSkills().map((s) => `${s.name}（${s.title}）`).join("、");
        throw new Error(`没有这个场景技能：${name || "(空)"}。可用的有：${list}`);
      }
      const { skill, body, overridden, truncated } = resolved;

      if (loadedInSession.has(skill.name)) {
        return ok(
          `已加载场景：${skill.title}（${skill.name}）——本次会话已经读过，正文见前面那条工具结果，不要重复展开。`
        );
      }
      loadedInSession.add(skill.name);
      console.log(`[parent-agent] skill loaded: ${skill.name}${overridden ? " (家长覆盖版)" : ""}`);

      return ok(
        `已加载场景：${skill.title}（${skill.name}）\n` +
          (overridden ? "（这是**家长自定义过**的口径，以它为准）\n" : "") +
          (truncated ? `（正文过长，已截断到 ${MAX_SKILL_CHARS} 字符）\n` : "") +
          `\n${body}`
      );
    },
  });
}

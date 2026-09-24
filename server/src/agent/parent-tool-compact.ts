/**
 * ISSUE-144：家长工具「说明下沉」的统一压缩层（A 路线全量铺开，2026-09-25）。
 *
 * ## 为什么需要它
 * 工具块（tools）在消息顺序里属于**缓存前缀的头部**：它每一轮都在上下文里，是常驻提示词的 ~10 倍
 * （45 把 / 25078 字符，其中 description 10585 + 参数 Schema 14493）。拆开看，Schema 里 43% 是散文
 * （属性 `description`），description 里绝大部分是"场景口径 + 参数语义 + 红线"——**本属按需加载的 B/C 层**。
 *
 * ⇒ 把**说明**下沉到场景技能（`load_skill` 按需进上下文），工具块里只留：
 * ① **一句自述**（模型选工具那一刻还没有技能，必须知道这工具是干什么的、去哪儿读说明书）；
 * ② **结构**（字段名/类型/必填/嵌套/enum）——这是**执行前校验与类型转换的依据**
 *    （`agent-loop` → `pi-ai` `validateToolArguments`），撤了等于关校验（实测：空 schema 全放行）。
 *
 * ## 与试点（两把）的关系
 * 试点是**手写**做的那两件事（压描述、删 schema 说明、`execute` 首行加守卫）。这里把它**机制化**：
 * - 只在**注册点**（`parent-registry.ts` 的 `customTools`）过一道，工具对象**原地改**（保留 `prepareArguments`
 *   与 TypeBox 符号，`ISSUE-134` 的参数还原层不受影响）；
 * - 一句话从原 `description` 的**第一句**派生（括号内不切句）⇒ **单一真源**，不必两处维护、不会漂移；
 * - 幂等：对已经压过的工具再跑一次，结果逐字相同（试点两把因此无需回退，`tsc`/测试仍以注册后的形态为准）；
 * - 守卫按**工具 → 场景**（`scenesOfTool`，真源＝各技能声明的 `tools` 清单）自动加，支持**多场景任一放行**。
 *
 * ## 不参与下沉的工具（`COMPACT_EXEMPT_TOOLS`）
 * - `load_skill` 本身（它是加载器）；
 * - `log_activity`：工作区操作记录，任何场景都可能用，同样是通用设施。
 * （原先还豁免 `parent_db_read` / `parent_db_write` / `parent_db_describe` 三把通用通道工具；
 *  2026-09-25 `ISSUE-144` P6 已把它们连同 `parent-data` 会话整组退场，豁免名单随之收窄。）
 */
import { LOAD_SKILL_TOOL_NAME, scenarioGuard, type ParentSkillState } from "./parent-skills.js";
import { visibleParentSkills } from "./skills/parent/index.js";

/** 不参与"说明下沉"的工具（通用设施；语义无单一场景归属，或本身就是加载器） */
export const COMPACT_EXEMPT_TOOLS: ReadonlySet<string> = new Set<string>([
  LOAD_SKILL_TOOL_NAME,
  "log_activity",
]);

/** 一句话 + 自我指路（与试点两把的措辞逐字一致，测试断言 `load_skill` 与 `拒绝执行`） */
function pointerOf(scenes: string[]): string {
  const load = scenes.map((s) => `\`load_skill("${s}")\``).join(" 或 ");
  const tail = scenes.length > 1 ? "未加载任一场景时本工具拒绝执行。" : "未加载时本工具拒绝执行。";
  return `参数语义与红线见场景技能：先 ${load} 再调用——${tail}`;
}

/**
 * 工具 → 所属场景（单一真源＝各技能 `tools` 清单；同一工具可属多个场景 ⇒ 守卫任一放行）。
 * 未登记场景的工具返回空数组（调用方**原样保留**，宁可多占字符也不静默丢说明）。
 */
export function scenesOfTool(name: string): string[] {
  const n = String(name ?? "");
  return visibleParentSkills()
    .filter((s) => s.tools.includes(n))
    .map((s) => s.name);
}

/**
 * 取**第一句**作为自述（括号/书名号/引号内不切句），超长则截断。
 * 例：「列出服务端课程学习资料真源（可按 topic 或路径前缀过滤）。\n\n**何时调用**：…」
 * → 「列出服务端课程学习资料真源（可按路径前缀过滤）。」（只留第一句）
 */
export function firstSentence(text: string, limit = 140): string {
  const raw = String(text ?? "").replace(/\r/g, "").trim();
  if (!raw) return "";
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch === "（" || ch === "(" || ch === "【" || ch === "「") depth++;
    else if (ch === "）" || ch === ")" || ch === "】" || ch === "」") depth = Math.max(0, depth - 1);
    else if (ch === "。" && depth === 0) {
      cut = i + 1;
      break;
    }
  }
  let one = cut > 0 ? raw.slice(0, cut) : (raw.split("\n")[0] ?? raw);
  one = one.trim();
  if (one.length > limit) one = `${one.slice(0, limit).replace(/[，、；,;]$/, "")}。`;
  return one;
}

/**
 * 就地剔除参数 Schema 里所有 `description`（**只删说明，结构一字不动**）。
 *
 * 原地改（不深拷贝）⇒ 保留 TypeBox 的 `[Kind]` 符号与对象身份；只在值为字符串时删键，
 * 所以"字段名恰好叫 description"的 schema 节点不会被误删。
 */
export function stripParamDescriptions(schema: unknown): void {
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    for (const el of schema) stripParamDescriptions(el);
    return;
  }
  const obj = schema as Record<string, unknown>;
  if (typeof obj["description"] === "string") delete obj["description"];
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") stripParamDescriptions(v);
  }
}

/**
 * 压一把工具（原地改）：描述 → 一句 + 指路；参数 Schema → 只留结构；`execute` 外包一层场景守卫。
 * 不参与下沉（`COMPACT_EXEMPT_TOOLS`）或**未被任何技能声明**的工具原样返回。
 */
export function compactParentTool<T extends { name: string; description?: string; parameters?: unknown; execute?: unknown }>(
  tool: T,
  state?: ParentSkillState | null
): T {
  if (!tool || COMPACT_EXEMPT_TOOLS.has(tool.name)) return tool;
  const scenes = scenesOfTool(tool.name);
  if (!scenes.length) return tool;

  tool.description = `${firstSentence(tool.description ?? "")}${pointerOf(scenes)}`;
  stripParamDescriptions(tool.parameters);

  const original = tool.execute as undefined | ((id: string, params: any, ...rest: any[]) => unknown);
  if (typeof original === "function") {
    tool.execute = (async (id: string, params: any, ...rest: any[]) => {
      const denied = scenarioGuard(state, scenes);
      if (denied) throw new Error(denied);
      return original.call(tool, id, params, ...rest);
    }) as unknown as T["execute"];
  }
  return tool;
}

/** 批量版（注册点用）：`customTools` 过一道即可。 */
export function compactParentTools<T>(tools: readonly T[], state?: ParentSkillState | null): T[] {
  return tools.map((t) =>
    compactParentTool(
      t as unknown as { name: string; description?: string; parameters?: unknown; execute?: unknown },
      state
    ) as unknown as T
  );
}

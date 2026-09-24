/**
 * 家长场景技能：共用类型与共用文本片段（ISSUE-144）。
 *
 * 为什么技能正文放在 TS 模块里（而不是 .md 文件）：
 * - 与代码同版本发布，不受 esbuild 打包 / asar 资产拷贝影响（server 是打包运行，见 server/src/index.ts 的说明）；
 * - **重复规则**需要在 `parent-scene-plan` 与 `parent-scene-automation` 两处都出现，
 *   用同一个常量引用 ⇒ 物理上不可能漂移（见 docs/家长agent-场景skill实施方案-2026-09-25.md §2.1）。
 * 家长覆盖层不放这里：它存在 agents.sqlite（scope=parent, ref="skill:<name>"），组装时覆盖下面的 body。
 */

export interface ParentSkill {
  /** 标准名（kebab-case），也是 load_skill 的参数与覆盖层的 ref 后缀 */
  name: string;
  /** 中文场景名（给家长看的，也是 load_skill 返回的首行） */
  title: string;
  /** 索引行里的触发说法（家长原话，越像越好） */
  triggers: string;
  /** 一句话自述（诊断与文档用） */
  summary: string;
  /** 该场景主要用到的工具（自检用，不注入提示词） */
  tools: string[];
  /** 技能正文（按需加载进上下文的部分） */
  body: string;
  /** 是否出现在索引里（灰度开关；要灰度时置 false 即可） */
  visible?: boolean;
}

/**
 * A 层"铁律"：做错会坏数据或越权的硬约束。
 * **三处同留（ISSUE-144 A 路线全量铺开后的形态）**：**常驻层 + 场景技能正文 + 场景守卫**。
 * （原先还有"工具描述"那一处，说明下沉后已撤掉——工具没加载所属场景就**拒绝执行**，由机制承担。）
 * 所以这里单独成块，常驻层与各技能按需引用，避免"瘦身把铁律瘦没了"。
 */
export const IRON_RULES: Array<{ id: string; text: string }> = [
  {
    id: "A1",
    text:
      "- **课程改名只能 `parent_rename_course`**，绝不能用 `parent_upsert_course`（那是 (topic,title) 主键 upsert：改 title = 新建一行 + 新 uuid，旧行残留，孩子库的进度就永久对不上了）。",
  },
  {
    id: "A2",
    text:
      "- **`parent_upsert_course_content` 是整课全量快照（替换语义）**：没写进去的知识点/题会从这门课移除。写前必须先 `parent_library_course_content` 读、并把「保留什么、新增什么」复述给家长。",
  },
  {
    id: "A3",
    text:
      "- **删除 / 覆盖这类不可逆动作**：先演练（`parent_delete_material` 默认 dryRun）或列清单 → 复述给家长取得同意 → 再执行。",
  },
  {
    id: "A4",
    text:
      "- **认证 / 账户 / 密码永不触碰**：不能设或重置密码、不能改订阅、**不能删孩子**——一律如实说明并引导家长去界面。",
  },
  {
    id: "A5",
    text:
      "- **库同步范围只到「已分配给这个孩子的主题」**：`parent_sync_courses_to_child` 不代分配、不改进度、不删行；跳过了哪些未分配主题要如实转述。",
  },
  {
    id: "A6",
    text:
      "- **家长工作区 ≠ 资料库**：`read/write/edit/ls` 只能动工作区，正式资料必须走 `parent_put_material` / `parent_build_material`。",
  },
  {
    id: "A7",
    text:
      "- **任何写库动作之前先复述方案**：改排期 / 建考核 / **新建或修改主题与课程** / 落库课程内容 / 发资料 …… 都先把「要新建什么、要覆盖哪一行、改成什么」列成清单讲给家长（家长看不到你脑子里的计划），**得到确认再执行**。",
  },
];

/** 常驻层用的一整块铁律文本（技能正文里按场景重复必要的几条）。 */
export const IRON_RULES_BLOCK = IRON_RULES.map((r) => r.text).join("\n");

/** 取某几条铁律（技能正文按场景引用，避免整块重复）。 */
export function ironRules(...ids: string[]): string {
  return IRON_RULES.filter((r) => ids.includes(r.id))
    .map((r) => r.text)
    .join("\n");
}

/**
 * **重复规则同源片段**（ISSUE-144 决定：`parent-scene-plan` 与 `parent-scene-automation` 两处都写，
 * 但必须逐字同源）。改这一段＝两处同时改，这是它单独成常量的唯一目的。
 */
export const REPEAT_RULES_BLOCK = `家长说「每天」「每周一三五」这类**重复**时，先判断是哪一种，再落库：

| 家长的意思 | 走哪条 | 落库形态 |
|---|---|---|
| **排进日程**（"每周一到周五都练字"、"每天整理书包"） | \`parent_recurrence_create\`（重复计划规则） | **一条规则**，系统每天自动展开成当天的计划行；改走 \`parent_recurrence_update\`；**停用 ≠ 删除**（停用后不再展开，历史行还在） |
| **到点自动做一件事**（"每天早上 6 点查天气并播报"、"每天提醒她做眼保健操"） | \`parent_scheduler_task_create\`（定时任务） | 重复写在**指令文本**里，到点由执行会话跑；失败不重试 |

- 长期固定项**优先用重复规则**，不要逐天排 30 行（一个月＝30 行，改起来痛苦）。
- 有具体日期的一次性安排用逐天排（\`parent_study_plan_create\`）。
- 拿不准就问家长一句：**"是要排进日程，还是要到点自动做？"**`;

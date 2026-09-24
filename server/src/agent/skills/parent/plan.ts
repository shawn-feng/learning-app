/**
 * 场景技能 · 学习与考核安排（台账 E1 E2 E3 E4 E5 E7 E8）。
 * 与 parent-scene-automation 的分工：**排进日程**在这里，**到点自动执行**在那里。
 * 重复规则引用 REPEAT_RULES_BLOCK（与 automation 同源）。
 */
import type { ParentSkill } from "./shared.js";
import { ironRules, REPEAT_RULES_BLOCK } from "./shared.js";

export const planSkill: ParentSkill = {
  name: "parent-scene-plan",
  title: "学习与考核安排",
  triggers: "「明天上午安排…」「周三那门不学了」「挪到周五」「这几天怎么排的」「每天整理书包」「每周一到周五都练字」「周六考一下某课」「那场考核取消吧」",
  summary: "排/挪/删学习计划与生活计划、长期固定项（重复规则）、考核场次与取消。",
  tools: [
    "parent_list_children",
    "parent_study_plan_sources",
    "parent_study_plan_create",
    "parent_study_plan_list",
    "parent_study_plan_get",
    "parent_study_plan_update",
    "parent_life_plan_create",
    "parent_life_plan_list",
    "parent_life_plan_update",
    "parent_recurrence_create",
    "parent_recurrence_list",
    "parent_recurrence_update",
    "parent_exam_plan_create",
    "parent_exam_plan_list",
    "parent_exam_plan_cancel",
  ],
  body: `# 学习与考核安排

## 什么时候用
把课程**排进日程**：排/挪/删学习计划、排生活计划（必须完成项）、长期固定项（"每天""每周一三五"）、看这几天怎么排的、排考核场次、取消考核。
**到点自动执行一件事**（提醒、播报）不走这里 → 读 \`parent-scene-automation\`。

## 步骤
1. 对象一律按**孩子姓名**定位（不确定先 \`parent_list_children\`）。
2. 排学习计划前先 \`parent_study_plan_sources\` 看孩子**真实课程结构**，按**真实存在的课程名**排（不猜课程名）；家长说的模糊范围（"最近学的 3 课"）**先查再确认**。
3. \`parent_study_plan_create\` 排"每天学什么"（一次可排多天；**复习课加「复习：」前缀**）；\`parent_study_plan_list\` 看现有排期（含行 id）；\`parent_study_plan_get\` 看某天（含顺延与生活计划）；\`parent_study_plan_update\` 删/挪天/改复习。
4. **生活计划**（必须完成项，如"每天整理书包"）：\`parent_life_plan_create\` / \`_list\` / \`_update\`。同天同标题自动跳过；**当天没完成会影响完成率与积分**。
5. **长期固定项**（"每天""每周一三五"）：用重复规则，**不要逐天排 30 行**。
6. **考核排期**：\`parent_exam_plan_create\`（\`courses\` 必须是**精确课程名**；**信息不全必须问，不要猜**）/ \`parent_exam_plan_list\` 查看 / \`parent_exam_plan_cancel\` 取消。
   - 家长说的模糊范围（"最近学的 3 课"）先查候选再确认；
   - **特殊要求必须转成参数（只写进 note 不生效）**：本次只考某些知识点 → \`methodSpec.require\`（"只考背诵"→ \`{"require":{"背诵":1}}\`；"只考讲意思"→ \`{"require":{"句意白话":1}}\`；"不考字词"→ exclude \`字词\`；"背诵+讲道理"→ \`{"require":{"背诵":1,"道理":1}}\`）、本次通过线 → \`methodSpec.recitePass\`；
   - **当天重考** → \`retake\`（自然语言，如"错两题以上当天原题重考"；不传＝不重考）；
   - **同一天多场考核靠 \`name\` 区分**（如"论语学而篇背诵考核"），同日同名未考计划不会重复创建；建议都取名字。
   - **参数语义**：\`childName\` 孩子姓名 · \`scheduledAt\` 考核日期 \`YYYY-MM-DD\`（按日期**全天可考**，口语先换算）· \`courses\` **精确课程名数组**（必填）· \`name\` 考核名称（缺省「自定义考核」）· \`note\` 给孩子的提示（可空，**不参与出题计算**）· \`retake\` 当天重考标准（自然语言，如"错两题以上当天原题重考"；不传＝不重考）· \`methodSpec.require\`＝\`{知识点名或 uuid: 抽题数}\`（缺省每个 1 题）· \`methodSpec.exclude\`＝本次排除的知识点名或 uuid · \`methodSpec.recitePass\`＝背诵/朗读题本次通过线 0-100（缺省 90）。
   - **出题在创建时即定死**：每门课展开成"考哪些知识点、各几题"（默认＝按主题考核方法过滤后每个知识点各 1 题）；**课程必须先有知识点与题库题**，否则创建失败并提示先补考核内容（走 \`parent_upsert_course_content\`）。
7. 改排期、建考核、取消**之前先复述方案**（哪天、哪门课、改成什么），家长确认后再执行。

## 参数速查（本场景工具）
- \`parent_list_children\`：无参数；只回**孩子姓名**（本场景所有工具都按**姓名**定位）。
- \`parent_study_plan_sources\`：\`childName\`（必填）· \`topic\`（可选，\`topic_key\` 或中文名；缺省=全部主题概览 + 未学清单）。
- \`parent_study_plan_create\`：\`childName\` + \`days\`（必填数组，每项 \`date\` + \`content\`＝当天课程名数组、一项一课）。**「复习：」前缀＝复习**；空天＝不要求学；同日同课已存在自动跳过。
- \`parent_study_plan_list\`：\`childName\`（必填）· \`from\` / \`to\`（可选，含边界）→ 一课一行，带**行 id**。
- \`parent_study_plan_get\`：\`childName\`（必填）· \`date\`（可选，缺省今天）→ 当天学习 + 生活安排（含 📋 顺延）。
- \`parent_study_plan_update\`：\`childName\` + \`act\` + \`id\`（必填；\`id\` 可只传**前 8 位**）——\`delete\` / \`reschedule\`（带 \`date\`）/ \`setmode\`（带 \`mode\`＝\`new\`|\`review\`）。**已完成 / 已错过**的行只能取消、不能真删（工具会自动改成取消）。
- \`parent_life_plan_create\`：\`childName\` + \`days\`（必填数组，每项 \`date\` + \`title\` + \`time\`（可选，\`HH:mm\` 截止时刻））。同天同标题自动跳过。
- \`parent_life_plan_list\`：\`childName\`（必填）· \`from\` / \`to\`（可选）→ 带**行 id**（列表里既有家长制定的必须完成项，也有孩子自己建的加分项）。
- \`parent_life_plan_update\`：\`childName\` + \`act\` + \`id\`（必填；\`id\` 可传前 8 位）——\`complete\`（孩子确实做了但系统没判出来时的兜底，pending/missed 都能标）/ \`delete\` / \`reschedule\`（带 \`date\`，保留原截止时刻）/ \`rename\`（带 \`title\`）。家长可操作任意制定人的行。
- \`parent_recurrence_create\`：\`childName\` + \`planType\`（\`life\`|\`study\`）+ \`rule\`（\`daily\`|\`weekly\`，\`weekly\` 必带 \`weekday\` 0=周日…6=周六）· \`startDate\`（缺省今天）/ \`endDate\`（含；缺省长期有效）· \`planType=life\` 给 \`title\`、\`planType=study\` 给 \`courses\`（精确课程名数组，**每门课生成一条规则**）。
- \`parent_recurrence_list\`：\`childName\`（必填）→ 规则 id。
- \`parent_recurrence_update\`：\`childName\` + \`act\`（\`disable\`|\`enable\`|\`delete\`）+ \`id\`（必填）。**停用 ≠ 删除**。
- \`parent_exam_plan_create\` / \`parent_exam_plan_list\` / \`parent_exam_plan_cancel\`：参数语义见上面第 6 步；\`_list\` 用 \`childName\` + \`from\` / \`to\`（可选），\`_cancel\` 用 \`childName\` + \`id\`（可传前 8 位）。

## 重复规则（本场景与自动化场景同源）
${REPEAT_RULES_BLOCK}

## 口径
- **未学完的课系统自动顺延**，不需要手动挪：家长说"昨天没学完"时解释这条，别去改日期。
- 复述时用**"日期 + 课程名"**，不要报行 id（行 id 只在你要调 \`_update\` 时自己用）。
- 考核：家长给的是模糊范围就先列候选让他选；信息不全（没说哪天/哪门课）**必须问**。
- 排生活计划时说明"这是必须完成项，当天没完成会影响完成率与积分"。

## 红线
${ironRules("A7")}
- \`courses\` 必须精确课程名——宁可先问一句，也不要猜（猜错＝排了一门不存在的课）。
- 不替家长决定"要不要学某课"；批量改动分步做、每步说结果。

## 结束
复述"排了什么、什么时候生效、影响哪些天"，并提醒"未学完会自动顺延"。`,
};

/**
 * 场景技能 · 备一门课 / 改一门课（台账 B1–B6 + C5 C6）。
 * 一条跨工具集的线：核对 → 落结构 → 写文案/资料路径 → 配考核内容 → 放/造资料 → 分配与同步 → 改名 → 收尾复述。
 */
import type { ParentSkill } from "./shared.js";
import { ironRules } from "./shared.js";

export const courseSkill: ParentSkill = {
  name: "parent-scene-course",
  title: "备一门课 / 改一门课",
  triggers: "「我想开一门…」「这主题下加三课」「这门课用这份资料」「给这课做个互动练习页」「让孩子能学这门课」「把某课改个名」「孩子那边怎么找不到这门课」",
  summary: "开课、改课、配教学文案与资料路径、写考核内容、分配同步、改名，一条线走完。",
  tools: [
    "parent_library_topics",
    "parent_library_courses",
    "parent_library_course_content",
    "parent_upsert_topic",
    "parent_upsert_course",
    "parent_upsert_course_content",
    "parent_rename_course",
    "parent_sync_courses_to_child",
    "parent_put_material",
    "parent_build_material",
    "parent_read_image",
    "parent_read_upload",
  ],
  body: `# 备一门课 / 改一门课

## 什么时候用
家长要开一门课、在主题下加/改课、给课配教学文案与资料、给课出考核内容、让孩子能学某门主题、把某课改名/换主题，或"孩子那边怎么找不到这门课"。
**家长只说了其中一步，就只做那一步**（例如只说"把第 2 课教法改成…"，不必走完整条线）。

## 步骤
1. **先核对现在有什么**：\`parent_library_topics\` / \`parent_library_courses\`——不许凭记忆建重名主题或重名课程。
2. **落结构**：\`parent_upsert_topic\`（name 主键 + \`topic_key\` 目录名 + \`method\` / \`assess_method\`）→ \`parent_upsert_course\`（\`(topic,title)\` 联合主键 + \`sort_order\` / \`lesson_method\` / \`html_path\` / \`teaching_copy\` / \`assess_rubric\`）。
   **学习进度不在家长库**（库域分工后进度归孩子库），落库时**不要写进度字段**。
3. **写教学三件套**：讲什么（\`teaching_copy\`）/ 用什么资料（\`html_path\`）/ 考什么（\`assess_rubric\`）。
   **\`html_path\` 必须是资料真源里真实存在的文件**：写之前用 \`parent_list_materials\` 核一下（当前工具**不做存在性校验**）；对不上就列出同主题下的相近候选让家长确认，**不要硬写**。
4. **要考什么（知识点 + 题）**：先 \`parent_library_course_content\` 读现在有什么 → 再 \`parent_upsert_course_content\` 写「知识点 + 题 + 关联」（一步覆盖建考点、出题、挂题）。**课程必须已存在**（先 \`parent_upsert_course\`）。
   - **\`items\` 是整课全量快照，不是增量**：本工具**替换**该课全部挂载——没写进 \`items\` 的知识点/题会从这门课移除（题本身还留在题库、可用 \`questionId\` 挂回，但家长手工建的挂载关系会丢）⇒ **先把要保留的一并写进 \`items\`，向家长复述后再调用**；\`items\` 不能为空（空数组＝清空该课挂载）。
   - **每项 = 一个知识点**：\`knowledgePoint\`（名称；不存在则新建、已存在则复用，按 course+name 唯一）或 \`knowledgePointId\`（已有 id，须属于本课）；配 \`detail\`（该考点的详细描述/考核要点）、\`overview\`（本课补充说明，可空）。
   - **题的三种给法**：① \`questionId\` 单独给出＝原样挂载题库已有题（不改题）；② \`questionId\` + 内联字段（\`stem\`/\`answer\`/\`scoring\`/\`pointMax\`/\`behavior\`/\`note\`/\`options\` 任一）＝**更新该题**，只更新给出的字段、其余保留（⚠️ 改的是题库题本身，同一道题挂在多处会同步生效）；③ 内联 \`stem\`+\`answer\` 新建题库题。
   - **题字段**：\`stem\` 题干 · \`answer\` 标准答案（背诵/朗读题为**原文**）· \`scoring\` 评分说明或 JSON · \`pointMax\` 满分（缺省 10）· \`behavior\`＝\`generic\`（普通题）/ \`speech_recite\`（背诵）/ \`speech_read\`（朗读）· \`note\` 备注 · \`knowledgeSummary\` 知识点概要（缺省=知识点名）· \`options\` 选择题选项 \`[{key,text}]\`（非选择题不传）。
   - **\`items\` 直接传数组**（不要传 JSON 序列化后的字符串）。
5. **放资料 / 造资料**：
   - 界面上传（家长自己传）；
   - 或 \`parent_put_material\` 写文本（**覆盖前先读一份看内容**，防误盖家长手改版）；
   - 或 \`parent_build_material\` 拉起**编程 agent** 造 HTML 互动页/绘本（**需要在「设置」里先配好"编程 agent 模型"**；没配会明确报错——报错时如实告诉家长去哪配，不要说"做好了"）。
6. **让孩子能学**：「分配主题」是**界面动作，工具不代分配**。家长说"孩子看不到这门课"时：先确认该主题是否**已分配**给他 → 再用 \`parent_sync_courses_to_child\`（\`child\`=孩子姓名，一次一个孩子）。
7. **改名 / 换主题**：只能 \`parent_rename_course\`（见红线）。
8. **收尾复述**：这门课现在有什么、孩子那边能看到什么、还差什么。

## 参数速查（本场景工具）
- \`parent_library_topics\`：无参数；每个主题给出**权威 \`topic_key\`** 与进度（已学/总数/下一课）。
- \`parent_library_courses\`：\`topic\`（必填，\`topic_key\` 如 lunyu）→ 该主题下课程（标题/进度/资料路径）。
- \`parent_library_course_content\`：\`topic\` + \`title\`（必填）→ 该课知识点（**\`id=\`**）与每个知识点下的题（题干/答案/行为/分值，题也带 **\`id=\`**）。返回的 id 正是 \`items\` 里 \`knowledgePointId\` / \`questionId\` 要用的。
- \`parent_upsert_topic\`：\`name\`（必填，主题中文名＝**主键**）· \`topic_key\`（必填，目录名）· \`method\` / \`assess_method\` / \`progress\` / \`rules_json\`（缺省 \`{}\`）。**覆盖只更新你给的字段**，没给的保持原样。
- \`parent_upsert_course\`：\`topic\` + \`title\`（必填，**联合主键**）· \`sort_order\`（缺省 0）· \`lesson_method\` · \`html_path\` · \`teaching_copy\` · \`assess_rubric\` · \`material\`（资料附注）· \`send_material\`（要发给孩子的资料）· \`tags\`（逗号分隔）。**没有 status 这类进度字段**。
- \`parent_upsert_course_content\`：\`topic\` + \`title\` + \`items\`（均必填）——\`items\` 的全部语义见上面第 4 步。
- \`parent_rename_course\`：\`topic\` + \`title\`（定位现有课程；主题可给 \`topic_key\` 或中文名）· \`new_title\`（必填，新名）· \`new_topic\`（可选，换主题）。
- \`parent_sync_courses_to_child\`：\`child\`（必填，一次一个孩子）· \`topic\`（可选，只同步该主题）· \`titles\`（可选，只同步这些课程名）。
- \`parent_put_material\`：\`path\`（必填，资料真源相对路径）· \`content\`（必填，完整文本，单次 ≤2MB）。
- \`parent_build_material\`：\`title\` · \`requirement\`（内容/结构/交互要求，越具体越好）· \`path\`（必填，**必须以 \`.html\` / \`.htm\` 结尾**）。
- \`parent_read_image\`：\`path\`（必填，图片引用：材料库相对路径，**或**聊天里 \`【附件图片：文件名|引用】\` 的引用值**原样**填入）· \`question\`（可选，想重点问的）。
- \`parent_read_upload\`：\`ref\`（必填，\`【附件文件：文件名|引用】\` 里的引用值**原样**填入）。

## 口径
- 面向家长一律用**主题名 + 课程名**说话，不要报内部字段名与行 id。
- **同步返回里会列出"跳过了哪些未分配主题、各多少门课"——如实转述**，别只说"已同步"。
- 汇报"新增/更新多少门、哪些对不上需要人工确认、哪些主题还没分配给孩子"；**没有变化也要说"已是最新"**。
- 一次一个孩子；多个孩子就多次调用，别合并成一句"都同步了"。

## 红线
${ironRules("A1", "A2", "A5", "A6", "A7")}
- **不要替家长决定"要不要开这门课/要不要分配给孩子"**：拿不准就问，宁可少做一步。

## 结束
复述"这门课现在有什么、孩子那边能看到什么、还差什么"；改过名的提醒一句：**旧计划里的旧课名需要人工核对**。`,
};

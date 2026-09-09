## [ISSUE-066] 家长 agent 课程内容职责增强：考核内容(rubric)/考核方法(assess_method)编写能力 + 格式约定送达（需求记录，后续处理）
- **类型**：需求（2026-09-09 用户：以后课程/考核内容设置由家长 agent 承担）
- **现状缺口**：
  - 底层 `upsertParentCourse` 已支持 `assessRubric`，但家长 agent 工具 `parent_course_save` **未暴露该参数**（也没有 assess_method 入口）→ agent 现在写不了考核内容/考核方法，只能靠家长端 UI（TopicDetail 考核要点编辑器）与后台语料脚本。
  - rubric 为 markdown 自由文本，但**背诵/朗读能力依赖固定句式**：`- 原文背诵：…"标准原文"`（exam-engine recitationFor 正则提取 refText；无此句式则该主题不出背诵评测题）。现仅 lunyu 主题配了 rubric（489/512），其它主题（hanzigong/english/reading/qianziwen 等）assess_rubric 全空。
- **待实现内容**：
  1. `parent_course_save` 增加可选参数 `assessRubric`（存每课考核内容全文）；`parent_topic_save`（或课程级）支持 `assessMethod`（主题考核方法：按孩子区分题目构成与不考范围）。
  2. 家长 agent 系统提示注入《课程考核内容编写规范》短版：模板骨架（一、考核知识点 → 二、题目（选择题/问答题）→ 三、评分标准）+ 背诵句式约定（原文放引号）+ 动机（发音评测/现成题依赖）。
  3. 共享目录放规范文档（完整模板+示例）供 agent 细读。
- **验收**：家长 agent 对话即可为任意主题建课程并写好 rubric/考核方法；背诵评测对按规范写的主题可用。
- **状态**：✅ 已实施（2026-09-09）。
- **实施记录**：
  - `electron/lib/assess-guide.ts`（新）：`COURSE_ASSESS_GUIDE_MD` 完整规范（rubric 三部分骨架/背诵句式/assess_method 分孩子/写作纪律）+ `ensureAssessGuideFile()` 幂等落 `data/.pi/agent/assess-rubric-guide.md`（agent cwd=data/ 可 read）。两个家长会话创建前调用。
  - `custom-tools.ts`：`parent_course_save` 新增可选 `assessRubric`（schema/description/log/返回文案）；`parent_topic_save` 新增可选 `assessMethod`（主题考核方法，只覆盖非空）+ courses 元素新增 `assessRubric`。底层 `upsertParentCourse`/`upsertParentTopic` 本就支持，本次补齐工具暴露。
  - `pi-session.ts` `buildParentPrompt` 新增 §2.6「课程考核内容与考核方法（家长 agent 编写职责）」：何时写、保存入口、先 read 规范、背诵句式★、assess_method 按孩子分段。
  - 新增 `test/assess-guide.test.ts`（3 例：幂等落盘/背诵句式可被引擎正则提取/骨架与关键约束）。
  - 验证：tsc 0 错、vitest 3 过、electron-vite build 过。

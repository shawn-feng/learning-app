# ISSUE-109：家长 agent db 通道需能读 exam_attempts 表（主库受控只读豁免第一例；家长侧现无任何考核成绩读取工具）

- **类型**：需求 / 设计（agent 能力扩展，涉及 ISSUE-105 db-channel 的权限边界调整）
- **描述**：家长 agent 目前**没有任何读取考核成绩（主库 `exam_attempts`）的工具**——家长问「珊珊最近考核怎么样/哪道题错了/薄弱点在哪」，agent 答不了，prompt 只能引导家长去 UI「考核记录」看（`parent-plans.ts:837/941` 明文这么写）。需求：家长 agent 的 db 通道工具能**读取** `exam_attempts`（成绩、逐题记录 per_question、掌握度 course_mastery、错题 wrong_questions、巩固建议 reinforce_plan），支撑对话式成绩问答与复习建议。**只要读，不要写**（写仍只能走考核提交流程）。
- **现状 / 边界（已查证代码）**：
  - **家长侧 db 通道现状**：P1（ISSUE-105）只给了 `parent_db_describe`（看 schema）+ `parent_db_write`（insert/update/delete）两工具（`parent-tools.ts:864/880`，白名单 `:959-960`），**没有 `parent_db_read`**——家长侧连自己内容库（parent.sqlite）的通用查询都没有（读是靠 `parent_library_course_content` 等专用查询工具）；孩子侧反倒有完整三件套 `child_db_describe/read/write`（`child-db-tools.ts:123`）。
  - **家长可操作表（6 张，全在 parent.sqlite 家长内容库，均可增删改）**：`topics` / `courses` / `tags` / `question_bank` / `knowledge_points` / `course_knowledge_questions`（`db-channel.ts:79-214` `parentLibTableRegistry`）。
  - **exam_attempts 在主库**：`server.sqlite`（`db.ts:189`，含 parent_id/child_id/score/per_question/course_mastery/wrong_questions/reinforce_plan 等），是**唯一跨租户的库**——ISSUE-105 定过「**主库不进直连白名单**」的原则（当时矩阵已注明 exam_attempts 家长=R 但"经专用工具"，本 issue 即是把这条 R 落成通道）。该原则的本意是防凭据（parents）、对话（session_messages）、跨租户误读；exam_attempts 自带 `parent_id` 列、天然可强制租户过滤，属于可控豁免对象。
  - **UI 读路径现成**：家长端「考核记录」走 REST（`routes/exam.ts:1430/1452`，按 child_id 倒序取）——数据链路验证过，只差 agent 工具封装。
- **改造方向（建议方案）**：
  ① **新增 `parent_db_read` 工具**（对齐孩子侧 `child_db_read` 范式：等值 where + 列裁剪 + 排序 + 行数上限，全参数化只读），首批覆盖 parent.sqlite 已登记 6 表——顺手补齐家长/孩子两侧通道的工具对称性。
  ② **主库受控只读登记表**（`mainDbReadableRegistry`，与 `parentLibTableRegistry` 分立）：`exam_attempts` 为第一张。强制约束：**只读**（不进 `parent_db_write` 可写登记）；**租户过滤硬编码**——where 自动追加 `parent_id = <token 解出的 parentId>`（childId 参数须归属校验，防跨家长/跨孩子窥探）；行数上限 + db_audit 审计沿用现有设施。
  ③ **JSON 大列截断**：`per_question`（逐题明细，可能很长）/`reinforce_plan`/`wrong_questions` 按字符截断返回（参照既有 600/16000 截断先例），并在列描述里说明「截断，需更多可用 where 缩小范围/按 id 单条取」。
  ④ **prompt 段**：家长 agent 提示词补「查询考核成绩用 parent_db_read（表 exam_attempts，只读）」，替换现在「去考核记录页看」的引导；可给 1 个「最近 3 次成绩 + 薄弱课程」示例。
  ⑤ **备选方案（否决理由备查）**：只加专用工具 `parent_exam_attempts_read`、不引入通用 `parent_db_read`——改动更小，但家长侧通用读缺口仍在、且专用工具数量继续膨胀（恰是 ISSUE-105 要终结的模式）。
- **安全底线**：主库豁免**仅此一张表、仅读**；`parents`/`settings`/`session_messages` 等敏感表维持不可见；若未来加第二张主库表须逐表过类似评审（矩阵式登记 + 强制租户列）。
- **优先级**：中（家长高频问答场景，能力缺口明显；无数据风险，只读）
- **记录时间**：2026-09-17

# ISSUE-103：家长 agent 管理课程时缺「知识点 + 题库」管理工具

- **类型**：需求（agent 工具缺口）
- **优先级**：中
- **记录时间**：2026-09-15
- **状态**：✅ 已解决并已上线（2026-09-15：代码 + 本地构建 + 冒烟 29/29 通过；**服务端 0.4.2 已于 11:45 部署到 201**，客户端无需升级）

## 描述
家长 agent 在「管理课程」闭环里，能建主题、建课、写教学与学习资料，但**无法创建/维护课程的知识点、无法创建/维护题库里的题、也无法把题关联到知识点（挂到某课）**。
用户明确列出的管理动作清单：

1. 创建主题 → ✅ 已有工具 `parent_upsert_topic`
2. 创建课程 → ✅ 已有工具 `parent_upsert_course`
3. 课程教学 + 学习资料 → ✅ 已有：`parent_upsert_course`（lesson_method/teaching_copy/assess_rubric/html_path）+ `parent_put_material` / `parent_read_material` / `parent_move_material` / `parent_delete_material` + `parent_read_image`
4. **课程的知识点并关联** → ❌ 无工具
5. **课程的题目并关联到知识点** → ❌ 无工具

即第 4、5 步目前只能走家长端 UI（REST），家长 agent 在对话里"帮孩子建一套带考点和题的课程"这条链路断在最后两环。

## 影响范围
- 家长 agent 的"AI 制课"闭环不完整：主题/课/资料能对话式产出，但考点与题只能手动去 UI 建。
- 与 ISSUE-101（千字文背诵题数据残缺）之类"需批量补建知识点/题"的治理任务也无法由 agent 直接完成，仍依赖手工 SQL/脚本。
- 风险面：低。知识点与题都在**家长库（parent.sqlite）**，家长已对该库拥有完全主权（与现有 topic/course 工具同口径），不触及任何隐私红线。

## 排查 / 修改入口
### 当前家长 agent 工具（server/src/agent/parent-tools.ts）
现有工具清单（return 数组 + `PARENT_AGENT_TOOL_NAMES`）：
`parent_list_materials` / `parent_read_material` / `parent_delete_material` / `parent_move_material` / `parent_put_material` / `parent_library_topics` / `parent_library_courses` / `parent_upsert_topic` / `parent_upsert_course` / `parent_read_image` / `parent_read_child_conversation` / `log_activity` + 编程 agent。
**没有任何知识点 / 题库相关工具。**

### 底层数据模型（server/src/db/assess-content.ts，表全在家长库 parent.sqlite）
- `question_bank`(id, stem, answer, scoring, point_max, behavior, note, knowledge_summary, options) —— 题库（题本身无主题/课，语义由"挂到哪个(课,知识点)"决定，可跨课复用）。
- `knowledge_points`(id, course_uuid, name, detail, seq) —— 每课的考核要点=知识点（挂在课下，name=知识点名、detail=详细描述）。
- `course_knowledge_questions`(course_id, knowledge_point_id, question_id, seq, overview) —— 课↔知识点↔题 挂载表。
- 已有函数：`saveQuestion`（upsert 题）、`getOrCreateKnowledgePoint`（按 course_uuid+name getOrCreate，可带 detail）、`replaceCourseContent`（事务整课替换挂载）、`listCourseContent`、`listTopicKnowledgePoints`、`getQuestion`、`getCourseUuid`。

### 底层 REST（server/src/routes/exam.ts，已存在、可工作）
- `POST /api/v1/assess/questions` —— 单题 upsert（`saveQuestion`）。
- `POST /api/v1/assess/courses/save` —— **整课保存**：topic+title 定位课 → 每项=一个知识点（getOrCreate，可带 detail）+ 其下若干题（引用题库题 questionId 或内联新建）→ `replaceCourseContent` 事务整课替换挂载。这是最完整的"建考点+建题+关联"入口。
- `GET /api/v1/assess/topics/:topic/knowledge-points` —— 列某主题下知识点。
- `GET /api/v1/assess/courses/:topic/:title` —— 看某课结构化内容（知识点+题原文/评分）。

> 结论：**DB 层与 REST 层都已齐备且可用**，缺的只是把这套能力封装成家长 agent 可调用的工具——属"封装 agent 工具"而非"新设计 schema"。

## 分析结论：当前工具不够，应当增加
家长 agent 现有 12 个工具覆盖了"主题/课/资料"，但**完全没有覆盖"知识点/题库/关联"三件事**。其余 4 步（主题/课/教学/资料）已有工具，唯独用户点名的后两步是空档。因此必须新增工具。

### 建议新增（保持与现有 `parent_library_*`(读) + `parent_upsert_*`(写) 命名一致）
1. **`parent_library_course_content`**（读）
   - 参数：`topic`、`title`。
   - 复用 `listCourseContent`（`GET /assess/courses/:topic/:title`），返回该课的知识点列表 + 每个知识点下挂的题（stem/answer/behavior/point_max）。
   - 作用：建题前先核对现有考点与题，避免重复；让家长 agent 能"看见"当前课程结构。
2. **`parent_upsert_course_content`**（写，核心）
   - 参数：`topic`、`title`、`items[]`（每项 = `knowledgePoint` 名称 / 可选 `knowledgePointId` + `detail` + `questions[]`；题支持 `questionId` 引用题库题 或 `stem/answer/behavior/scoring/point_max/options` 内联新建）。
   - 实现直接复用现有 `POST /assess/courses/save` 的既有逻辑（`getCourseUuid` → 每项 `getOrCreateKnowledgePoint`（或先按 id 校验归属）→ 每个题 `saveQuestion` 内联建或按 id 链接 → `replaceCourseContent` 事务整课替换挂载）。**一次性覆盖用户第 4、5 步**。
   - 可选补充：`parent_upsert_question`（纯题库题 upsert，脱离课程维度单独维护题），若 agent 需要"先建题库、再挂课"的拆分流程再加。

### 落地注意（踩过 ISSUE-089 的坑）
- 新工具**必须同时**加入 `createParentAgentTools` 的 return 数组 **和** `PARENT_AGENT_TOOL_NAMES` 白名单——只加白名单不加 return 会导致"工具定义可见但调用 no-op"（ISSUE-089 同款病）。
- prompt（parent-registry.ts）需补充"如何建知识点与题、关联要点"的指引段，使模型知道用新工具落库。
- 危险动作：整课 `replaceCourseContent` 是**替换语义**（覆盖该课全部挂载）。prompt 须提示"先 `parent_library_course_content` 看现状、确认无误再调用"，避免误覆盖家长手建内容（与 `parent_put_material`/`parent_upsert_course` 的"先核对再覆盖"约定一致）。

## 实施记录（2026-09-15）

### 落地内容
1. **`server/src/agent/parent-tools.ts` 新增 2 个工具**（均同时进 `return` 数组 + `PARENT_AGENT_TOOL_NAMES`，防 ISSUE-089 陷阱）：
   - `parent_library_course_content`（读）：`topic` + `title` → `getCourseUuid` + `listKnowledgePoints`（该课**全部**知识点，含未挂题的）+ `listCourseContent`（挂载→题）。输出含 `id=`，供后续 `questionId` / `knowledgePointId` 复用；未挂题的知识点标「（未挂题）」；空课提示「尚未结构化」；课不存在给出核对指引。
   - `parent_upsert_course_content`（写）：`topic` + `title` + `items[]`（每项 = 知识点名或 `knowledgePointId` + `detail`/`overview` + `questions[]`）。题支持 `questionId` 引用题库题，或内联 `stem`/`answer`/`behavior`/`pointMax`/`scoring`/`note`/`options` 新建。落库走 `getOrCreateKnowledgePoint` + `saveQuestion` + `replaceCourseContent`（与 REST `POST /assess/courses/save` **同一批 DB 函数**）。
   - **新增两道安全闸**（原方案没有、实施中发现必要）：
     ① **只读预校验**：先把全部 `items` 扫一遍（知识点名/id 必填、`knowledgePointId` 须属本课、题 `questionId` 须存在或 `stem`+`answer` 齐全），全过才落笔 —— 否则「报错但已建出孤儿知识点」会留在库里（冒烟实测到过：失败调用残留 `为政以德` 知识点行）。
     ② **移除告警**：写完对比替换前后挂载快照，若原有知识点/题被移除，回报里显式列出（知识点名 + 移除挂载条数）并提示可重写补回。防「只提交增量 → 覆盖掉家长手建内容」。
2. **`server/src/agent/parent-registry.ts` prompt 新增「落库课程考核内容（知识点 + 题库，家长库真源）」段**：给出建主题→建课→发资料→写知识点+题的全套顺序；显式写明 `parent_upsert_course_content` 前**必先** `parent_library_course_content`；写明 `items` 是**整课全量快照（替换语义，不是增量）**、要保留的内容必须一并写进去、写前复述给家长确认；说明 behavior 取值（generic / speech_recite / speech_read）与 `questionId` 跨课复用。
3. **文档回写**：技术实现文档 §3.1（prompt 与挂载工具、修正过时的 ISSUE-089 缺口描述）、§6.4（两工具字段级行）、§8.2（工具清单）、§8.3（制课闭环）、§17 新增第 15 行「已解决」、附录 A.1（两工具字段级行）。

### 验证
- `server` 包 `tsc --noEmit` **0 错**；`node scripts/build.mjs` 成功（`server/dist/server.cjs` 17.51MB，含新工具）。
- 冒烟脚本（临时家长库，不碰真实数据）**29 条断言全 PASS**：注册双挂 / 读不存在的课 / 空课提示 / 首写（2 知识点 + 2 题，含 speech_recite）/ 读回结构 / 引用已有题（不新建）/ 整课替换的移除告警 / 6 条错误路径 / 错误路径不留脏数据 / DB 落库核对（题库 4 题、知识点 2 个同课去重、背诵题 behavior+pointMax、`knowledgePointId`+detail 更新生效）/ activity-log 记录。
- 冒烟脚本跑完即删；断言输出留 `tmp/smoke-103-result.txt`。

### 部署（2026-09-15 11:45，用户明确同意后执行）
- 版本 0.4.1 → **0.4.2** → 部署到 201：停机约 3 秒；`/api/v1/version`=0.4.2、health ok、启动日志零迁移/报错；包内 `grep -o` 命中 `parent_upsert_course_content`×8 / `parent_library_course_content`×10（证明新工具在线上包内）。
- 备份：bundle `server.cjs.bak-20260915-1145`；数据 `data/backups/deploy-0.4.2-20260915-1145/`（36M）。回滚见 `DEPLOY-201-server-0.4.1-迁移方案-2026-09-15.md` §10。
- **未改客户端**（服务端变更向后兼容）；家长 agent 在服务端跑 → 新工具已对家长端可用。
- 部署后只读探测真实家长库：单课最多 9 题 / 5 知识点（读工具输出体量可控，无需分页）；未挂题知识点 0 / 未挂课题 0 → 移除告警不会误触发。
- ⚠️ 验证试点：**别在已有 parent 会话里问「你有没有这工具」**（ISSUE-102 同款：模型会被历史锚住而否认）；用新会话或先「重置家长会话」。

### 未做（留待用户决定 / 范围外）
- 未做「独立建题库题（脱离课程）/ 删知识点 / 删题」工具。现状：题目靠 `parent_upsert_course_content` 内联新建或 `questionId` 引用；删除只有 `replaceCourseContent` 的整课替换语义（未挂载 ≠ 删除，题库行仍在）。
- 读工具**不做总量截断**（有意为之）：若截断，agent 可能基于残缺现状写回 items → 静默删掉未读到的内容。真实数据下单课规模很小（≤9 题），暂不需要分页；若将来单课规模变大，应改为「明确报错并提示分批」，而不是截断。

## 暂不处理 / 待定
- 是否要做"删除某知识点/某题"的工具？现有 REST 未提供删除（只有 replace 整课 / upsert 题），属另一议题，本次不展开。
- 题库题"跨课复用"在模型里已支持（`course_knowledge_questions` 允许同一 question_id 挂多课），工具层无需额外处理。

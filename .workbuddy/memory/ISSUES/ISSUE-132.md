# ISSUE-132 题库管理优化：主题/课程/知识点维度查询 + 家长界面直接新建/编辑题目

- **类型**：需求 / UI
- **记录时间**：2026-09-22
- **状态**：✅ 已实施（2026-09-22，见实施记录）

## 需求（用户原话）

1. 题库要能按照**主题、课程、知识点**维度进行查询。
2. 可以**添加和编辑**题库。例如在某个知识点下、或者某个课程下新建；也可以**直接新建，不关联课程或知识点**。

## 现状（实施前）

- 家长「题库」页（`src/components/QuestionBankPanel.tsx`）是**纯只读浏览**：全部题目列表 + 关键字过滤 + 详情/各孩子最近考核记录。没有维度筛选，更没有新建/编辑/删除入口——题目只能靠家长 agent 对话（`/assess/courses/save` 整课保存）或 LLM 出题时落库。
- 服务端已有但客户端 UI 未接的能力：
  - `POST /api/v1/assess/questions`（`saveQuestion`：create/update 单题，**不含挂载**）；
  - `POST /api/v1/assess/courses/save`（整课替换挂载——不适合 UI 单题操作，会覆盖整课）。
- 挂载模型（知识点制）：题目本身无主题/课程归属，语义由 `course_knowledge_questions`（课程↔知识点↔题目）挂载决定；一题可挂多课（复用）。
- 维度数据（主题→课程→知识点树）在 parent.sqlite 的 `topics`/`courses`/`knowledge_points` 三张表，家长题库页从未拉取过。
- **附带发现（回归）**：ISSUE-074 曾把 `listAllBankQuestions` 的 LIMIT 2000 改为 `BANK_LIST_LIMIT=10000`（commit 7ccbc93），后续 F10-b 收编重构（commit bd3d229）时改写该函数把上限**改回了 2000**——生产题库已 3575 条，等于回归。

## 方案

1. **服务端**（`server/src/db/assess-content.ts` + `server/src/routes/exam.ts`）：
   - LIMIT 回归修复：恢复 10000 上限（保持响应形状不变）。
   - `GET /api/v1/assess/questions/facets`：返回 `{topics, courses, knowledgePoints}` 三维全量（含还没有题的课程/知识点，供级联筛选与挂载选择）。
   - `POST /api/v1/assess/questions/link`：`{courseId 或 topic+title, knowledgePointId 或 knowledgePoint(+detail 可新建), questionId}` → 挂载一行（INSERT OR IGNORE，事务内逐项校验存在性/归属）。
   - `POST /api/v1/assess/questions/unlink`：`{courseId, knowledgePointId, questionId}` → 删除挂载行。
   - `DELETE /api/v1/assess/questions/:id`：删题 + 级联清理挂载行（考核历史 exam_attempts 存的是逐题快照，不受影响）。
   - 维度**查询**本身走客户端：列表接口每题已带 `contexts[{topic,course,knowledgePoint}]`，全量加载后客户端按三维级联过滤（不改 API 形状、electron/web 双端零成本）；服务端分页/过滤仍归 ISSUE-074 待办。
2. **electron 客户端三层**：`assess-admin.ts` 加 `assessBankFacets/assessQuestionSave/assessQuestionLink/assessQuestionUnlink/assessQuestionDelete`；`ipc-handlers.ts` 加 `assess:bankFacets/questionSave/questionDelete/questionLink/questionUnlink`；`preload.ts` 同名暴露。
3. **web shim**：`domains/assessment.ts` 同签名补齐（web-shim-coverage 回归守着）。
4. **QuestionBankPanel 重构**：
   - 筛选栏：主题 → 课程 → 知识点 三个级联下拉（选项来自 facets；题目过滤按 contexts 客户端匹配）+ 原关键字搜索保留；显示「x/y 道」。
   - 「＋ 新建题目」：表单（题干/参考答案/评分标准/分值/行为/选项/备注/知识点概要）+ **可选**挂载（主题→课程→知识点 级联，支持「＋ 新知识点」按名创建）；当前筛选落在某知识点/课程时自动预选。不选挂载 = 直接建不关联题。
   - 详情页「编辑」：同表单回填 + 挂载管理（现有挂载逐条「移除」；「添加挂载」级联选课程/知识点）。
   - 「删除」：二次确认后调 DELETE。
   - 背诵/朗读题（speech_recite/speech_read）：answer=标准原文，评分标准留空。

## 边界

- 挂载操作单行 INSERT/DELETE，不触碰「整课替换」旧接口（agent 继续用）。
- 删除题目只影响题库与挂载；考核记录（exam_attempts.per_question 逐题快照）不受影响，历史成绩仍可回看。
- 不做：题库分页/服务端过滤（ISSUE-074）、题干富文本、题目导入导出。

## 关联

- ISSUE-067（知识点制模型：course_knowledge_questions）
- ISSUE-073（类别→知识点切换）
- ISSUE-074（LIMIT 截断；本 issue 修复其题库项回归，分页/服务端过滤仍开放）
- ISSUE-110（家长内容库 6 表盘点；question_bank 在 parent_db_write 可写范围内，agent 路径与 UI 路径并存）

---

## 实施记录（2026-09-22）

- **服务端**：
  - `assess-content.ts`：`BANK_LIST_LIMIT=10000` 恢复（回归修复）；新增 `listBankFacets`（topics/courses/kps 三维）、`linkQuestionToKnowledgePoint`（按 id 或 topic+title 定位课、按 id 或名称定位/新建知识点、INSERT OR IGNORE）、`unlinkQuestionFromKnowledgePoint`、`deleteBankQuestion`（事务删挂载行+题目行）。
  - `routes/exam.ts`：挂 `GET /assess/questions/facets`、`POST /assess/questions/link`、`POST /assess/questions/unlink`、`DELETE /assess/questions/:id`（均家长 JWT）。
- **electron**：`assess-admin.ts` 五个新函数；`ipc-handlers.ts` 五个 handler；`preload.ts` 暴露 `assessBankFacets/assessQuestionSave/assessQuestionDelete/assessQuestionLink/assessQuestionUnlink`。
- **web shim**：`domains/assessment.ts` 同签名五方法（http 直连 `/assess/*`）。
- **QuestionBankPanel**：级联筛选（主题/课程/知识点 + 关键字）、新建（可预选挂载/可新建知识点）、编辑（表单回填 + 挂载增删）、删除（确认）。列表项与详情显示挂载上下文标签。
- **测试**：`test/issue132-question-bank.test.ts` 7 用例（facets / 挂载定位与幂等 / 越课 kp 拒绝 / 摘挂载 / 删题清挂载 / 2100 条不被 2000 截断）全绿；相关回归（web-shim-coverage/db-channel/data-channel-v2/issue121/issue122/exam）全绿——期间 coverage 测试抓到 QuestionBankPanel 注释里 `window.api.assess*` 字样被扫描正则误匹配为方法名，改措辞解决（教训：头注释避免写 `window.api.<前缀>*` 通配写法）；server tsc 0 错；electron-vite build + web build 通过；**HTTP 冒烟 14/14**（隔离实例：注册→登录→facets→存题→三种挂载定位（courseId+新kp名 / topic+title+kpId / 跨课 kp 引用 400 拒绝）→列表 contexts 带 ids→unlink→编辑保留挂载→delete 清挂载→无 token 401）。
- **部署**：服务端改动待部署 201；客户端 UI 随下个客户端包发布。

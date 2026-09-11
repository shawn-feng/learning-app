# ISSUE-073｜考核内容模型切换：类别（topic_categories）→ 知识点（knowledge_points）

- **类型**：架构 / 重构（跨端）
- **优先级**：中（功能当前可用，属模型收敛；但**改 API 形状**，须与客户端排期）
- **记录时间**：2026-09-11
- **状态**：待实施（仅登记，未改动代码）。**数据侧已就位**，只差代码切换。

---

## 描述

用户已明确目标模型：**主题 → 课程 → 知识点 → 题目**（一个知识点对应多个题目）。
`topic_categories`（考核「类别」，如 背诵/字句/句意白话/道理/典故）应被 `knowledge_points`（挂在课程下）取代。

**当前状态是「数据已按知识点就位、代码仍按类别读」的中间态**：

| 层 | 现状 |
|---|---|
| `knowledge_points` | 生产 201 已有 **1969** 个（覆盖 489 门论语课程，平均 4.0 个/课）——按「课程 × 旧分组名」生成 |
| `course_category_questions.knowledge_point_id` | **3575/3575 已回填** |
| `topic_categories` | 仍有 **5 行**（背诵 440 / 句意白话 460 / 字词 390 / 道理 389 / 典故 290 个知识点），是**当前代码的必需父键桥梁** |
| 读取路径 | 仍全部按 `category` 走 → 这是本 issue 要改的部分 |

> 数据就位的那次同步见 `UPGRADE-201-PLAN-DOMAIN-2026-09-11.md` §12。

## 影响范围

**服务端（API 形状变更 → 客户端必须同步改）**

1. `server/src/db/assess-content.ts`
   - `ASSESS_CONTENT_TABLES`（L17-58）：`course_category_questions` 的 `category_id` 是主键组成 `PRIMARY KEY (course_id, category_id, question_id)`（L43）→ 需改为 `(course_id, question_id)` 或让 `category_id` 降级为可空遗留列。
   - `listCategories` / `getOrCreateCategory`（L146-165）→ 改为 knowledge-point 版（按 `course_uuid` 而非 `topic_id` 维度）。
   - `listCourseContent`（L297-355）：**L306 `JOIN topic_categories tc ON tc.id = ccq.category_id` 是 INNER JOIN** —— 改为 JOIN `knowledge_points`。
   - `listAllBankQuestions`（L366+）：contexts 的 `category`（L387、L400 `JOIN topic_categories`）→ 改为 `knowledgePoint`。
   - `replaceCourseContent`（L270-290）：`item.categoryId` → `item.knowledgePointId`。
2. `server/src/assess-selection.ts`：`attachStructuredQuestions` 按类别抽题（L42 `listCategories`、L102-152 的 `categoryId` 过滤与回填）→ 改为按知识点；`method_spec` 的 **require/exclude 键**从「类别名或 uuid」改为「知识点名或 uuid」（L152 注释「类别 uuid」）。
3. `server/src/routes/exam.ts`
   - L1485-1502 类别解析（`categoryId` / `categoryName` + 归属校验）→ 知识点版；
   - L1517 `GET /assess/topics/:topic/categories` → 知识点端点（或并存一版）；
   - L1616/L1647 `content_save` 的 `items[].categoryName/categoryId` payload → 知识点字段。
4. `server/src/assess-migrate.ts`（L238-241、L290 用 `topic_categories.behavior` 判背诵/朗读的存量迁移器）：类别下线后该判据改为**题级 `question_bank.behavior`**（440 道背诵题已带 `behavior='speech_recite'`，不依赖类别）。

**客户端（electron）**

5. `electron/lib/assess-admin.ts`（L31/34-35/47-50/59-69/91：`AssessCategory`、`listTopicCategories`、`saveAssessCategory`、`content_save` payload）。
6. `electron/lib/assess-tools.ts`（`assess_categories_list` L20、`assess_category_create` L38、`assess_content_save` 描述与 payload L98-136）。
7. `electron/lib/assess-guide.ts`（L28-29 工具表、L58-62 payload 示例、L70 的 `requireText/excludeText` 说明）。
8. `electron/lib/custom-tools.ts` L1058（`exam_schedule_create` 的「本次考核方法」用 `categories` / `excludeCategories` 传类别名）。
9. `electron/lib/pi-session.ts` 家长提示词 §2.6（考核内容与考核方法编写职责）。

**UI**

10. `src/components/TopicDetail.tsx`（L631-643 类别 chips、L688/691-693 题目详情里的类别/知识点展示）。
11. `src/components/QuestionBankPanel.tsx`（L47 contexts 类型、L104 关键词过滤、L166-167 上下文展示）。
12. `src/components/ExamView.tsx`（L61/124-126/228-230/344-346/471-473：`per_question` 的 `categoryId` 溯源字段）。

## 排查 / 修改入口（可直接执行）

1. 先定 API 契约：`/assess/topics/:topic/knowledge-points`（列表）、`/assess/knowledge-points`（建）、`content_save` payload 用 `knowledgePoint`/`knowledgePointId`；`/assess/course-content` 返回 `knowledgePoints[]`。
2. 改 `course_category_questions` 主键（迁移：`CREATE TABLE ... ; INSERT SELECT ; DROP ; RENAME`，保留 `category_id` 列一版做回退）。
3. 服务端按 §影响范围 1-4 顺序改（先数据层、再抽题、再路由），每步 `tsc` + `build`。
4. 客户端 §5-9、UI §10-12 同步改（与客户端打包任务同一批次，避免两端 API 不匹配）。
5. 端到端验证：家长端「课程管理 → 某课 → 考核要点」按知识点分组展示；孩子端出题只出所选知识点的题；背诵题仍置首题且 `recitePass` 生效。
6. 完成后清理 `topic_categories`（5 行）与 `server/scripts/migrate-assess-rubrics.ts` / `assess-migrate.ts` 中类别依赖。

## 待确认项

1. `ccq.category_id` 是**直接删列**还是先保留一版只读（建议后者，便于回退）。
2. `method_spec` 与排期级 `scope.methodSpec` 的键：用知识点**名**（可读、但改名即断链）还是**uuid**（稳、但不可读）——现有实现两者都接受，建议 uuid 为主、名称为兼容。
3. 知识点粒度：当前是「课程 × 旧分组名」（1969 个，名称沿用背诵/句意白话/…）。若家长期望的是**内容语义型**知识点（如「不亦说乎的含义」），需另做一次基于 `question_bank.knowledge_summary` 的重建——但**现状该字段全空**，需先有内容。
4. 是否保留「类别」作为**题型**概念（背诵/朗读这类**作答方式**其实不是知识点）：建议把 `behavior`（`speech_recite`/`speech_read`/`generic`）完全归到**题目级**（现已支持），不再用类别承载题型。

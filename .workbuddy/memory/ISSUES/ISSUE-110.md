# ISSUE-110：家长 agent 数据操作权限设计（含主库瘦身）

- **类型**：架构 / 设计
- **优先级**：中
- **记录时间**：2026-09-18
- **状态**：🟡 设计定案中（方向已定，待落地）

## 0. 背景与现状盘点（原 110 盘点结论，保留作为事实基线）

`parent_db_describe` / `parent_db_write` 均基于 `parentLibTableRegistry()`（`db-channel.ts:79`），**只能操作家长内容库 parent.sqlite 的 6 张表**：topics / courses / tags / question_bank / knowledge_points / course_knowledge_questions（均 insert/update/delete，带列白名单+外键校验+行数熔断+审计+敏感列二次确认）。

- ✅ 写侧（受控增删改）对课程内容已全覆盖，与专用工具（parent_upsert_* / parent_upsert_course_content）形成「专用优先、db 通道兜底」双层结构。
- ❌ **缺 `parent_db_read`**：parent 侧 db 通道只能 describe + write，无法按条件查询 6 表内容（只能走专用 `parent_library_*` 或 UI）。
- ❌ **主库读取缺口**：考核成绩 `exam_attempts` 无任何 agent 读取工具（原 ISSUE-109 覆盖，现改为本设计 §3 方案）。
- ❌ **孩子库无通用通道**：家长 agent 对孩子库只有计划域专用工具（study/life/exam plan）+ 对话读取，无受控 db 通道，无真删。

## 1. 设计方向：主库瘦身（用户 2026-09-18 定调，否决「物理隔离主库」）

**不采用**「把 server.sqlite 按家长物理拆成 main.sqlite」方案。改为：

> **把主库中 parent 归属、agent 可操作的内容搬到 parent.sqlite 或孩子 kb；主库只剩系统/隐私/跨租户表，agent 永不碰主库。**

理由：
- `parent.sqlite` 已是「文件路径即租户」的物理隔离（`data/parents/<parentId>/parent.sqlite`），复用现有隔离 + 现有 `parent_db_*` 通道即可，**无需新造 `parent_main_db_*` 通道、无需拆 server.sqlite**。
- 要搬的表（children / materials / files / exam_attempts …）全部带 `parent_id` 或 `child_id`，天然归属单一租户，搬库后不存在跨文件 JOIN。
- 留主库的表全是系统/隐私/全局队列类，本来就没有家长维度，也就无所谓「按家长隔离」——主库隔离问题直接消失。

## 2. 三库 × CRUD 能力目标（对应三个场景）

| 库 | 读 R | 改 U | 建 C | 删 D | 通道 |
|---|---|---|---|---|---|
| 家长内容库 parent.sqlite | ✅（补 `parent_db_read`） | ✅ | ✅ | ⚠️ 部分不可删（registry 加 `deleteAllowed` 开关） | 现有 `parent_db_*` 扩展 |
| 孩子库 kb/<childId>.sqlite | ✅（家长操作孩子库通道） | ✅（部分表） | ✅（部分表） | ⚠️ 部分可删 | 新增「家长操作孩子库」注册表 |
| 主库 server.sqlite | ❌ agent 不碰 | ❌ | ❌ | ❌ | 无（仅系统/worker 读写） |

## 3. 主库现有表归处总表（db.ts:30-363）

| 主库现表 | 本质 | 归处 | 说明 |
|---|---|---|---|
| `parents` | 凭据 | **留主库 ✗** | 登录凭据，永不可见 |
| `settings` | 密钥 | **留主库 ✗** | 加密 auth，永不可见 |
| `wechat_bindings` / `wechat_bind_requests` | 身份/系统 | **留主库 ✗** | 非 agent 操作对象 |
| `session_messages` / `session_files` | 隐私 | **留主库 ✗**（仅显式读） | 隐私红线，只走 `parent_read_child_conversation` |
| `worker_state` | 系统 | **留主库 ✗** | worker 内部态 |
| `scheduler_tasks` / `_assignments` / `task_runs` | 系统 | **留主库 ✗** | 全局任务队列，agent 写会破坏重试 |
| `meta` | 系统 | 留主库 | 迁移标记 |
| `children` | 家长拥有 | **→ parent.sqlite** | 家长拥有，已有 create/update 工具 |
| `materials` / `files` | 家长拥有 | **→ parent.sqlite** | 家长上传，已有操作工具 |
| `exam_attempts` | 孩子考核数据 | **→ 孩子 kb（只读）** | 见 §4 分叉 1 |
| `speech_assessments` | 孩子评测数据 | **→ 孩子 kb（只读）** | 同 exam_attempts |
| `assessment_config` | 家长配置 | **→ parent.sqlite（待最终确认）** | 家长发音配置，parent 归属 |
| `study_plan_items` | 历史归档 | **不搬迁 / 可 DROP** | 见 §4 分叉 2 |

> 结论：搬完后**主库 = 仅系统/隐私/跨租户表，agent 永不碰**；家长 agent 只操作 parent.sqlite + 孩子 kb。

## 4. 两个已决分叉（用户 2026-09-18）

**分叉 1：`exam_attempts` → 孩子 kb（不是 parent 库）**
- 理由：是孩子的考核数据，归孩子库更自然。
- 家长读取：经「家长操作孩子库」通道，在 child-kb 注册表里把 `exam_attempts` / `speech_assessments` 标记为**只读**；或专用 `parent_read_child_exam`。
- 写路径不变：仅考核提交流程（服务端）写 child kb 的 exam_attempts。

**分叉 2：`study_plan_items` 是旧表，不搬迁**
- 是什么：主库里的「每日学习计划展开表」（一课一行），每行 = 某孩子某天学/复习某课（date/topic_key/course_name/mode/status/done_at…）。原是「孩子今天学什么」的每日排期真源（ISSUE-033，2026-09-04）。
- 什么场景用：家长对话定计划 → 排期落此表；worker 在孩子当天学完后回写 status/done_at。
- **现状**：2026-09-10 计划域重构，活数据已迁入**孩子 kb 的 `study_plans` 表**（`study-plans.ts:96-98` 明写「原主库 study_plan_items 仅作历史归档」；完成态改由 `worker/plan-domain.ts` 写 `study_plans.status`）。
- **隐患（待修 bug）**：`routes/exam.ts:603` 的 `listPlanCourseMeta` 仍在读主库 `study_plan_items` 生成「每日/每周固定考核」候选课程——重构没改干净的遗留引用，固定考核候选可能基于过期归档排期。
- **处理**：确认 `exam.ts:603` 改读 child kb `study_plans` 后，**直接 DROP 主库 `study_plan_items`**。不进任何 agent 通道。

## 5. 迁移注意点（落地前必须拍板）

1. **迁移脚本**：逐 parent 在 parent.sqlite 建表 + 按 `parent_id` 搬 children/materials/files/assessment_config；exam_attempts/speech_assessments 按 `child_id` 搬入对应 child kb。
2. **改所有现读写引用**：`routes/materials.ts`、`routes/exam.ts`、`parent-plans.ts` 的 children 操作、worker，从 `server.sqlite` 改为 `openParentLib` / `openKb`。
3. **写路径保护**：exam_attempts/speech_assessments 在 child-kb 注册表记为只读；children 仍禁删（ISSUE-087）。
4. **materials/files 磁盘配对**：行搬库不改磁盘路径解析逻辑（文件用绝对/基于已知根路径，不依赖 db 位置）。
5. **确认无跨全部家长的全局扫描**（如管理后台聚合）。若有，per-parent/per-child 文件需迭代所有家长。
6. **清理 exam.ts:603 对 study_plan_items 的遗留引用**（改读 child kb study_plans）。

## 6. 实施分解（建议顺序）

- **P1 家长内容库**：补 `parent_db_read`；`parentLibTableRegistry` 加 `deleteAllowed` 开关（topics/course_knowledge_questions 等设禁删）。
- **P2 孩子库（家长操作）**：新增「家长操作孩子库」注册表 + `parent_child_db_read` / `parent_child_db_write`（按 child_id 强制归属 + 选择性删除：daily_entries/redemption_requests/已完成 study_plans 可删，积分/考核表只读）。
- **P3 主库瘦身迁移**：按 §5 搬表 + 改引用 + DROP study_plan_items（先修 exam.ts 引用）+ exam_attempts/speech_assessments 进 child kb 只读。

## 7. 关联

- ISSUE-105：db-channel 总设计（parentLibTableRegistry 已存在；mainDbReadableRegistry 不再需要）。
- ISSUE-109：补 exam_attempts 读 → 现改为「child kb 中 exam_attempts 只读」实现，本 issue 为其上级设计。
- 场景 1/2/3 需求：家长库全 R/U/C + 部分禁删；孩子库 R/U/C + 部分删；主库仅留系统表。

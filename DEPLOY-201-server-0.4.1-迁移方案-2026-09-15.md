# 201 服务端 0.4.1 部署前数据结构核查与迁移方案

> 日期：2026-09-15 ｜ 目标：把服务端从 **0.3.5** 升级到 **0.4.1** 并部署到局域网服务器 201（192.168.1.201）
> 核查方式：SSH **只读**探测 201（`node:sqlite` readOnly，未写入任何数据、未部署、未重启服务）

---

## 0. 结论（TL;DR）

1. **201 现有数据结构已与 0.4.1 完全兼容 —— 无需任何手工结构迁移。** 所有 0.4.1 需要的表 / 列在 201 上均已存在。
2. 0.4.1 启动时的**自动迁移全部幂等**，且它在 201 上要 DROP 的旧表**都是空表或已迁移**，无数据丢失风险。
3. ⚠️ 有 3 个**孤儿 kb 文件**（旧结构、未迁移）：0.4.1 首次访问会自动补表；**不要**对它们运行 `migrate-plan-domain.mts`（会因缺 `todo_items` 表而报错）。
4. `migrate-plan-domain.mts` **无需再跑**（真实孩子库 `plan_domain_migrated` 已于 2026-09-11 置位）。
5. 附带发现 1 个**预存问题（非本次部署引入）**：固定档考核候选读的是主库 `study_plan_items`（真源已迁到孩子库）→ 建议单独登记 ISSUE。

---

## 1. 现状与真源

| 项 | 值 |
|---|---|
| 201 当前版本 | `learning-server` **0.3.5**，`features=[session_sync, worker, exam]` |
| 201 Node | v24.15.0（原生支持 `node:sqlite`） |
| 数据目录 | `/opt/learning-server/data`（约 **1.9 G**） |
| 新代码结构真源 | `server/src/db.ts`、`db/kb.ts`、`db/parent-lib.ts`、`db/assess-content.ts`、`db/agents.ts`（CREATE TABLE + ALTER 全量扫描） |
| 库清单 | 主库 `server.sqlite`；孩子库 `kb/<parentId>/<childId>.sqlite`；家长库 `parents/<parentId>/parent.sqlite`；全局 `agents.sqlite` |

---

## 2. 结构对照（逐库）

### 2.1 主库 `server.sqlite`
- 0.4.1 期望 16 张表：`meta / parents / children / settings / assessment_config / materials / files / session_messages / session_files / worker_state / scheduler_tasks / scheduler_task_assignments / task_runs / exam_attempts / speech_assessments / study_plan_items`
  → **201 全部具备**。
- 关键列全部在位：`children.profile_json` ✓、`exam_attempts.schedule_id` ✓、`scheduler_tasks` 的 9 个扩展列 ✓、`study_plan_items.course_uuid` ✓、`materials` 复合主键 `(parent_id,id)` ✓。
- **201 多出 1 张**：`exam_schedules`（**0 行**）→ 0.4.1 启动 `DROP TABLE IF EXISTS exam_schedules`，**安全**。
- meta：`schema_version=5`、`config_revision=177`、`study_plan_v2_migrated=1`。代码用 `INSERT OR IGNORE` 写 `10` 不会覆盖 5，且 `schema_version` 无任何逻辑依赖（纯标记）。
- **缺失：无 → 无需迁移**

### 2.2 孩子库 `kb/<parentId>/<childId>.sqlite`
- 2 个真实孩子：珊珊 `1f050a7f…`、闻闻 `09406c05…`
  - 计划域 11 张表（`study_plans / exam_plans / exam_plan_courses / life_plans / plan_recurrences / reward_configs / reward_daily_stats / points_ledger / points_balance / redemption_items / redemption_requests`）+ 视图 `topic_progress / course_progress` **全部具备**；
  - `courses` 已删旧列（`mastery/exam_mastery/first_learned`）且带 `uuid` ✓；`daily_entries` 带 `plan_id/plan_outcome` ✓；`life_plans` 带 `carry_from` ✓；
  - `meta.plan_domain_migrated = 2026-09-11T03:31:11.866Z`（已迁）。
- **201 多出**：`todo_items`（74 / 38 行）、`child_todo_stats`（9 / 8 行）→ 0.4.1 **不读不写不删**（代码注释明确：保留供迁移脚本读取）；不影响运行，可后续单独清理。
- **缺失：无 → 无需迁移**
- **孤儿 kb（3 个，旧结构、未迁移）**：`4d6e76fc-…`（主库 children 中已无此孩子）、`kb/test-parent/1478f4f7-…`、`kb/test-parent/82be613d-…`（假家长测试数据）
  → 0.4.1 首次 `openKb` 会就地补列建表（drop 旧列 / 加 uuid / 建计划域表），属自动、幂等。

### 2.3 家长库 `parents/<parentId>/parent.sqlite`
- 数据量：`courses` 1315 / `topics` 11 / `question_bank` 3575 / `knowledge_points` 1969 / `course_knowledge_questions` 3575
- 关键列在位：`courses.uuid` + `assess_rubric` ✓、`topics.assess_method` + `method_spec` ✓、`question_bank` 的 4 个扩展列（`behavior/note/knowledge_summary/options`）✓、`knowledge_points.detail` ✓
- **201 多出 2 张**：`course_category_questions`（**0 行**）、`topic_categories`（**0 行**）。
  ⚠️ 更正（实测）：这两张表**不会**被自动删除 —— `assess-content.ts` 的 `DROP` 写在 `if (!ckq_migrated)` 分支内，而 201 的 `meta.ckq_migrated` 已是 `1`，故整段迁移+退役被跳过。**实测部署后两表仍在**（各 0 行、无任何代码引用、无副作用）。是否清理可后续单独决定。
- **缺失：无 → 无需迁移**

### 2.4 全局 `agents.sqlite`
- `prompts` / `prompt_history`（+ `sqlite_sequence`）与 0.4.1 **完全一致**。

---

## 3. 自动迁移清单（部署后首次启动自动执行，全部幂等）

| 库 | 动作 | 201 实际影响 | 安全性 |
|---|---|---|---|
| 主库 | `DROP TABLE exam_schedules` | 表存在但 **0 行** | ✅ 无损失 |
| 主库 | 各 `ALTER TABLE`（profile_json / schedule_id / scheduler_tasks 9 列 / study_plan_items.course_uuid） | 列均已存在 → 跳过 | ✅ |
| 主库 | `migrateStudyPlanV2` | 新结构，跳过 | ✅ |
| 孩子库 | `DROP TABLE child_todos`（若含 `items_md`） | 表不存在 | ✅ |
| 孩子库 | `UPDATE exam_plans SET kind='custom' WHERE kind='self'` | `exam_plans` **0 行** | ✅ |
| 孩子库 | 删 `courses` 旧列 / 补 `uuid` / 建计划域表 | 已完成 | ✅ |
| 家长库 | `DROP course_category_questions` / `topic_categories` | **未执行**（`ckq_migrated=1` → 整段跳过）→ 两表保留、各 0 行 | ✅ 无副作用 |
| 家长库 | 补 `courses.uuid` 等 | 已完成 | ✅ |
| agents | `CREATE TABLE IF NOT EXISTS` | 已存在 | ✅ |
| 新增目录 | `data/agent-sessions/`（服务端 agent 会话落盘） | **不存在** → 代码按需 `mkdir` | ✅ 无需预建 |

---

## 4. 需人工执行的迁移

**无。**

- `server/scripts/migrate-plan-domain.mts`：**无需再跑**。真实孩子库 `plan_domain_migrated` 已置位，脚本会跳过；且**不要**对孤儿 kb（`4d6e76fc` / `test-parent/*`）执行——它们没有 `todo_items` 表，脚本会在该查询处抛错。
- 其它脚本（`backfill-plan-course-uuid` / `backfill-knowledge-points` / `seed-knowledge-points` / `restore-question-bank`）：仅在需要重建内容时按需使用，本次结构升级**不需要**。

---

## 5. 数据连续性确认

| 项 | 结论 |
|---|---|
| 会话历史 | `session_messages` **4095 行**（2026-08-19 ~ 09-14）保留在主库 → 家长端「对话回顾」历史**不丢**（新代码仅从 `agent-sessions/` 增量索引，旧行仍在表内可查） |
| 旧 `sessions/` 目录 | root 属主、客户端镜像残留 → 0.4.1 改用 `agent-sessions/`，旧目录成为遗留（不影响） |
| 考核历史 | `exam_attempts` **0 行** → 考核域重构不涉及历史成绩 |
| 登录态 | `server-config.json` 的 `jwtSecret` 保持不变 → 现有 token 继续有效 |
| 密钥解密 | `.secret`（64 B）保留 → `settings` 中加密的 `auth`（家长模型密钥，726 B）可正常解密 |
| 家长配置 | `settings` 已含 `86a84278…:app_settings`（9/14）、`:auth`（9/3）、`:scheduler_config`、`exam_fixed:86a84278…` |

---

## 6. 风险与部署后验证点

1. ⚠️ **预存问题（非本次引入）**：`server/src/routes/exam.ts` 的「每日/每周固定档考核候选」（`listPlanCourseMeta`）从**主库 `study_plan_items`** 读取，而计划真源自 9/11 起已是**孩子库 `study_plans`**。主库该表现有 290 行（9/3 ~ 9/30 快照，**已冻结不再写入**）→ 9/11 之后新建的计划不会进入固定档候选。**建议单独登记 ISSUE 评估**（v0.1.14/0.3.5 已存在此行为，非本次部署引入）。
2. 孤儿 kb / 已删孩子残留（3 个 kb + `test-parent` 假家长）：不影响运行，建议系统稳定后单独清理。
3. `schema_version`（主库 5 / 孩子库 6）不会同步为新版值：纯标记，无功能依赖，可忽略。
4. **部署前确认**服务端模型密钥与 `app_settings` 在位（均已存在），否则 `server_agent` / `parent_agent` / `exam_agent` 新能力不可用。
5. `scheduler_tasks` 共 3 条（`recording` / `auto_new_session` / `reminder`），**均为 0.4.1 仍支持的类型**，无需处理（旧 `todo_gen/todo_stat` 不存在）。

---

## 7. 部署步骤（含备份 / 回滚）——**须用户明确同意后才执行**

0. **备份**：停服 → 打包 `data` 目录（约 1.9 G，可视情排除 `materials/`）→ 201 已有 `backups/` 目录可复用。
1. 上传本地 `server/dist/server.cjs` → `/opt/learning-server/server.cjs`。
2. 重启 `learning-server`（systemd）。
3. 观察启动日志中的迁移输出，确认无 `[db] … 迁移失败` 之类报错。
4. **验证**：
   - `GET /api/v1/version` → `version=0.4.1`，`features` 含 `server_agent / parent_agent / exam_agent`；
   - `GET /health` → ok；
   - 抽查主库 / 孩子库 / 家长库表结构与行数（应只减不增地少掉空表，行数不减）；
   - 家长端「对话回顾」仍能看到历史日期（如 2026-09-14）。
5. **回滚**：还原旧 `server.cjs` + 恢复 `data` 备份（新代码的结构变更向前兼容，回滚需依赖备份）。

> ⚠️ 按项目约定（2026-09-14）：**未经用户明确同意，不得部署到 201**。本文档仅为部署前置方案。

---

## 8. 附录：只读探测证据

**主库**：`parents` 1（test@qq.com）｜`children` 2（珊珊 1f050a7f / 闻闻 09406c05）｜`exam_schedules` **0**｜`exam_attempts` **0**｜`study_plan_items` **290**（闻闻 116 / 珊珊 174）｜`scheduler_tasks` 3｜`session_messages` **4095**｜`session_files` 54

**孩子库**：`study_plans` 186 / 121｜`todo_items` 74 / 38｜`child_todo_stats` 9 / 8｜`exam_plans` **0**

**家长库**：`courses` 1315｜`topics` 11｜`question_bank` 3575｜`knowledge_points` 1969｜`course_knowledge_questions` 3575｜`course_category_questions` **0**｜`topic_categories` **0**

**settings 键**：`app_settings`｜`scheduler_config`｜`86a84278…:app_settings`｜`86a84278…:scheduler_config`｜`86a84278…:auth`｜`exam_fixed:86a84278…`

**data 目录**：约 1.9 G

---

## 9. 部署执行记录（2026-09-15 09:33，已完成）

| 项 | 值 |
|---|---|
| 结果 | ✅ 成功。`/api/v1/version` → **0.4.1**，features = `[session_sync, worker, exam, server_agent, parent_agent, exam_agent]` |
| 健康 | `/api/v1/health` → `{"ok":true,"uptime":27,"db":"ok"}` |
| 进程 | `/usr/bin/node /opt/learning-server/server.cjs`（pid 932224，root，09:33 起） |
| 启动日志 | 无任何 `迁移/error/fail/FATAL` 匹配；worker 调度器已启动；监听 `127.0.0.1:8788` 与 `192.168.1.201:8788` |
| 备份（旧 bundle） | `/opt/learning-server/server.cjs.bak-20260915-0933`（16,626,865 B） |
| 备份（数据） | `/opt/learning-server/data/backups/deploy-0.4.1-20260915-0933/`（36 M：server.sqlite(+wal/shm)、agents.sqlite、kb/、parents/、`*.json`、`.secret`） |
| 停机时长 | 约 6 秒（stop → 备份 → 装包 → restart） |

**迁移实际结果**
- ✅ `exam_schedules` **已被 DROP**（主库表清单中已消失，与其他 ALTER 一并生效）。
- ✅ 行数**零减少**：`session_messages` 4095、`study_plan_items` 290、`scheduler_tasks` 3；孩子库 `study_plans` 186 / 121、`life_plans` 2 / 0、`todo_items` 74 / 38；家长库 `courses` 1315、`question_bank` 3575、`knowledge_points` 1969。
- ℹ️ `course_category_questions` / `topic_categories` **仍在**（见 §2.3 更正），各 0 行、无引用。
- ℹ️ 启动即触发一次 `stat` tick（既有行为，非本次引入）：闻闻 积分 `+20/-0`；珊珊 `+0/-10`。

**回滚方式**
1. `sudo systemctl stop learning-server`
2. `sudo cp -a /opt/learning-server/server.cjs.bak-20260915-0933 /opt/learning-server/server.cjs`
3. 如需还原数据：`sudo cp -a /opt/learning-server/data/backups/deploy-0.4.1-20260915-0933/. /opt/learning-server/data/`
4. `sudo systemctl start learning-server`，确认 `/api/v1/version` 回到 0.3.5。

> 备注：本次仅部署**服务端**。201 上的 **Ubuntu 客户端仍是旧版本**（服务器日志显示客户端仍在轮询 `/api/v1/children`、`/api/v1/scheduler/reminders`、`/api/v1/config/revision`，与新版服务端兼容工作）。如需在 201 上验证新的服务端 agent 能力，需另行更新客户端到 0.1.15。

---

## 10. 增量部署：服务端 0.4.2（2026-09-15 11:45，已完成）

**内容**：ISSUE-103 —— 家长 agent 新增 `parent_library_course_content`（读某课知识点+题）与 `parent_upsert_course_content`（写知识点+题+关联，整课替换）；prompt 增「落库课程考核内容」段。**纯代码变更，无 schema 变更、无人工迁移**（三张考核内容表 0.4.1 时已就位）。

| 项 | 值 |
|---|---|
| 版本 | 0.4.1 → **0.4.2**（`server/src/routes/version.ts` + `server/package.json` 同步 bump） |
| 结果 | ✅ `/api/v1/version` → **0.4.2**，features 不变 `[session_sync, worker, exam, server_agent, parent_agent, exam_agent]` |
| 健康 | `/api/v1/health` → `{"ok":true,"uptime":3,"db":"ok"}` |
| 进程 | `/usr/bin/node /opt/learning-server/server.cjs`（pid 933737，root，11:45:33 起） |
| 启动日志 | 零 `迁移/error/fail/FATAL`；worker 调度器已启动；监听 `127.0.0.1:8788` / `192.168.1.201:8788`；日志可见 Windows 客户端（192.168.1.200）的 `parent-agent/stream` SSE 已自动重连 |
| 停机时长 | 约 **3 秒**（stop 11:45:31 → started 11:45:33/34） |
| 备份（旧 bundle） | `/opt/learning-server/server.cjs.bak-20260915-1145`（17,545,271 B = 旧 0.4.1） |
| 备份（数据） | `/opt/learning-server/data/backups/deploy-0.4.2-20260915-1145/`（36 M，同 §9 口径） |
| 包内自查 | `grep -o` 命中：`0.4.2` ×1、`parent_upsert_course_content` ×8、`parent_library_course_content` ×10（证明新工具确在线上包内） |

**部署后只读探测（真实家长库，`node:sqlite` readOnly，未写入）**
- 家长库 `parents/86a84278…/parent.sqlite`：课程 1315 / 知识点 1969 / 题库题 3575 / 挂载行 3575。
- **单课最多挂题 9**（lunyu/论语公冶长篇第十章）、**单课最多知识点 5**（lunyu/论语雍也篇第三十章）→ 读工具单课输出体量很小，无需分页/截断。
- 数据一致性：**未挂题的知识点 0、未挂课的题 0、知识点指向不存在课程 0** → 「移除告警」不会被存量脏数据误触发。
- 磁盘：`/` 99G/116G（90%，剩 12G），备份占用无压力。

**回滚方式**
1. `sudo systemctl stop learning-server`
2. `sudo cp -a /opt/learning-server/server.cjs.bak-20260915-1145 /opt/learning-server/server.cjs`
3. （本次无 schema 变更，一般无需回数据）如需：`sudo cp -a /opt/learning-server/data/backups/deploy-0.4.2-20260915-1145/. /opt/learning-server/data/`
4. `sudo systemctl start learning-server`，确认 `/api/v1/version` 回到 0.4.1。

> 备注：**未改客户端**（0.1.15 无需升级，服务端变更向后兼容）。家长 agent 跑在服务端，Windows 客户端连的就是 201 → **新工具已对家长端可用**。
> ⚠️ 试点提示（ISSUE-102 教训）：若在**已有的 parent 会话**里问「你有没有建知识点的工具」，模型可能顺着历史回答否认。验证请用**新会话/重置后的会话**（重置语义已于 2026-09-15 修正为真正新会话）。

---

## 11. 增量部署：服务端 0.4.3（2026-09-15 13:33，已完成）

**内容**：ISSUE-104 —— 家长端「考核管理 → 自定义考核」白屏 + 家长 agent 查考核计划看不到课程细节（同一根因：`exam_plans.scope_json.courses` 自 09-14 起改为 `[{title,kps}]`，两个消费方仍按旧格式处理）。**纯代码变更、无 schema 变更**。

| 项 | 值 |
|---|---|
| 版本 | 0.4.2 → **0.4.3**（`routes/version.ts` + `server/package.json` 同步 bump） |
| 结果 | ✅ `/api/v1/version` → **0.4.3**，features 不变；`/api/v1/health` → `{"ok":true,"uptime":3,"db":"ok"}` |
| 进程 | `/usr/bin/node /opt/learning-server/server.cjs`（pid 935403，root，13:33:36 起） |
| 启动日志 | `ERR_COUNT=0`（无 error/fail/fatal/uncaught）；worker 起、监听 8788 |
| 停机时长 | 约 **2 秒**（13:33:34 stop → 13:33:36 started） |
| 备份（旧 bundle） | `/opt/learning-server/server.cjs.bak-20260915-1333`（17,510,718 B = 旧 0.4.2） |
| 备份（数据） | `/opt/learning-server/data/backups/deploy-0.4.3-20260915-1333/`（36 M） |
| 包内自查 | `grep -o`：`0.4.3`×1、`courseSpecs`×4、`parsePlanCourses`×3、`parent_upsert_course_content`×8 |

**接口级验证（真实数据，自签家长 token，只读）**
```
GET /exam/schedules/1f050a7f-…（珊珊）→ 200，1 条计划
  scope.courses     = ["论语学而篇第八章"]                       ← ✅ 字符串数组（老客户端不再白屏）
  scope.courseSpecs = [{"title":"论语学而篇第八章","kps":[{"name":"字词","count":1},
                       {"name":"道理","count":1},{"name":"句意白话","count":1}]}]   ← ✅ 新端可展示细节
PASS=2 FAIL=0（闻闻无进行中计划，无法断言；其数据本为空）
```

**回滚方式**
1. `sudo systemctl stop learning-server`
2. `sudo cp -a /opt/learning-server/server.cjs.bak-20260915-1333 /opt/learning-server/server.cjs`
3. （无 schema 变更，一般无需回数据）如需：`sudo cp -a /opt/learning-server/data/backups/deploy-0.4.3-20260915-1333/. /opt/learning-server/data/`
4. `sudo systemctl start learning-server`，确认 `/api/v1/version` 回到 0.4.2。

> 备注：**未改客户端**——老客户端连 0.4.3 已不再白屏（服务端把 `scope.courses` 归一成课程名数组）。若要看到「每课哪些知识点各几题」明细，需另行构建/发布客户端 0.1.16（已改好 `src/lib/plan-scope.ts` + `src/components/PlanCourseList.tsx`，本地构建通过）。

---

## 12. 增量部署：服务端 0.4.5 + 网页端同源托管（2026-09-16 09:03，已完成）

**内容**：Web 前端正式部署。服务端新增 ①`@fastify/static` 同源托管 `web/dist`（目录存在即启用，无则与纯 Electron 后端行为完全一致）；②`GET /materials/p/:token/*` 目录前缀资料路由（token 走路径段 + `<base>` 注入，修复课程 JS 动态拼接与 `media://` 固化协议 URL 的音视频在网页端不可播放）；③Fastify `maxParamLength` 100→1024（JWT 路径参数 414）。配套 `web/dist`（Vite 构建，React 复用 `../src` 渲染层 + `resolve.dedupe` 单实例修复）上传至 `/opt/learning-server/web/dist`。**无 schema 变更、无人工迁移**；所有既有 API 路由行为不变（Electron 客户端零影响）。

| 项 | 值 |
|---|---|
| 版本 | 0.4.4 → **0.4.5**（`routes/version.ts` + `server/package.json` 同步 bump） |
| 结果 | ✅ `/api/v1/version` → **0.4.5**，features 不变；`/api/v1/health` → `{"ok":true,...}` |
| 网页 | ✅ `http://192.168.1.201:8788/` → 200 text/html；`/assets/*` 200；启动日志含 `web frontend hosting enabled` |
| 进程 | systemd `learning-server`，active |
| 备份（旧 bundle） | `/opt/learning-server/server.cjs.bak-20260916-0903`（旧 0.4.4） |
| 上传物 | `server.cjs`（17.8 MB）+ `web/dist/`（index.html + assets/，约 1.5 MB） |
| 浏览器实测 | 局域网打开登录页正常渲染（`window.__bootErrs` 空）、test@qq.com 登录、孩子列表正常 |

**回滚方式**
1. `sudo systemctl stop learning-server`
2. `sudo cp -a /opt/learning-server/server.cjs.bak-20260916-0903 /opt/learning-server/server.cjs`
3. （可选移除网页）`sudo rm -rf /opt/learning-server/web`
4. `sudo systemctl start learning-server`，确认 `/api/v1/version` 回到 0.4.4。

> 备注：①本次**未改 Electron 客户端**——所有服务端改动为附加式（query token 兼容为"头优先、无头回退"），客户端直连 8788 行为不变。②局域网非 localhost 页面受浏览器策略限制**无法使用麦克风**（语音输入/发音评测），需 HTTPS 或 Chrome 白名单（见 `web/DEPLOY.md`）；localhost 不受限。③Web 端构建产物更新流程：`npm run web:build` → 同步 `web/dist/` 到 201 同路径，无需重启服务。

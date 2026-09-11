# 生产环境升级方案（201 · learning-server 计划域重构）

> 目标机：`192.168.1.201`（Ubuntu 24.04 / Node v24.15.0 / `systemd` 服务 `learning-server` / 端口 8788）
> 数据目录：`/opt/learning-server/data`
> 现状版本：**learning-server 0.3.4**（server.cjs 构建于 2026-09-07 10:43）
> 目标版本：**0.3.5**（当前代码基线 HEAD，含 2026-09-10 计划域重构 S1~S5 + 积分域）
> 文档时间：2026-09-11
> **状态：✅ 已于 2026-09-11 11:31~11:33 执行完成**（执行记录见 §11）

---

## 0. 结论摘要

生产与当前代码的差异**不在程序文件，而在数据落点**：

- **主库**（`server.sqlite`）几乎不用动 —— 只差 `study_plan_items.course_uuid` 一列（服务启动自动补列 + 回填脚本）。
- **孩子库**（`kb/<parentId>/<childId>.sqlite`，2 个）差异最大 —— 缺 11 张新表、缺 `courses.uuid`、缺 `daily_entries.plan_id/plan_outcome`，且多了 3 个待删废列，旧表 `todo_items` / `child_todo_stats` 里的数据需要搬进新表。
- **家长库**（`parents/<pid>/parent.sqlite`）差 `courses.uuid`、`topics.method_spec`、考核内容 4 张新表。

→ 升级 = **部署新 server.cjs + 跑 3 个迁移/回填脚本**。脚本已在本地用「生产同构的旧结构数据」完整演练通过（§9）。

**性质提示**：迁移含 `DROP COLUMN`，属**不可逆结构变更**；回滚必须同时恢复数据库备份（§6）。执行前会先停服 + 全量备份。

---

## 1. 升级范围

| 项 | 是否本次做 |
|---|---|
| 服务端代码升到当前 HEAD 构建 | ✅ 本次 |
| 主库 / 孩子库 / 家长库 结构补齐 | ✅ 本次 |
| 计划域历史数据迁移（study_plan_items / exam_schedules / todo_items / child_todo_stats） | ✅ 本次 |
| `course_uuid` 双回填（主库计划行 + 孩子库课程行） | ✅ 本次 |
| 家长库考核内容（题库 3575 题 / 类别 / 知识点）从本地同步到生产 | ⛔ 不做（见 §8.3，需单独决策） |
| 客户端升级、孤儿库清理、废表物理删除 | ⛔ 不做（见 §8.1 / §8.4） |
| 服务端版本号 0.3.4 → 0.3.5 | ⚠️ 待定（见 §8.2） |

---

## 2. 生产现状取证（2026-09-11 只读探针）

### 2.1 主库 `server.sqlite`（schema_version=5）

| 表 | 行数 | 说明 |
|---|---|---|
| parents / children | 1 / 2 | 唯一家长 `86a84278…`（test@qq.com）；孩子「闻闻」`09406c05…`、「珊珊`1f050a7f…` |
| study_plan_items | **290** | carried 37 / done 61 / pending 192（日期跨度 2026-09-03 ~ 09-30） |
| exam_schedules | **136** | pending 133 / started 3；**无 done** |
| exam_attempts | **0** | 生产从未完成过一次考核 |
| materials | 8381 | 索引行（文件在磁盘） |
| session_messages | 2858 | 会话同步 |
| scheduler_tasks / assignments | 2 / 4 | 「每日汇总」「自动新建会话 21:30」 |
| task_runs / worker_state | 34 / 6 | worker 游标 |
| `agents.sqlite` | prompts 3 / prompt_history 7 | 独立库，结构已匹配 |

主库结构已基本对齐（`materials` 已是复合主键、`children.profile_json` 已加、`scheduler_tasks` 已扩列、`exam_attempts.schedule_id` 已有）。

### 2.2 孩子库

| 孩子 | courses | daily_entries | todo_items | child_todo_stats | 缺 |
|---|---|---|---|---|---|
| 闻闻 `09406c05…` | 1196 | 263 | 38（**全部 source=parent**） | 8 | 新表 / uuid / daily 两列 |
| 珊珊 `1f050a7f…` | 1300 | 962 | 74（child 2 / parent 72） | 9 | 同上 |

两个库 `courses` 列均为：`… status, mastery, first_learned, last_review, review_count, … exam_mastery`（无 `uuid`）。

### 2.3 家长库 `parents/86a84278…/parent.sqlite`

- courses **1315** / topics 11 / tags 20
- `courses` **无 `uuid`**，有 `assess_rubric`（**全空：0/1315**）、有 `mastery`/`first_learned`
- `topics` 有 `assess_method`（全空 0/11），**无 `method_spec`**
- **无** `question_bank` / `topic_categories` / `course_category_questions` / `knowledge_points`

### 2.4 其他

- 孤儿孩子库 `kb/86a84278…/4d6e76fc-….sqlite`（512 门课，**不在 `children` 表**）
- 测试遗留：`kb/test-parent/`（2 个库）
- 磁盘：`/` 116G 用 98G，**剩 13G（89%）**；本次备份约 30MB，无压力

---

## 3. 差异清单（生产 → 当前代码）

| # | 落点 | 生产现状 | 当前代码期望 | 修复方式 | 谁执行 |
|---|---|---|---|---|---|
| D1 | 主库 `study_plan_items` | 无 `course_uuid` 列 | 有，且已回填 | 服务启动 `ALTER`（幂等）+ `backfill-plan-course-uuid.cjs` | 自动 + 脚本 |
| D2 | 孩子库 新表 | 无 | 11 张（三计划表 / exam_plan_courses / plan_recurrences / 积分域 6 张） | `openKb()` 幂等建表 | 自动 |
| D3 | 孩子库 `courses` | 有 `mastery`/`exam_mastery`/`first_learned`，无 `uuid` | 三列删除，有 `uuid` | `dropLegacyCourseColumns` + `ensureCourseUuidColumn` | 自动 + 回填 |
| D4 | 孩子库 `daily_entries` | 无 `plan_id`/`plan_outcome` | 有 | `ensureDailyPlanColumns` | 自动 |
| D5 | 孩子库 视图 | 仅 `topic_progress` | 加 `course_progress` | `openKb()` 建视图 | 自动 |
| D6 | 孩子库 数据 | `todo_items` / `child_todo_stats` 有数据 | 迁入 `life_plans` / `reward_daily_stats`；旧表停用 | `migrate-plan-domain.cjs` | 脚本 |
| D7 | 主库 → 孩子库 数据搬迁 | 计划/考核在主库 | 拆入各孩子 kb | 同上 | 脚本 |
| D8 | 家长库 `courses` | 无 `uuid`，有 `mastery`/`first_learned` | 有 `uuid`，无那两列 | `ensureAssessContentSchema` + `dropLegacyCourseColumns` | 自动 |
| D9 | 家长库 `topics` | 无 `method_spec` | 有 | `ensureAssessContentSchema` | 自动 |
| D10 | 家长库 新表 | 无考核内容 4 表 | 有（本次仅建表，不灌内容） | `ensureAssessContentSchema` | 自动 |

> 「自动」= 由新代码在打开库时幂等执行；迁移脚本会**先打开库**，所以脚本一跑就全部补齐。

---

## 4. 升级动作清单（做什么）

1. **构建**：`node server/scripts/build.mjs` → `server/dist/server.cjs`（本地已完成，15.9MB）
2. **打包迁移器**（201 上无 tsx，用 esbuild 打成单文件 cjs）：
   `migrate-plan-domain.cjs` / `backfill-plan-course-uuid.cjs` / `backfill-kb-course-uuid.cjs`
3. **停服** → `systemctl stop learning-server`
4. **全量备份**：`VACUUM INTO` 生成 server.sqlite / agents.sqlite / 2 个孩子 kb / 家长库的一致性副本 → `data/backups/pre-plan-domain-<ts>/`（含 `manifest.json` 供回滚）；旧 `server.cjs` 备份为 `server.cjs.bak-<ts>`
5. **部署**新 `server.cjs` → `/opt/learning-server/server.cjs`
6. **迁移**：干跑 → 正式 → 回填 course_uuid（主库 + 孩子库）
7. **验收**：结构 + 行数 + 幂等标记（17 项检查）
8. **起服** → 版本/健康冒烟 → 日志查错

---

## 5. 执行步骤（确切命令）

> 一键驱动脚本：`tmp/deploy/upgrade_201_plan_domain.py`
> `python upgrade_201_plan_domain.py --precheck` → 只读差异体检（已跑，见 §2/§9）
> `python upgrade_201_plan_domain.py --execute` → 正式升级（含失败自动回滚）

| 步 | 动作 | 命令（201 上，除注明外均 `sudo`） | 预期 |
|---|---|---|---|
| 1 | 预检 | `node -v` / `systemctl is-active learning-server` / `df -h /opt` | active、v24、剩 13G |
| 2 | 备份 | `node /tmp/upgrade201/snapshot.js /opt/learning-server/data <backup>` | 6 个库副本 + manifest.json |
| 3 | 备份旧码 | `cp -p /opt/learning-server/server.cjs …/server.cjs.bak-<ts>` | — |
| 4 | 停服 | `systemctl stop learning-server` | inactive |
| 5 | 部署 | `cp -f /tmp/upgrade201/server.cjs.new /opt/learning-server/server.cjs` | 新文件 15.9MB |
| 6 | 迁移干跑 | `node migrate-plan-domain.cjs /opt/learning-server/data --dry-run` | 打印各孩子行数，**不写库** |
| 7 | 迁移正式 | `node migrate-plan-domain.cjs /opt/learning-server/data` | 见 §7 预期数字 |
| 8 | 回填 | `node backfill-plan-course-uuid.cjs <data>` → `node backfill-kb-course-uuid.cjs <data>` | 主库命中 ~287/290；孩子库通常 0（迁移已含） |
| 9 | 验收 | `node verify-upgrade.js <data>` | **退出码 0 / 「全部通过」** |
| 10 | 起服 | `systemctl start learning-server` | active |
| 11 | 冒烟 | `curl :8788/api/v1/version` + `/api/v1/health` | `{"ok":true,…}` |
| 12 | 日志 | `tail -n 60 <data>/logs/server-log.jsonl \| grep -i error` | 无 error |

**顺序红线**：必须「先停服 → 再备份 → 再迁移」。若服务在跑时迁移，旧 worker 会同时写 `todo_items`，造成迁移快照与写入竞态。

---

## 6. 回滚方案

迁移含 `DROP COLUMN`（孩子库/家长库 `courses` 的 `mastery/exam_mastery/first_learned`），**旧代码读这些列，所以只回滚 server.cjs 会崩**。回滚必须恢复库：

1. `systemctl stop learning-server`
2. 按 `<backup>/manifest.json` 把 6 个库副本覆盖回原路径，并删除对应 `-wal` / `-shm`（脚本已实现）
3. `cp -f /opt/learning-server/server.cjs.bak-<ts> /opt/learning-server/server.cjs`
4. `systemctl start learning-server` → 校验 `/api/v1/version`
5. 校验业务：孩子端「今日计划」、家长端进度

驱动脚本在**验收失败时自动执行上述回滚**（交互式确认；非交互默认回滚）。

---

## 7. 验收标准（预期数字）

生产预期（按 201 现有数据推算）：

| 项 | 预期 |
|---|---|
| 主库 `study_plan_items` | 290 行不变；~~`course_uuid` 回填 ≈287/290~~ → **该列不参与验收**（见下方说明）。实测回填 279/288（修正 `backfill-plan-course-uuid` 加标题兜底后） |
| 闻闻 kb `study_plans` | 116（原 `study_plan_items` 闻闻侧）；`course_uuid` 111/116 |
| 珊珊 kb `study_plans` | 174；`course_uuid` 170/174 |
| 两个 kb `exam_plans` | 合计 136（原 `exam_schedules`；其中 18 条过期 pending → `missed`） |
| 两个 kb `exam_plan_courses` | 0（生产 `exam_attempts` 为空） |
| `life_plans` | 2（仅珊珊 `todo_items.source='child'` 的 2 条；闻闻 38 条全是 parent，按设计不迁） |
| `reward_daily_stats` | 34（`child_todo_stats` 8+9 行 × parent/child 两组） |
| 孩子库 `courses.uuid` | 1196/1196、1300/1300 |
| 家长库 `courses.uuid` | 1315/1315 |
| 历史过期 pending | 一律 `missed` + `active=0`（**不生成 carry**，不会刷出大量新计划） |
| `meta.plan_domain_migrated` | 两个孩子库均有时间戳 |

**关于主库 `study_plan_items.course_uuid`（2026-09-11 修正验收口径）**：该表是**已迁出的遗留表**，当前代码**无任何读取方**（`server/src/routes/exam.ts:654` 的固定档考核候选只取 `date/topic_key/course_name`）。因此它的回填率**不作为验收断言**，只在验收输出里以 `[参考]` 记录。
另发现并修复了 `backfill-plan-course-uuid.mts` 的一个匹配缺陷：它只按 `(topic_key, course_name)` 精确匹配，而生产 288/290 行的 `topic_key` 历史为空 → 命中仅 2/290（假象）。现补上「标题唯一命中」兜底（与 `migrate-plan-domain` 同口径），生产实测提升到 **279/288**（余 9 行是家长库已无的「论语…（上）/（下）」后缀课程，属正常）。

`verify-upgrade.js` 把关键项做成断言；**退出码非 0 即视为失败**。

> 迁移的「不回溯」保证：`reward_daily_stats.settled_at` 留空 + 积分只在 `23:59:59` 后结算 → **不会给历史补发/补扣积分**。

---

## 8. 风险与待决策

### 8.1 客户端兼容（**结论：本次只做服务端**）
- 当前服务端已**移除** `kb.todo.*` 系列 op（旧客户端「今日待办」会报「未知操作」），新增 `/api/v1/plans/*`、`/api/v1/rewards/*`。
- **用户决定（2026-09-11）**：本次只升级服务端，**客户端打包发布与更新由另一个任务完成**。
- 因此当前处于「新服务端 + 旧客户端」过渡态：数据无损、核心路径可用，但旧客户端上依赖 `kb.todo.*` 的界面会报错，直到客户端升级完成。
- 实测：起服后 201 本机 GUI 与 LAN 客户端（192.168.1.101）已正常连回，`/api/v1/version`、`/api/v1/children`、`/api/v1/config/revision`、`/api/v1/scheduler/reminders` 全部 200。

### 8.2 版本号（**已执行：0.3.4 → 0.3.5**）
`server/src/routes/version.ts` 的 `SERVER_VERSION` 与 `server/package.json` 已同改为 **0.3.5** 并重建（生产冒烟确认 `/api/v1/version` 返回 0.3.5）。

### 8.3 家长库考核内容为空（**结论：本次不做，用户已确认**）
生产家长库 `assess_rubric` 0/1315、`assess_method` 0/11，考核内容 4 表为空；而**本地家长库已有 3575 道结构化题目 + 5 个类别 + 课程 uuid**。
- 生产 136 条考核排期全部 pending、`exam_attempts=0` → 考核功能在生产实际未被使用，**不迁移不构成回归**。
- 若要同步，需按 `(topic,title)` 把本地 `question_bank/topic_categories/course_category_questions` + `courses.uuid` 重映射到生产家长库（本地 uuid 是随机生成，必须重映射，不能直接照搬）。
- 建议**另起一个任务**做，不在本次结构升级里夹带。

### 8.4 其他
1. **孤儿孩子库** `4d6e76fc-…`（512 门课，不在 `children` 表）：迁移会跳过（脚本按 `children` 遍历）。本次不动，建议另案判定归属后清理。
2. **`todo_items` / `child_todo_stats` 废表**：按设计「迁完即下线」，但**本次不物理删除**（保留只读一版作为审计/回退依据），下一版清理。
3. **家长类 todo_items 110 条不迁移**（38 闻闻 + 72 珊珊）：设计上由 `study_plans` 承载，历史执行记录保留在旧表只读。
4. **起服后 worker 行为变化**：plan tick 只展开 `plan_recurrences`（生产为空 → 空跑）；stat tick 每 2 分钟做三域判定 + 归属日统计 + 积分结算（只在 23:59:59 后发分）。起服后 3 秒内有 catch-up 跑，需看日志确认无异常。
5. **磁盘 89%**：本次备份约 30MB；后续若要保留多份备份需留意。
6. **客户端/服务端时钟**：迁移用 `toLocaleDateString("sv-SE")` 取本地日期，201 时区为 CST，与生产一致。

---

## 9. 演练证据（本地，2026-09-11）

用本地 `server/data/backups/pre-plan-domain-20260910125038`（**迁移前的真实旧结构**，含 server.sqlite + 3 个孩子库）在沙盒里复现生产场景，跑完整链路：

```
前置快照 + 备份   exit=0   6 个库 VACUUM INTO 副本 20.6MB + manifest.json
迁移干跑         exit=0   学习计划 168 / 考核计划 56 / 考核明细 52 / 生活计划 9 / 日统计 10 / uuid 回填 2501
迁移正式         exit=0   同上，3 个孩子全部写 plan_domain_migrated
回填主库 uuid    exit=0   命中 165/168（3 条汉字宫课程家长库已删，属正常）
回填孩子库 uuid  exit=0   0（迁移已含，幂等）
验收             exit=0   ========== 验收结果：全部通过 ==========
```

幂等性额外验证：对已迁移库重跑 → `跳过(已迁) 3`，无重复写入。
打包产物：`migrate-plan-domain.cjs` 51KB / `backfill-plan-course-uuid.cjs` 28KB / `backfill-kb-course-uuid.cjs` 41KB（纯 node 可跑，201 无需 tsx）。

---

## 10. 产出物清单

| 文件 | 说明 |
|---|---|
| `tmp/deploy/upgrade_201_plan_domain.py` | 升级驱动（`--precheck` / `--execute`，含失败自动回滚） |
| `.workbuddy/tmp/deploy201/server.cjs.new` | 当前 HEAD 构建的服务端单文件 |
| `.workbuddy/tmp/deploy201/migrate-plan-domain.cjs` | 计划域迁移（主库 → 孩子库） |
| `.workbuddy/tmp/deploy201/backfill-plan-course-uuid.cjs` | 主库计划行 uuid 回填 |
| `.workbuddy/tmp/deploy201/backfill-kb-course-uuid.cjs` | 孩子库课程 uuid 回填 |
| `.workbuddy/tmp/deploy201/snapshot.js` | 基线快照 + VACUUM INTO 备份 + manifest |
| `.workbuddy/tmp/deploy201/verify-upgrade.js` | 17 项验收断言（沙盒与 201 通用） |
| `.workbuddy/tmp/rehearsal*` | 本地演练沙盒与备份（可删） |

---

## 11. 执行记录（2026-09-11 11:31~11:33，已完成）

### 11.1 实际执行时间线

| 时刻 | 动作 | 结果 |
|---|---|---|
| 11:31 | 预检 + 上传工件 | 版本 0.3.4 / 服务 active / 剩 13G |
| 11:31 | 停服 | inactive |
| 11:31 | 备份 → `data/backups/pre-plan-domain-20260911-113102/` | **8 个库**（server / agents / 2 孩子 / 孤儿孩子库 / 2 test-parent / 家长库）共 15.4MB + `manifest.json` |
| 11:31 | 旧代码备份 | `server.cjs.bak-20260911-113102` |
| 11:31 | 部署 0.3.5 server.cjs | 16625949 B |
| 11:32 | 迁移干跑 → 正式 | 学习计划 290 / 考核计划 136 / 考核明细 0 / 生活计划 2 / 日统计 34 / uuid 回填 2496 |
| 11:32 | 回填脚本 | 见 §11.3（发现并按修正后重跑） |
| 11:32 | 首次验收 | **1 项未通过** → 停在「已迁移未起服」（详见 §11.3） |
| 11:32 | 修正验收口径 + 重跑 | **全部通过** |
| 11:32:44 | 起服 | active，PID 889829 |
| 11:33 | 冒烟 | `/api/v1/version` = **0.3.5**；`/api/v1/health` = `{"ok":true,"db":"ok"}` |
| 11:33+ | 日志 | **0 条 error**；客户端已连回（201 本机 + 192.168.1.101） |

### 11.2 迁移实际产出（与预期一致）

| 项 | 预期 | 实测 |
|---|---|---|
| `study_plans` | 290（116/174） | ✅ 116 / 174 |
| `exam_plans` | 136 | ✅ 68 / 68（含 18 条过期 pending → missed） |
| `exam_plan_courses` | 0 | ✅ 0 |
| `life_plans` | 2 | ✅ 0 / 2 |
| `reward_daily_stats` | 34 | ✅ 16 / 18 |
| 孩子库 `courses.uuid` | 2496 | ✅ 1196 / 1300 |
| 家长库 `courses.uuid` | 1315 | ✅ 1315 |
| 生活计划 carry 洪水 | 无 | ✅ 无（过期行 active=0） |
| 回溯发分 | 无 | ✅ `points_ledger` = 0，`points_balance` 均为 0 |

起服后健康核查：`points_balance` 于 11:32:48 被 stat tick 重算（证明 worker 正常跑通）；`study_plans` 状态计数在起服前后**无变化**（stat 未误改历史）；`daily_entries.plan_id` 仍为 0（recording 定时在 21:00，尚未触发）。

### 11.3 过程中发现并处理的两个问题（复盘）

**① 驱动脚本的回滚分支失效（已在脚本中修复）**
首次验收失败后，脚本判定「非交互 → 自动回滚」的分支没生效：Git Bash 下即使 `python … < /dev/null`，`sys.stdin.isatty()` 仍返回 True，随后 `input()` 抛 `EOFError` 直接退出，**回滚被跳过、生产停在「已迁移但服务未启动」状态**（约 1 分钟）。
→ 处置：人工判断为「非数据故障，可修复前进」后选择 fix-forward（未回滚），起服恢复。
→ 修复：`upgrade_201_plan_domain.py` 改为环境变量 `ROLLBACK_ON_FAIL`（默认 `yes`）+ 不再依赖 `input()`，并补 `import os`。**下次执行不会再卡在这一步。**

**② 验收口径过严 + 回填脚本匹配缺陷（已修复）**
首次验收失败的唯一项是「主库 `study_plan_items.course_uuid` 回填 2/290」。定位：
- `backfill-plan-course-uuid.mts` **只按 `(topic_key, course_name)` 精确匹配**；生产 288/290 行的 `topic_key` 历史为空 → 命中率天然为 2/290（**是脚本缺陷，不是数据损坏**）。
- 且该列**当前代码无任何读取方**（计划数据已迁到孩子库；`exam.ts:654` 只取 `course_name`）→ 不该作为验收断言。
→ 处置：①`verify-upgrade.js` 改为断言真正有读取方的 **`study_plans.course_uuid`**（111/116、170/174），遗留表降级为 `[参考]`；②`backfill-plan-course-uuid.mts` 补上「标题唯一命中」兜底（与 `migrate-plan-domain` 同口径），生产重跑后从 2 提升到 **279/288**（余 9 行是家长库已无的「（上）/（下）」后缀课程）。

### 11.4 回滚点（如需）

- 库备份：`/opt/learning-server/data/backups/pre-plan-domain-20260911-113102/`（含 `manifest.json`）
- 旧代码：`/opt/learning-server/server.cjs.bak-20260911-113102`
- 回滚步骤见 §6；`ROLLBACK_ON_FAIL=yes`（默认）时驱动脚本会自动完成。

### 11.5 遗留（不在本次范围）

1. **客户端升级**：由另一任务完成（服务端已移除 `kb.todo.*`，旧客户端待办界面会报错）。
2. **家长库考核内容**：生产仍为空（本次按决定不同步）。
3. `study_plan_items` / `todo_items` / `child_todo_stats` 废表**未物理删除**（保留只读，一版后清理）。
4. 孤儿孩子库 `4d6e76fc`（512 门课）与 `kb/test-parent/*` 已随本次备份留档，未清理。
5. `backfill-plan-course-uuid.mts` 已修但**生产用的 bundle 是修正后的版本**；仓库源文件同步已改（`server/scripts/backfill-plan-course-uuid.mts`）。

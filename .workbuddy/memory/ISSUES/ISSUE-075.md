# ISSUE-075｜客户端推送空「固定档频率」→ 服务端跨孩子删除未来排期（固定档考核静默停摆）

- **类型**：bug（数据误删 + 功能静默停摆）
- **优先级**：**高**（生产已发生：136 条排期被删只剩 18 条，且固定档从此不再生成）
- **记录时间**：2026-09-11
- **状态**：待修复（仅登记；生产现场已取证，恢复动作待用户确认）

---

## 生产处置（2026-09-11 14:58，按用户决定：生产暂时不开启考核）

用户决定：**生产里不要有任何考核排期，暂时不开启考核**。已执行（脚本 `.workbuddy/tmp/deploy201/exam-off.js`，可重跑）：

| 动作 | 结果 |
|---|---|
| 备份 | `data/backups/pre-exam-off-2026-09-11T06-58-25-452Z/`（server.sqlite 6244KB + agents + 两孩子 kb） |
| 主库 `exam_schedules` | 删除 **18 行** → 0 |
| 孩子 kb `exam_plans` | 闻闻 **68 行** / 珊珊 **68 行** → 0（仅删 `COALESCE(attempt_id,'')=''` 的行；**真考过的场次一律保留**——生产 `exam_attempts=0`，故本次全为排期态） |
| `exam_plan_courses` | 0 行（无变化） |
| 不回归验证 | `GET /exam/schedules/:childId` → `generated=0 schedules=0`，**复查后主库仍为 0**（因 `exam_fixed.frequencies=[]`，`ensureFixedSchedules` 首行 `return 0`，不会懒生成） |
| 服务 | active / health ok / 0 条 error 日志 |

`reward_daily_stats` 全部为 `source='todo'`（无 exam 来源），故删除排期不会产生孤儿统计。

**重新开启考核前必须先修本 issue 的①②**（否则一改配置又会跨孩子误删）：
1. `exam.ts:1254` 的 DELETE 补 `child_id`/`parent_id` 作用域；
2. 客户端不得用本地空 `frequencies` 覆盖服务端配置。

**当前状态下要重新开启考核的做法**：把 `settings.exam_fixed:<parentId>` 的 `frequencies` 恢复为 `["daily","weekly"]`（`time:19:00`、`weekly.weekday:5` 仍在配置里），打开一次考核页即自动铺未来 60 天排期。

---

## 现场（2026-09-11 生产 201）

| 时刻 | 事件 |
|---|---|
| 11:31 | 升级前快照：`exam_schedules` **136 行**（pending 133 / started 3，日期跨度 2026-09-02 ~ 2026-11-08，created_at 2026-09-03） |
| 11:32 | 计划域迁移把它按孩子拆进孩子库 `exam_plans` = **68 + 68**（这部分**未受影响**，仍在） |
| 14:40:50 | 来自 `192.168.1.200`（客户端机器）的 `POST /api/v1/exam/fixed-config` |
| 14:40:52 | 同一来源再次 `POST /api/v1/exam/fixed-config` → `settings.exam_fixed:<parentId>` 被写成 **`frequencies: []`**（`updated=2026-09-11T06:40:52.047Z`） |
| 同时 | 主库 `exam_schedules` 只剩 **18 行**（每孩子 9 条，全部 `created_at=2026-09-03`、`scheduled_at ≤ 2026-09-10`）→ **118 行未来排期被删** |

**证据**：`data/logs/server-log.jsonl` 中 `fixed-config` 的 POST 两条（`ip 192.168.1.200`），且全部非 GET 请求时间线与 settings 的 `updated` 时间戳吻合。

## 根因

### ① 服务端：删除语句没有作用域（主因）
`server/src/routes/exam.ts:1247-1256`

```ts
const changed = ...frequencies/time/weekly 任一变化...;
if (changed) {
  deps.db.prepare("DELETE FROM exam_schedules WHERE kind = 'fixed' AND status = 'pending' AND scheduled_at > ?")
    .run(new Date().toISOString());
}
```

- 该 DELETE **既无 `child_id` 也无 `parent_id` 条件** → 一次配置变更会删掉**所有家长、所有孩子**的未来固定排期（当前生产只有 1 家长 2 孩子，故表现为误删）；
- 「changed」判据过宽：客户端把 `frequencies` 从 `[daily,weekly]` 覆盖成 `[]`（或反过来）都会触发；
- 删除后依赖 `ensureFixedSchedules` 懒生成补回，但 **`frequencies: []` 时该函数第一行就 `return 0`**（`exam.ts:247`）→ **排期再也不会生成**，固定档考核静默停摆，界面无任何提示。

### ② 客户端：用本地（空）状态覆盖服务端配置（触发源）
写入方是客户端机器（192.168.1.200），不是服务端自身逻辑。需在客户端侧查：为何把 `frequencies` 传成空数组（本地未加载到固定档配置即提交？打开设置页自动保存？），以及是否有「保存前先 GET 合并」的防护。

## 影响范围

- 家长端「考核计划」未来排期为空白；固定档考核不再产生。
- 孩子端拿不到未来排期 → 无法按计划参加考核。
- **不受影响**：孩子库 `exam_plans`（68+68，迁移产物）；已完成的 `exam_attempts`（生产为 0）。
- 数据可恢复：`ensureFixedSchedules` 是确定性懒生成，配置修好后打开一次考核页即补齐未来 60 天；旧的 118 行也在 `data/backups/pre-plan-domain-20260911-113102/server.sqlite` 里。

## 排查 / 修改入口（可直接执行）

1. **服务端加作用域（必做）**：`exam.ts:1254` 的 DELETE 补 `AND child_id = ?`（或 `AND parent_id = ?`，按产品口径：配置是 parent 级则按 parent），并把 `childId`/`parentId` 作为参数传入。
2. **服务端加护栏**：`frequencies` 为空时（=关闭所有固定档）应**先征询/记录**再删，或改为「只删本次配置对应孩子的未来排期」＋写一条审计日志（谁在什么时候删了多少行）。
3. **客户端**：`PUT /exam/fixed-config` 前必须先 GET 服务端配置并合并，禁止用空数组覆盖；或在客户端判断「未加载完成」时不上报。
4. **回归用例**：构造两个家长/两个孩子 → 家长 A 改配置 → 断言家长 B 的排期行数不变。

## 生产恢复建议（待用户确认后执行）

1. 把 `settings.exam_fixed:<parentId>` 的 `frequencies` 恢复为 **`["daily","weekly"]`**（依据 2026-09-09 定案「固定档 daily/weekly = plan 周期内必学课全考」；`time:19:00`、`weekly.weekday:5/time:20:00` 仍在配置里，说明这两档原本是开启的）。
2. 打开一次家长端「考核计划」（或直接调 `GET /exam/schedules/:childId`）→ `ensureFixedSchedules` 自动补生成未来 60 天排期（截至 2026-11-10，覆盖原 11-08 范围）。
3. 校验：每孩子未来排期行数 > 0 且日期连续；家长端/孩子端可见。
4. **不建议**从备份回灌那 118 行：懒生成结果确定且按天去重，回灌反而会与后续生成产生重复/冲突。
5. 修复①之前，提醒家长**不要在旧客户端上改动考核设置**，否则会再次触发全量删除。

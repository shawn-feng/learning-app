# ISSUE-150：「固定考核」自 2026-09-14 起就没再生成过 —— exam_plans 的 INSERT 列数/值数不一致

**日期**：2026-09-25 · **环境**：本机（与 201 同代码）· **状态**：代码已修（本地，未部署）+ 回归测试已加

## 现象

跑本机 server 时，日志每 2 分钟一条（plan tick）：

```
[worker:plan] exam-fixed parent=86a84278-c8ae-415e-8fbc-6140b1b7c88e failed: 22 values for 23 columns
```

⇒ `ensureTodayExamPlans()` 每次 tick 都在抛错。该家长配置为 `exam_fixed = {frequencies:["weekly"], weekly:{weekday:5}}`（每周五 20:00），
而孩子库里最后一条 `kind='fixed'` 计划的 `created_at` 停在 **2026-09-11T23:08**：此后到今天（09-25，周五）**一条都没再生成**。

## 根因

`exam_plans` 的列在历史演进中变过（新增 `retake` 等），但 `server/src/routes/exam.ts` 里两条 INSERT 的 `VALUES` 没跟上，
并且**把占位符写成了字面量 `'?'`**、值与列的对应整体错位一格：

| 位置 | 用途 | 列/值 | 实际报错 |
|---|---|---|---|
| `exam.ts:252` | 固定考核（worker 每 tick 调用） | 23 列 / 22 值 | `22 values for 23 columns` |
| `exam.ts:1091` | `POST /exam/schedules`（家长手动建考核） | 24 列 / 23 值 | `23 values for 24 columns` |

两处均由 `4e1d8c63`（2026-09-14）引入，**坏了 11 天没人发现**，原因是双重的：

1. 异常被 `runPlanTick` 的 try/catch 吞掉，只留一行 `console.error`；
2. **没有任何测试覆盖这两条 INSERT**——`ensureTodayExamPlans` 全仓 0 个测试，路由级也没有。

影响面：**固定考核（每日/每周）从不生成**（家长侧可感症状）；`POST /exam/schedules` 也坏着（桌面 IPC `exam:scheduleCreate`
与 web shim 同名方法可直达，但当前渲染层没有调用点，所以这半边的用户可感症状尚未出现）。

## 修复

| 层 | 改动 |
|---|---|
| 固定档 | `VALUES (?,?,?,?,'parent','fixed',?,?,'config','',?,?,'pending','',NULL,'','','required',1,0,1,?,?)`（23/23；占位符顺序与 `.run()` 的 10 个参数一一对应） |
| 自定义档 | `VALUES (?,?,?,?,'parent','custom','',?,'conversation','',?,?,'pending','',NULL,'','','required',1,0,1,?,?,?)`（24/24；`retake` 按列序在末位，`.run()` 参数顺序不变） |
| 测试 | 新增 `test/issue150-fixed-exam-insert.test.ts`：① **静态自检**——扫 `server/src/**/*.ts` 里所有静态可判定的 INSERT（96 条），断言列数 == 值数；② **端到端**——真调 `ensureTodayExamPlans()`，断言落库一条 `kind='fixed'` 且 `creator='parent'`、`origin='config'`、`status='pending'`、`task_type='required'`、`count_in_rate=1`、`points=0`、`active=1`、`retake=''`、`scope_json.courses` 含该课，同日再 tick 幂等返回 0 |

## 验证

1. **排除假绿**：`git stash` 掉 `exam.ts` 的修复后复跑 → **2/2 失败**（静态自检报列/值不一致 + 端到端报 `22 values for 23 columns`）；恢复修复后 2/2 通过；
2. **线上形态实证**：带修复重启本机 server，等第一个 plan tick 后查孩子库 ——
   ```
   fixed: 固定考核（每周） weekly start=2026-09-25 00:00:00 created=2026-09-25T12:54:50.152Z
   （fixed/weekly 12 → 13）
   ```
   即自 2026-09-11 起第一次成功生成。3 个孩子里只有"今日窗口内有计划课程"的那 1 个生成，符合 `entries.length === 0 → 跳过` 的设计；
3. `cd server && npx tsc --noEmit` **exit 0**；
4. 全量 `npx vitest run`：**8 files / 15 tests 失败，804 passed / 8 skipped（77 files / 827）**，失败清单与既有基线逐项一致（`assess-guide` / `assessment` / `english-course-session` / `event-poll-config` / `kb-sqlite` / `page-bridge` / `sync` / `token-stats`），**零新增失败**；留档 `tmp/issue150-exam-insert-regression.txt`。

## 留出

- **历史不会补**：`ensureTodayExamPlans` 只生成"当天"，09-14 以后缺失的固定考核不会自动补。要不要补历史（以及 09-25 当天要不要给其余孩子补一场），需家长拍板。
- `POST /exam/schedules` 修好了但**没有端到端用例**（路由级夹具需要 fastify + JWT，本轮没做），只有静态自检兜底。
- 静态自检只覆盖"列/值都是字面量、无括号嵌套"的 INSERT（本轮 111 个 .ts 里可判定 96 条）；模板拼接动态生成的 SQL 不在覆盖内。

# ISSUE-149：跨日期计划被提前顺延，产生同名重复计划

**日期**：2026-09-25 · **环境**：201 生产 · **状态**：代码已修（本地，未部署）+ 存量已订正

## 现象

家长 09-24 对话排「2026-09-24学校作业」（24~27 号，家长视角是一条跨日期计划）。09-25 06:26 出现两个同名待完成计划，且 09-24 被判 missed、完成率 -10。

## 根因（三层）

1. **工具契约缺跨日期表达**：所有对话创建工具（`parent_study_plan_create` 等）参数只有逐天 `date`，没有起止范围。模型只能把"24~27 号完成作业"拆成 4 行同名单日行（课程名还把起始日期编了进去）。
2. **顺延无条件复制**：`expireAndCarry`（server/src/worker/plan-domain.ts）对 `due_at < now` 的 pending 行先置 missed 再无条件复制 carry 行到当天，不检查目标日是否已有同身份 pending 行 → 与家长已排的次日行撞名。
3. **结算归属按窗口覆盖**：`computeGroupStats` 分母 = 窗口覆盖当天的行 → 引入跨日期行后会每天进分母（未完成每天 -10、完成后每天 +20），必须同步收口。

时间线：missed/carry 发生在每日**首个 stat tick**（Mac mini 夜间休眠，唤醒后首跑 = 06:26，journalctl 证实）；即便不休眠也会在 00:02 发生，休眠只影响时刻不影响因果。

顺带发现：plan-domain.ts 注释称"考核只判 missed 不顺延"，实际全库唯一写 missed 的就是 expireAndCarry 且 specs 无 exam_plans——考核既不自动 missed 也不顺延（注释已改）；study-plans 路由缺省"今天"用 UTC 日（已改本地日）。

## 修复（ISSUE-149，本地已完成 + 测试）

| 层 | 改动 | 文件 |
|---|---|---|
| 创建 | 四个创建工具加可选 `endDate`（跨日期行 start=首日 00:00:00 / due=末日 23:59:59；endDate 时 content/courses 只能一项；life 的 time=结束日截止时刻）+ description 三形态说明 | `server/src/agent/parent-plans.ts`、`server/src/agent/plan-tools.ts` |
| 顺延 | expireAndCarry 防重：目标日已有同身份（study: creator+topic_key+course_name+mode；life: creator+title）pending 行 → 只置 missed 不复制 | `server/src/worker/plan-domain.ts` |
| 结算 | computeGroupStats：单日行（start=due）口径不变；跨日期行只在**完成日或到期日**进分子分母；cancelled 不计分母（对齐路由既述口径）；due_at='' 行保留旧行为 | `server/src/worker/plan-domain.ts` |
| 技能 | plan 技能三选一路由（跨日期一件事→endDate 行 / 每天各不同→逐天 / 每天重复→规则）+ 参数速查 + 口径（跨日期只在结束日判定）+ 复述模板；REPEAT_RULES_BLOCK 同源块同步（plan/automation 两技能共用） | `server/src/agent/skills/parent/plan.ts`、`shared.ts` |
| 展示 | `toPlanDto` 补 `endDate`；缺省"今天" UTC→本地 | `server/src/routes/study-plans.ts` |
| 测试 | `test/issue149-crossdate-plan.test.ts` 15 例（创建窗口/中间日不判/末日才 carry+顺延/结算只计完成日或到期日/单日行不变/cancelled 不计/防重不误伤）+ issue144 技能关键词钉死（"不要拆成多行""只在结束日判定"） | test/ |

全量 vitest：计划域相关 81 例全绿；其余 15 个失败经 stash 对照证实为工作区 ISSUE-148 在途改动的预存失败，与本修复无关。

## 存量订正（201，2026-09-25 09:03）

- child `09406c05`：carry 行 `e4fdeb67`（窗口 09-25，与排期行 `9fccaa92` 撞名）→ `status='cancelled', active=0`，result 留痕。✅
- child `1f050a7f`：carry 行 `56ee0b3b` 已于 08:52 被家长标 done，无需处理。✅
- 扫描两个 KB：无其他同类重复。
- 备份：`201:/tmp/issue149-backup-20260925_0903{37}/`（含 090250 首次）。订正脚本：`tmp/deploy/issue149_fix_201.py`。

## 遗留

- **代码未提交、未部署**。旧逻辑还在 201 上跑：今晚 09-25 排期行到期后，明早 06:26 仍会按旧逻辑 missed+carry 撞 09-26 的排期行（child 09406c05: `9fccaa92`→`ebc7812c`；child 1f050a7f: `62489e44`→`dba801f7`）。**建议在明早 06:26 前部署**（部署后 carry 防重生效即不再重复）；届时需再订正一次或直接靠防重。
- -10 误扣未回补（结算一次性语义，待家长/用户拍板是否手工调分）。

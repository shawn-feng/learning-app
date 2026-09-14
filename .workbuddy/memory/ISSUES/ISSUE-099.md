# ISSUE-099 · 珊珊 life plan 完成状态不更新：daily 已写但 plan_outcome=unknown / done 写进了 raw 正文而非结构化字段

- **类型**：bug（数据链路 + 设计缺口）
- **优先级**：🟡 → ✅ 已解决（2026-09-14，F1~F3 + prompt 加固全部实施；F4 维持现状待家长反馈）
- **记录时间**：2026-09-14
- **报告人/场景**：珊珊（childId `1f050a7f-…`）会话中调用 `summarize_conversation` 完成汇总并写入 daily，但对应的生活计划「洗两双袜子」完成状态始终未更新（仍 `pending`）。

## 现象（实测数据，库：`server/data/kb/86a84278-…/1f050a7f-….sqlite`）

- `life_plans`：`id=343e953a-dece-4915-84ce-9c583d35023e`，标题「洗两双袜子」，creator=child，status=**pending**（未完成判定）。
- `daily_entries` 2026-09-14「生活」区块有**两条**相关记录：

  | title | plan_id 列 | plan_outcome 列 | raw 正文关键信息 |
  |---|---|---|---|
  | 洗两双袜子（孩子自定加分项） | `343e953a-…`（✅正确） | **`unknown`** | "孩子主动提出创建计划…后续一直在学习论语和测试工具，**未提及是否实际完成了洗袜子**" |
  | 洗袜子 | **``（空）** | **``（空）** | 含 `- planId：343e953a-…` / `- planOutcome：done` 两行，且写"**完成了洗两双袜子的任务**" |

- 完成判定查询（`worker/plan-domain.ts` 生活域）只认 `plan_id!='' AND plan_outcome='done'` → 两条都不命中 → `life_plans` 永不被翻成 `done`。

## 根因（4 层）

- **RC1** · AI 把 `planId`/`planOutcome` 写进 raw 正文而非 kb_insert 结构化字段（`insertMany` 只读条目参数，从不解析正文）。
- **RC2** · `unknown` 是死路：`applySignals` 只认 done；unknown 无收敛/人工覆盖，到期被 `expireAndCarry` 翻 `missed`（孩子白做丢分）。
- **RC3** · 同计划出现「unknown + 残缺 done」两行冲突（标题不同都插入成功，done 行结构化列为空被判废）。
- **RC4** · 「家长 agent 操作完成」的设计意图未实现：`parent_life_plan_update` 白名单只有 delete/reschedule/rename，家长也标不了完成。

## 修复（2026-09-14 实施）

1. **F1 · `parent_life_plan_update` 新增 `complete` 动作**（`server/src/agent/parent-plans.ts`）：家长 agent 一句话可把 pending/missed 的生活计划直标 `status='done'`（result=「生活完成（家长确认）」）；已是 done 幂等返回；missed 补标时提示「积分结算一次性、历史流水不追改」。落实「完成判定走今日汇总**或**家长 agent 操作」的设计裁定。
2. **F2 · `applySignals` 生活域 raw 兜底回捞**（`server/src/worker/plan-domain.ts`）：判定前扫描 raw 含 planId/planOutcome 的 daily 行，用 `plan_?id` / `plan_?outcome` 正则解析出结构化值并**补写回列**（幂等：仅与现值不一致时更新）——既防 AI 退化，又自动治愈存量脏数据。⚠️ `daily_entries` 主键是复合键 `(date, block, title)`、无 id 列（实测踩过）。
3. **F3 · `insertMany` 入库兜底 + 去重**（`server/src/routes/db.ts`）：
   - 结构化字段缺失时从 content 用同款正则回捞 planId/planOutcome（只补缺失，不覆盖显式传参）——防新脏数据入库；
   - 同 `plan_id` + 同日已有行时合并而非新建：新条目 outcome=done 且旧行未 done → 升级旧行并把新正文附加到旧 raw（保叙事）；其余跳过——防「unknown + 残缺 done」双行。
4. **Prompt 加固**（`packages/agent-core/src/prompts/recording-prompt.ts` §8）：明确「planId/planOutcome 只能作为 kb_insert 参数字段，严禁写进 content 正文（写进正文系统读不到）」。

**F4（unknown 收敛）维持现状**：unknown 到期仍判 missed——自动放行会被钻空子（孩子没做、AI 说不清 → 白拿分）；now 有 F1 家长兜底 + F2/F3 信号捕获，误伤面已大幅缩小。若实测仍有误伤再议轻量确认入口。

## 验证（2026-09-14，真实数据端到端）

- 一次性脚本对珊珊孩子库跑真实 `runPlanStat`：
  - before：plan=`pending`；daily 两行（unknown 列正确行 + raw-only done 行）；
  - after：`signals=1`；「洗袜子」行结构化列被回捞补齐（plan_id=`343e953a-…`、outcome=`done`）；**「洗两双袜子」plan → `done`（生活完成（记录判定））** ✅；
  - `missed=0 / carried=0`（无副作用），`reward` 无变动（幂等）。
- server `tsc --noEmit` 通过；`dist/server.cjs` 已重建（v0.4.0）。

## 排查/修改入口（已改）

- 完成判定 + raw 兜底：`server/src/worker/plan-domain.ts`（applySignals 生活域）
- daily 写入兜底 + 去重：`server/src/routes/db.ts`（kb.daily_entries.insertMany）
- 家长完成入口：`server/src/agent/parent-plans.ts`（parent_life_plan_update 的 complete 动作）
- prompt 指令：`packages/agent-core/src/prompts/recording-prompt.ts` §8
- 实证数据：`server/data/kb/86a84278-c8ae-415e-8fbc-6140b1b7c88e/1f050a7f-df8a-45b0-925a-1ffe2aa35674.sqlite`

## 影响范围

- 所有孩子：凡 recording 把 life plan 判成 `unknown`、或把 done 退化成 raw 文本的情形，现在都能被兜底捕获或由家长一句话补标，不再卡 pending→missed。
- 珊珊「洗两双袜子」（`343e953a-…`）已在验证时治愈为 done。

## 状态

✅ 已解决（2026-09-14）。冒烟建议：重启本地服务端 → 家长对话里说「珊珊今天自己洗了两双袜子」→ 下一轮 recording 汇总后 life plan 应自动 done；再试「把洗袜子那条标成完成」走 complete 动作。

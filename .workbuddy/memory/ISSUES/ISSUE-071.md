## [ISSUE-071] 家长可撤销孩子某一条积分变动记录（流水备注名「撤销」，撤销后重新计算余额）

- **类型**：需求 / 积分域（家长审计与修正）
- **描述**：家长在「积分」页的流水列表里，对某一条积分变动记录（points_ledger 行）可主动**撤销**。要求：
  1. 撤销操作由家长发起（`operator='parent'`）；
  2. 撤销后写入一条新的流水记录，其**备注/reason 含「撤销」字样**（如「撤销：<原原因>」），作为审计痕迹，原记录保留不被物理删除；
  3. 撤销后该孩子的**积分余额重新计算**（余额真源回归流水，重算 `balance_after` 与 `points_balance` 缓存）。
  - 背景：当前「积分」页（`RewardPanel`）只展示流水、无撤销入口；家长审计修正现有能力仅覆盖计划（`plan:setStatus`→`/plans/status`，见 ipc-handlers.ts L1102），积分流水尚无家长修正通道。
- **影响范围**：家长端积分页流水交互 + 积分余额真源（points_ledger / points_balance）；被撤销记录若来自某日结算（source_table='reward_daily_stats'），是否需回滚当日 `reward_daily_stats.points_awarded` 快照需在实施时一并确认（见下方「待定」）。
- **排查/修改入口**（均「可直接执行」）：
  - 数据真源与模型：`DESIGN-reward-points-2026-09-10.md` §五
    - `points_ledger`（流水，唯一真源）：字段 `type/amount/balance_after/reason_code/reason/operator/source_id`；`reason_code` 已含 `'adjust'`，`operator` 已含 `'parent'`——撤销可复用 `type='adjust'`（或新增 `'revoke'`）、`operator='parent'`、`reason` 写「撤销：…」。
    - `points_balance`（缓存）：`balance = SUM(earn − deduct − redeem)`（§六.7）；撤销后需重算该行。
    - `reward_daily_stats.points_awarded`（当日结算快照）：撤销是否回滚待定。
  - 前端入口（撤销按钮 + 调用）：`src/components/RewardPanel.tsx`
    - 流水渲染在约 L313-324（`reward.ledger.map(...)` 每行 `<div key={l.id}>`）；在此每行加「撤销」按钮，调用新增 IPC（如 `window.api.rewardRevoke(childId, l.id)`）。
  - IPC 入口（参考既有范式新增）：`electron/lib/ipc-handlers.ts`
    - 现有 reward 组：`reward:get` / `reward:config:get` / `reward:config:set`（L1061-1101）；
    - 家长审计范式参考：`plan:setStatus` → `serverFetch('/plans/status', ...)`（L1102-1118）；
    - 新增 `reward:revoke`（childId, ledgerId, note?）→ 走 `serverFetch('/rewards/:childId/ledger/:id/revoke' 或等价)`。⚠️ 实施前需先 grep 确认服务端 `/rewards` 路由真实落点（当前 `cloud-service/app/` 仅 main/sync/auth/pages/license/database，未见 reward 路由；结算与 ledger 写入点可能在 worker/kb 本地或另一服务，先定位 `points_ledger`/`reward_daily_stats` 写入函数再动手）。
  - 子端展示（撤销后余额同步）：`src/components/TodoModal.tsx` 的「我的积分」段（L378-440，`reward.ledger` / `reward.balance`）跟随刷新即可，无需改逻辑。
- **撤销语义（建议，供实施参考）**：
  - 写新流水：`type='adjust'`、`amount=−原记录.amount`（方向取反）、`reason='撤销：' + 原reason`、`operator='parent'`、`source_id=原记录.id`（指向被撤销记录，便于追溯）、`balance_after` 重算；
  - 重算 `points_balance` = `SUM(earn − deduct − redeem − 撤销)`（用流水 SUM 重推，保证真源一致）；
  - 幂等/防误撤：撤销本身不可逆或需二次确认（家长端二次确认弹窗），避免误删积分痕迹。
- **待定（实施前需用户拍板）**：
  1. 撤销是否要回滚对应 `reward_daily_stats.points_awarded`（当日结算快照）——若回滚，重跑结算需避免重复发分（受 ledger 唯一索引 `ux_ledger_once` 保护，但快照需重算）；
  2. 撤销入口是否对全部 `reason_code` 开放（含 redeem 兑换、adjust 手工调整），还是仅限系统结算类（todo_award/todo_deduct/exam_award/exam_deduct/optional）；
  3. 是否允许撤销「撤销」本身（防连锁）。
- **优先级**：中（清晰、范围可控的家长审计增强；数据模型已预留 operator/reason_code，改动量小）
- **记录时间**：2026-09-11

# ISSUE-129 App 内 token 使用记录：按日期 × 会话展示（重建服务端记录链路）

- **类型**：需求 / 可观测性
- **记录时间**：2026-09-21
- **状态**：✅ 已实施并部署 201（服务端 0.5.4，2026-09-22 07:07；首次查询回填 1179 行/26 会话文件）。客户端 UI 随下个客户端包发布

## 需求

家长端要能直观查看 token 消耗：**按日期、按会话**两个维度，例如「家长 agent，9 月 21 日，会话 ID xxxx：输入 token / 缓存 token / 输出 token / totalTokens / cost」。后台任务（scheduler 的 recording / 考核判分等 ephemeral 会话）目前烧 token 完全不可见，一并纳入。

## 现状（2026-09-21 排查）

- **客户端旧统计已断**：`electron/lib/token-stats.ts`（ISSUE-010）设计完整（每轮真实 usage + 估算增量、按模型汇总），但 agent 上移服务端后 `logRound` **已无任何调用点**（写入链路死）；读侧 IPC `token:summary` / `token:log`（ipc-handlers.ts:1592/1600、preload.ts:140）仍在但 **renderer 无任何组件消费**。展示不直观是历史印象，当前实际是「无功能」。
- **服务端零记录，但数据源头全在**：SDK 每条 assistant 消息都带完整 usage 随会话 jsonl 落盘。实测样例（201 家长会话 2026-09-18）：
  ```json
  {"ts":"2026-09-18T09:10:10.882Z","model":"mimo-v2.5",
   "usage":{"input":12906,"output":245,"cacheRead":192,"cacheWrite":0,
            "reasoning":121,"totalTokens":13343,
            "cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},
   "stopReason":"stop"}
  ```
  **历史会话（9 月初至今）全部可回填统计**。

## 口径定案（用户 2026-09-21 拍板）

- **按模型返回字段原样输出，不做事后对账/换算**：`input` / `cacheRead` / `cacheWrite` / `output` / `reasoning` / `totalTokens` / `cost` 直传记录。
- **每行记录模型名**（provider/modelId，如 mimo-v2.5）——不同模型口径差异靠模型名区分，不做全局归一。
- **不做**本地 system prompt / 工具 token 归因估算（原方案的「固定开销拆分」放弃，保持简单）。
- 已知边界（接受，不处理）：`input` 与 `cacheRead` 的包含关系各家 API 可能不同，按原样展示，加总口径即原样加总；token-plan 包月模式下 `cost` 全 0——**展示主显 token 数，cost 列允许为 0**。

## 方案

1. **存储**：`server.sqlite` 新表 `token_usage`，一行 = 一条 assistant 消息：
   `id, date(本地), ts, scope(parent|child|scene|scheduler), parent_id, child_id, slot, session_file, entry_id, model, stop_reason, input, cache_read, cache_write, output, reasoning, total_tokens, cost`
   - `scope + child_id + slot` 支撑「家长 agent / 孩子 agent / 场景 / 后台任务」渠道维度；`date + session_file` 支撑日期 × 会话两个展示维度。
2. **写入**（推荐 B）：
   - **A. 事件挂钩**：`attachStream` 的 `message_end` 抽 usage 写库（ISSUE-126 已在同位置接 stopReason），实时但重启期间丢轮次需补偿；
   - **B. 会话文件扫描器（推荐）**：扫 `agent-sessions/<pid>/<slot>/*.jsonl`，按 `(session_file, entry_id)` 幂等 upsert。零侵入、**一次性回填全部历史**、服务重启不丢；查询频率低，扫描成本可忽略。
3. **查询 API**：`GET /api/v1/token-usage?date=&scope=&childId=&groupBy=day|session`（家长鉴权），聚合为单表 SQL。
4. **客户端展示（家长设置页）**两级视图：
   - **按日**：每行 = 日期 × 渠道：轮数、输入、缓存读、缓存写、输出（含 reasoning 小字）、totalTokens、cost；
   - **点开某日** → 会话列表：会话 ID（截断 + 可复制）、类型、模型、轮数、各字段；
5. **清理**：删除客户端 token-stats 写入逻辑与死 IPC（token:summary / token:log），避免误以为仍在收集。

## 优先级

中（纯可观测性，不影响功能；数据源随会话文件持续存在，可随时回填，无紧迫性）

## 关联

- ISSUE-010（旧客户端 token 统计，本 issue 取代其记录职责）
- ISSUE-126（attachStream message_end 的 stopReason 处理，方案 A 的挂钩点）

---

## 实施记录（2026-09-21）

- **服务端**：`server.sqlite` 新表 `token_usage`（一行=一条 assistant 消息，主键 `parent_id/session_file/entry_id`）+ 游标表 `token_usage_files`；扫描器 `db/token-usage.ts` `scanTokenUsageIntoDb`（增量游标 + INSERT OR REPLACE 幂等，slot→scope 归属：`parent*`→parent、`<cid>-main`→child、`-scene`→scene、`-course-*`→course，未知 slot 归 child/空 childId 兜底）；查询 `queryTokenUsageDays`（日期×渠道）/ `queryTokenUsageSessions`（某天按会话，models=GROUP_CONCAT 支持热切换多模型）/ `listTokenUsageDates`。
- **API**（routes/token-usage.ts，家长 JWT，读时先增量扫描）：`GET /token-usage/days|sessions|dates`，index.ts 已挂。
- **客户端**：`preload.tokenUsageDays/tokenUsageSessions` + IPC `tokenUsage:days|sessions`（serverFetch 透传）；web shim `sessionsDomain` 同名方法；`TokenStatsPanel` 重写为两级视图（日期分组头带当日合计 → 渠道行；点日期展开会话明细：短 ID/模型/时段/各字段，费用 0 显示「-」）。**旧死代码删除**：`electron/lib/token-stats.ts`、`token:summary`/`token:log` IPC、`getTokenSummary/getTokenList` preload 方法。
- **验证**：服务端 `tsc --noEmit` 0 错；新增 `test/issue129-token-usage.test.ts` **3/3 PASS**（入库口径/游标增量/半行不推进/slot 归属/多模型聚合）；全量 vitest 376 通过（15 失败均为既有测试债 ISSUE-022，与本改动无关）；客户端 `npm run build` 通过、web `npm run build` 通过；**真实数据端到端冒烟**：临时数据目录起源码服务 → 签家长 JWT 打三个端点，历史会话回填 769 行，家长渠道 09-19 一天 42 轮 input 93 万/缓存读 1006 万/合计 1100 万 token，09-21 孩子主会话 13 轮 23 万 token，明细含模型/时段。
- **文档**：技术实现文档新增 §9.5、§15 表清单补 token_usage/token_usage_files。
- **部署（2026-09-22）**：0.5.4 上 201（`tmp/deploy/deploy_server_054.py` + `deploy_054.sh`，备份 `deploy-0.5.4-20260922-0707/`）；探针 `probe_054_token.sh` 触发首次回填 1179 行/26 文件，09-21 家长助手 184 轮 1962 万 tok、珊珊 80 轮 295 万、闻闻 65 轮 121 万；journal 0 错误。**遗留**：客户端 UI 随下个客户端包发布（旧包 TokenStatsPanel 仍调死 IPC，显示为空但不报错）；scheduler/考核 ephemeral 会话不落盘扫不到（已知边界，后续可挂事件钩子）。

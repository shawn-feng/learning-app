## [ISSUE-022] 测试债务：9 个测试文件未随 SPLIT 迁移更新，全量 vitest 稳定失败 39 例

- **类型**：测试 / 架构迁移遗留
- **描述**：SPLIT 拆分后（2026-08-27 起），一批测试仍按旧架构（本地 kb.sqlite / 全局 scheduler 配置 / 本地 agent SQLite / 同步 async 化前）编写，导致全量 `vitest run`（需 127.0.0.1:8788 服务端运行）稳定失败 9 个文件 39 例（289 例中 250 过）。
- **失败清单与根因（2026-08-31 全量实测）**：
  1. `test/kb-tools.test.ts`（17 败）：kb_insert/kb_query/kb_update 走 `serverFetch` → 401「缺少 session token」（无登录 token）；需 `vi.mock server-client` 或预置 token。
  2. `test/kb-sqlite.test.ts`（6 败）：真实数据冒烟读本地 `data/children/1f050a7f/kb.sqlite`——SPLIT 后本地 kb 不再写，返回 0；应改读服务端 RPC 或删除该段。
  3. `test/auto-new-session.test.ts`（6 败）：scheduler-config 按家长分区后路径 `parents/_guest/scheduler-config.json` 父目录未建 → ENOENT；写配置前需 mkdir（getParentConfigDir 已自动建，测试直接写文件需补）。
  4. `test/sync.test.ts`（3 败）：`listChildren()` 未 await（async 化迁移遗漏）→ `children[0].childId` TypeError。
  5. `test/daily-summary.test.ts`（2 败）：buildProvidedContext 读本地 kb.sqlite（同 kb-sqlite 根因）。
  6. `test/scheduler-task-state.test.ts`（2 败）+ `test/event-poll-config.test.ts`（1 败）+ `test/archive-limit.test.ts`（1 败）：scheduler 配置 shape/家长分区路径迁移陈旧。
  7. `test/agents-sqlite.test.ts`（1 败）：saveAgentPrompt 已上云走 serverFetch 401（ISSUE-033 测试未 mock）。
- **入口**：各测试文件如上；统一思路=按 SPLIT 后真源（服务端 RPC / 家长分区配置路径）重写断言，需服务端 mock 或测试 token 的走 `vi.mock("server-client")`（参考 backup.test.ts 的 mock 模式）。
- **优先级**：低（均非业务回归，属技术债；修复前跑测试请先确认失败清单无新增项）
- **✅ 已修复（2026-08-31）**：9 个文件全部按 SPLIT 语义重写，全量 `vitest run` 31 文件 / 288 例 0 失败；两端 `tsc --noEmit` 0 错；`npm run build` 通过。修复明细：
  - `sync.test.ts`：三处 `childAuth.listChildren()` 补 `await`（async 化遗漏）。
  - `scheduler.ts saveSchedulerConfig`（真实缺陷）：写前 `fs.mkdirSync(path.dirname(p), {recursive:true})`——未登录 `_guest` 目录不建导致 ENOENT。
  - `pi-runtime.ts setProviderApiKey`（真实缺陷，同款）：写 `parents/_guest/auth.json` 前 mkdir（qwen-deepseek-models.test.ts 暴露）。
  - `custom-tools.ts kb_query progress`（真实缺陷）：服务端 `kb.courses.list` 返回 snake_case（`review_count` 等）未映射为 CourseItem camelCase → 复习次数/首次学习等字段丢失；补显式字段映射（learning-summary.ts 早已正确，仅 custom-tools 遗漏）。
  - `scheduler-task-state.test.ts`：断言改 3 键（session-reset 已删）。
  - `archive-limit.test.ts`：去掉废弃 `sessionReset` 字段/断言。
  - `auto-new-session.test.ts`：helper 写前 mkdir。
  - `daily-summary.test.ts`：`buildProvidedContext` 补 `await`；「种子库」用例改真实孩子（mock config + writeTestLicense + 服务端断言）。
  - `kb-tools.test.ts`：mock config + writeTestLicense；写测试每次 `crypto.randomUUID()` 注册全新测试 child（`registerTestChild`）隔离。
  - `kb-sqlite.test.ts`：「真实数据冒烟」改走服务端 dbQuery RPC。
  - `agents-sqlite.test.ts`：mock config + writeTestLicense + registerTestChild（随机 UUID）；saveAgentPrompt 补 await。
  - 注：`event-poll-config.test.ts` 无需改（scheduler.ts mkdir 修复覆盖）。
- **记录时间**：2026-08-31

# ISSUE-126：qwen 额度用尽后切模型不生效 + 模型错误全程不可见（「永远等待模型返回」）

- **类型**：bug（两层叠加：模型绑定焊死 + 错误静默吞掉）
- **优先级**：P0（生产 201 上孩子聊天完全不可用，且无任何报错提示）
- **记录时间**：2026-09-21
- **来源**：201 现场排查（客户端发消息永远显示「等待模型返回…」、发送按钮不变终止按钮；qwen-tokenplan 周额度用尽，切 mimo 后依旧）。

## 现象

- 客户端（201 本机 / 200 / 104 均可复现）发消息：工作气泡永远停在「等待模型返回…（已等待 N 秒）」，发送按钮不变终止按钮（busy 被复位）。
- 服务端日志无任何模型报错；`POST /agent/:childId/prompt` 全部 200。
- 设置里 defaultModel 已是 `mimo-tokenplan/mimo-v2.5`（切换确实写进了服务端），但会话仍打 qwen-tokenplan。

## 根因（代码位置已核实，证据 = 201 会话 jsonl 第 73~79 行）

孩子会话每轮 assistant 消息：`content: []`、`stopReason: "error"`、`errorMessage: "429: Your token-plan 1-week quota has been exhausted... reset at 09-27 04:32 UTC"`、`provider: "qwen-tokenplan"`。

| # | 环节 | 位置 | 事实 |
|---|---|---|---|
| 1 | **模型绑定焊死（根因）** | `server/src/agent/session-registry.ts:242` `ensureEntry` | `entries.get(key)` 命中即返回；`pickWorkerModel` 只在条目首次创建时执行一次。之后改 `app_settings.defaultModel` 永不重读。时间线：会话条目 15:53:12 创建（绑 qwen-tokenplan）→ 用户 15:55 切 mimo（写入生效但无人在读）→ 16:46 周额度真正耗尽 → 全部 429。家长会话 `parent-registry.ts:219` 同模式 |
| 2 | **SDK 失败不抛错** | pi-coding-agent SDK | 模型 API 失败不 emit `error` 事件、不 throw，只记 `stopReason:"error"` + `errorMessage` 的空 assistant 消息，轮次正常 `agent_end` 结束 |
| 3 | **服务端不识别** | `session-registry.ts:437` / `parent-registry.ts:348` `attachStream` | `message_end` 分支不检查 `stopReason`，错误信息原样下发的空消息无人消费 |
| 4 | **客户端只收到 turn_end** | `electron/lib/server-agent-client.ts:636` → `src/pages/Learn.tsx:793` | `turn_end` → `pi:reply_end` → `handleReplyEnd` 只复位 busy（按钮变回「发送」），**不清工作气泡** → 气泡永远「等待模型返回」。`handleSceneReplyEnd`（Learn.tsx:884）与 `ParentChatPanel.tsx:181` 同缺口 |

⇒ 全链路（SDK → 服务端 → Electron 桥 → 渲染层）没有任何一处消费 `stopReason/errorMessage`，429 彻底静默。

## 修复（2026-09-21 实施）

1. **A · 模型热切换（根因）**：新增 `server/src/agent/model-sync.ts`。`submitChildPrompt` / `submitParentPrompt` 每轮提交前用最新 `app_settings` 重解析默认模型，与会话绑定模型不一致 → SDK `session.setModel()` **原地热切换**（历史/上下文/工具全保留，不销毁重建；setModel 自带 key 校验）。切换失败（如新 provider 没配 key）→ 本轮不发送，返回明确错误给前端。
2. **B · 错误可见化**：两处 `attachStream` 的 `message_end` 分支检查 `stopReason === "error"` → 不再下发空消息，改发 `error` 事件（`errorMessage` 经 `friendlyModelError` 翻译成用户能懂的提示，如 429 额度用尽 + 重置日期）。客户端既有 `pi:reply_error` 链路自动弹 ⚠️。
3. **C · 客户端兜底**：`Learn.tsx handleReplyEnd` / `handleSceneReplyEnd` / `ParentChatPanel onPiReplyEnd`：轮次结束但工作气泡没有任何文本/工具 → 置 `working:false` 并显示「本轮没有收到回复…」提示，不再永久转圈。

## 设计决策

- **不销毁重建**：SDK `AgentSession.setModel()`（agent-session.js:1197）就是会话内热切换——换模型引用、追加 `model_change` 记录、按新模型 clamp thinking level；历史保留。销毁重建只用于工具表变化（caps 变化，现状已有）。
- **key 缓存无忧**：凭据存储带文件修订检测（mtime 变化自动重读），且 `getWorkerRuntime` 每次都重写临时 auth 文件，刚配的新 key 热切换后立即可用。
- **visionModel/programmingModel 不在本次范围**：本次只热切换 `defaultModel`（主对话链路）。

## 验证建议

- 服务端跑着、会话已存在的情况下改 defaultModel → 下一条消息即用新模型（会话 jsonl 出现 `model_change`）；
- 切到没配 key 的 provider → 前端弹「切换默认模型失败：No API key for …」而非转圈；
- 模型额度用尽/401 → 前端气泡显示具体原因（429 重置日期等）；
- 极端情况（error 事件丢失）→ 客户端兜底文案出现，按钮/气泡不再卡死。

## 实施与验证结果（2026-09-21）

- 改动文件：`server/src/agent/model-sync.ts`（新增）、`session-registry.ts`、`parent-registry.ts`、`src/pages/Learn.tsx`（主/场景 reply_end 兜底）、`src/components/ParentChatPanel.tsx`、`test/issue126-model-sync.test.ts`（新增）。
- 验证：server `tsc --noEmit` 0 错 + `build.mjs` v0.5.3（同时含 ISSUE-124 改动）；客户端 `npm run build` 通过；`test/server-agent-client.test.ts` 24/24、`test/issue126-model-sync.test.ts` 8/8。`english-course-session.test.ts` 失败为历史遗留（自身 import 解析问题，非本次引入）。
- 部署状态：**已部署 201（2026-09-21 18:24，服务端 0.5.3，含 ISSUE-124+126）**——版本/健康/包内标记/只读探活全过，备份 `server.cjs.bak-20260921-1824` + `data/backups/deploy-0.5.3-20260921-1824/`。旧客户端即可获得「切模型即时生效 + 模型错误可见」；C 兜底需随下次客户端打包发布（0.1.20 包不含）。端到端确认方式：孩子发一条消息 → 会话 jsonl 应出现 `model_change`（qwen-tokenplan → mimo-tokenplan/mimo-v2.5），服务端日志出现「默认模型变更…原地热切换」或新建会话直接绑 mimo。

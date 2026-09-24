# [ISSUE-147] 「用工具去调另一个 agent（编程 agent）」是不是 pi 里的最优范式？——pi 委派原语盘点与方案选型

- **类型**：架构评估（非 bug；评估现有「工具内嵌套会话」范式是否有更优替代）
- **优先级**：**中高**（① 决定 ISSUE-146 的最终修法；② 牵动「一次生成 5 课资料」等并行产品能力）
- **状态**：✅ 评估完成（2026-09-24；依据 = pi-coding-agent 0.84.1 源码 + 官方 docs/examples **逐条核实**）；**方案待拍板，未改代码**
- **记录时间**：2026-09-24
- **标签**：`pi原语` `subagent` `委派范式` `编程agent` `嵌套会话` `事件桥接` `onUpdate` `skills` `SDK评估`
- **关联**：**ISSUE-146**（240s 误杀 = 同一机制的下游症状，本 issue 给出它的最终修法）、ISSUE-145（客户端送达链路）、ISSUE-131（工作区归并）、ISSUE-144（家长场景 skill，可复用的外置化先例）

---

## 一、问题（用户原话）

> 「再评估一下，网页工具其实调用的是一个编程 agent，调用另一个 agent，pi 是否有更好的方案，比用工具好的方案。」

---

## 二、结论先行（5 条）

1. **pi 没有内置的「agent 委派」原语，而且是官方刻意不做**——`README.md:500` 原文：
   > **No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with **[extensions]**, or install a package that does it your way.

   `docs/usage.md:303` 同口径（intentionally does not include … sub-agents …）。
2. **但 pi 官方给的参考实现 `examples/extensions/subagent/` 本身就是一个「工具」**（`docs/extensions.md:2970`：``| `subagent/` | Spawn sub-agents | `registerTool`, `exec` |``）。
   ⇒ **「用工具调子 agent」不是错路，它就是 pi 的官方范式。** 不存在一个"官方更高层的替代通道"。
3. 本项目与官方实现的差距**不在范式，在四个具体机制**：**子会话事件订阅 / 进度回报 / abort 传播 / 定义外置**（详见 §四）。
   这四个全缺，才把"工具调 agent"退化成**黑盒同步调用**，进而引出 ISSUE-146 的 240s 误杀。
4. **换成官方那种「子进程 spawn」形态对本项目不划算**（理由见 §五·路线 A）：服务端已是 esbuild 单文件 `server/dist/server.cjs`（`docs/PACKAGING.md:87`），pi 包已被内联，spawn 需要单独分发 pi CLI + node_modules；且本项目模型 runtime 是**运行时从家长 `app_settings` 动态读**的，跨进程还要重建凭据链。
5. **真正"比工具更好"的一步不是换通道，而是让工具不再是唯一通道**：把编程会话**提升为 hub 上的一等公民**（独立 key、可订阅、可回放、可中止），把它从"工具的黑盒内部"变成"可观察的后台任务"。这是本项目**比官方 subagent 示例还能做得更好**的地方（官方受限于 TUI 单会话，我们已经有 SSE hub）。

---

## 三、pi 原语盘点（逐条核实，附出处）

| # | 原语 | 出处（已核实） | 能力 | 本项目用了？ |
|---|---|---|---|---|
| 1 | `AgentSession.subscribe(listener) → unsubscribe` | `dist/core/agent-session.d.ts:276` | 会话事件**原生订阅**（text/thinking/tool/agent_end/error） | ✅ **主会话用了**（`parent-registry.ts:240` / `session-registry.ts:414` 的 `attachStream`）；❌ **编程会话没用** |
| 2 | 工具 `execute(id, params, signal, onUpdate)` 第 4 参 | SDK；`agent-session.js` 把它转成 `tool_execution_update` 事件 | 工具**回报进度**的官方通道 | ❌ **全仓 0 处**（唯一命中 `display-tool.ts:47` 是未使用的形参 `_onUpdate`） |
| 3 | `session.steer()` / `followUp()` / `abort()` | `agent-session.d.ts:371 / :374 / :431` | 运行中**干预 / 追问 / 中止** | ❌ 未用（abort 也不从父层传播到嵌套会话） |
| 4 | 官方 `examples/extensions/subagent/`（1015 行） | 见 §四 | spawn `pi --mode json -p --no-session` + JSONL 流解析 + onUpdate + abort kill + **parallel(8 任务/4 并发) / chain(`{previous}`)** | ❌ 未参考（本项目自研了等价但缺机制的实现） |
| 5 | agent 定义外置（markdown + frontmatter `name/description/tools/model`） | `examples/extensions/subagent/README.md` | 子 agent 的**模型与工具集可配置**、可版本化 | ❌ 硬编码在 `buildProgrammingPrompt()`（26 行）+ 代码里写死 `["read","write","edit"]` |
| 6 | pi 原生 **Skills**（Agent Skills 标准，`~/.pi/agent/skills/`，`--no-skills` 关闭） | `docs/skills.md` | 把领域知识做成**按需加载的能力包** | ❌ 编程会话显式 `noSkills: true`，知识硬编码进 prompt。⚠️ **本项目不启用 SDK 原生 Skills，见 §六·P1 与 ISSUE-144 §四·2**；此处"外置"指**沿用本项目自建的那套**（TS 常量正文 + 自建索引 + `load_skill`） |
| 7 | Extensions（`registerTool` / 事件钩子） | `docs/extensions.md` | 自定义工具与编排 | ✅ 已用（`learningGuardExtension`） |
| 8 | RPC 模式（`runRpcMode` / `RpcClient`） | `docs/rpc.md` | 跨进程控制协议（给外部宿主控制 pi 用） | ❌ 未用 |
| 9 | `AgentSessionRuntime`（`/new` `/resume` `/fork`） | `dist/core/agent-session-runtime.d.ts:44,87` | **会话分叉**（不是子 agent 委派） | ❌ 未用 |
| 10 | `createAgentSession(options)` 全部选项 | `dist/core/sdk.d.ts:10-54` | 只有 cwd/model/tools/customTools/sessionManager… **无任何 subagent 字段** | — |

**⇒ 关键结论：SDK 里不存在"更高级的委派原语"（第 9、10 条已排除）。能用的零件就是 1~5，其中最省事、最贴本项目形态的是 #1 + #2。**

---

## 四、官方 subagent vs 本项目（逐项对比）

| 能力 | 官方 `examples/extensions/subagent/index.ts` | 本项目 `programming-agent.ts` |
|---|---|---|
| 子 agent 隔离 | **独立 OS 进程**（`spawn`，:335 `stdio:["ignore","pipe","pipe"]`） | 同进程独立 `AgentSession`（:103 `createAgentSession`） |
| 子 agent 事件 | **逐行解析 stdout JSONL**（:379 `proc.stdout.on("data")` → `processLine`），累积 `message_end`/`tool_result_end` | ❌ **完全不订阅**（全文无 `subscribe`）→ 事件 100% 丢弃 |
| 进度回报 | ✅ `emitUpdate()`（:314-317）每次事件后调 `onUpdate({content,details})` → `tool_execution_update` | ❌ 无 |
| 中止传播 | ✅ `signal` → `killProc`（:400-408，SIGTERM 后 SIGKILL） | ❌ 父层 abort 不传到嵌套会话 |
| 期间父层有无活动 | 有（onUpdate 持续刷新）→ **不会被 240s 误杀** | ❌ 只有 `tool_start` 一个事件 → **必被 240s 误杀**（ISSUE-146 实测 5~6 次） |
| 定义/模型 | markdown frontmatter（`model: claude-haiku-4-5`、`tools: read,grep`…） | 硬编码 prompt + `["read","write","edit"]` + 从 DB 读 `programmingModel` |
| 编排能力 | **parallel**（最多 8 任务/4 并发）、**chain**（`{previous}` 串接）、workflow prompts | ❌ 单次串行，一次只能做一份 |
| 失败语义 | exitCode / `stopReason:"error"\|"aborted"` / stderr 回传 | 只校验"文件是否存在且 ≥100B"（:229） |

**一句话**：本项目把"事件驱动 + 进度可见 + 可中止"的委派，退化成了"发起 + 死等 + 事后校验文件"。
**这不是"工具"这个通道的错，是实现没把工具的 `signal`/`onUpdate` 这两个形参用起来。**

---

## 五、三条候选路线评估

### 路线 A：换成官方「子进程 spawn」形态 —— ❌ 不推荐（本项目）

| 项 | 评估 |
|---|---|
| 收益 | 真进程隔离（子 agent OOM/崩不影响 server）；abort 可 kill；天然支持 parallel |
| 成本 | ① 打包：`server.cjs` 是 esbuild **单文件**，pi 的 dist 已内联 → spawn 需**单独分发 pi CLI + 依赖**到 201；② 模型/凭据：本项目 `getModel(provider,modelId)` 来自 `getWorkerRuntime(...)`（家长 `app_settings` 动态读），子进程要重建 `.pi` 配置与 key 传递链；③ 启动开销：每份资料多一次 node 冷启动；④ Windows/Linux 路径与 `process.execPath` 差异 |
| 结论 | **性价比不成立**。隔离性收益对本项目（同一可信服务端内、同一家长的会话）价值有限，成本却是部署级的。 |

### 路线 B：进程内补齐四机制（subscribe + onUpdate + abort + 定义外置） —— ✅ **推荐**

- 零打包影响（纯 `server/src` 内改动，走既有 esbuild）；
- 复用本项目**已经验证过的** `attachStream` 样板（`parent-registry.ts:240`）；
- 一举解决 ISSUE-146 的 P0-a + P0-b（进度刷新 → 240s 不再误判；家长能看到"正在写代码…"）；
- 是官方机制在 in-process 下的**等价物**，不引入第二套范式。

### 路线 C：取消第二个 agent（把 HTML 能力做成 skill，单个 agent 直接用 write 工具） —— ⚠️ 不建议

- 本项目分离出编程 agent 的**三个理由仍然成立**：① **模型分离**（家长用便宜模型，HTML 用强模型，`programmingModel` 是独立设置项）；② **上下文隔离**（几千行 HTML 进主会话 → 触发压缩、污染家长对话）；③ **独立 system prompt**（PiBridge 协议全文很长）。
- 但**其中第③点有更好的承载方式** → 见 §六·P1（把 prompt 外置成**本项目自建技能**，⚠️ 不是启用 SDK 原生 Skills）。

---

## 六、推荐方案（分阶段，待拍板）

### P0 —— 让编程会话"可观察"（同时是 ISSUE-146 的最终修法）

> ✅ **已于 2026-09-24 实施并随 0.5.10 部署 201**（P0 四机制补齐部分，见 ISSUE-146 部署记录），实施记录见本节末。
> 与原方案的两处差异（实施时发现更简单且更可靠的路径）：
> ① **工具执行状态不需要编程工具自己上报** —— 父会话的 `tool_execution_start/end` 本来就会到
>    `attachStream`，在那里维护计数即可（比让嵌套工具自报更可靠，也覆盖所有工具）；
> ② 于是编程工具只承担两件事：**进度回报**（`onUpdate`）与**中止传播**（`signal`）。

1. **给嵌套会话接订阅**：`getProgrammingSession()` 拿到 `session` 后 `session.subscribe(...)`（照抄 `attachStream` 的 switch 结构）。
2. **事件去向要分清（重要，别踩坑）**：
   - **不要**把子会话的 `text_delta` / `message_end` 直接 publish 到**父 key**——会污染父层轮内文本缓冲
     （`web/src/shim/core/sse.ts` 的 `turnTextBuffers`），把编程 agent 的内部正文混进家长正常回复。
   - 正确做法：① 子会话事件 → **刷新父会话活跃时间**（直接消灭 240s 误杀）；
     ② 节流后经 `onUpdate` 回报 → 自动变成 `tool_execution_update` → 父层 activity 刷新 + 前端显示进度；
     ③ （P2）另推**独立 key**（如 `parent:<pid>:programming`）供客户端单独订阅。
3. **abort 传播**：`createProgrammingTool` 的 `execute` 接收 `signal`，`signal.addEventListener("abort", () => session.abort())`（与官方 killProc 等价）。
4. **错误文案与硬上限**（ISSUE-146 的 P0-a）：watchdog 见 `runningTools > 0` 即跳过；工具轮另设 30min 硬上限，文案改成「工具 X 执行超时」而不是"模型服务无响应"。

#### P0 实施记录（2026-09-24）

**新增** `server/src/agent/session-activity.ts`：共享活跃度登记处
—— `lastActivityAt` / `runningTools` 计数 / `SESSION_IDLE_TIMEOUT_MS(240s)` / `TOOL_EXEC_TIMEOUT_MS(30min)` / `toolProgressText()`。

| # | 改动 | 文件 |
|---|---|---|
| 1 | attachStream 在 `tool_execution_start/end` 维护工具计数；新增 `tool_execution_update` → publish `tool_progress` | `parent-registry.ts` / `session-registry.ts` |
| 2 | watchdog 判据分流：`runningToolCount > 0` → 30min 硬上限 + 「工具「X」执行超过 30 分钟仍未完成」；无工具 → 原 240s「模型服务超过 240 秒无响应」 | 同上 |
| 3 | 一轮 `finally` 里 `clearActivity(key)`（防异常路径计数泄漏 → 下一轮永不判挂死）；reset/dispose 同步清理 | 同上 |
| 4 | **顺带修 key 混用 bug**：孩子侧 `attachStream` 原来传的是 `streamKey(${pid}:${cid})`，而 watchdog 读 `keyOf(${pid}:${cid}:${kind})` ⇒ 活跃度永远刷不到，判据退化成「从提交起算的硬超时」，任何 >240s 的**正常**轮都被砍。现拆成 `attachStream(entry, sessionKey, streamKey)` | `session-registry.ts` |
| 5 | execute 接 `signal`（→ 嵌套会话 `session.abort()`）与 `onUpdate`（→ `tools.execution_update`）；子会话事件翻译成可读文案 + 15s 心跳（「生成中…（已 X 分钟）」）；节流 3s；`finally` 退订/清心跳（防订阅随 sessionKey 复用累积） | `programming-agent.ts` |
| 6 | 两端 `translateAgentEvent` 加 `tool_progress` → `pi:tool_progress`；`onPiToolProgress` 暴露（web shim / preload / 本地 ipc 转发）；`ToolCallState.progress` + 工作气泡标签与工具卡片显示 | `web/src/shim/core/sse.ts`、`electron/lib/server-agent-client.ts`、`domains/agents.ts`、`preload.ts`、`ipc-handlers.ts`、`ChatWindow.tsx`、`ParentChatPanel.tsx`、`Learn.tsx` |

**验收**：`server tsc --noEmit` **0 错**；新增守护测试 `test/issue146-longtool-watchdog.test.ts` **26/26**（行为级 6 + 文案 4 + 源码级 3×3 + 编程工具 5 + 客户端 4）；
**防假绿**已做：注入 3 处旧逻辑（`if (false)` 屏蔽工具分支 / `attachStream` 两参数 / execute 去掉 signal+onUpdate）→ **对应用例 3 条准确变红**，还原复绿；全量 `vitest run` 见 §七。
**未做**：P1（skill 化）、P2（并行/独立 hub key）、会话 LRU（均留待拍板）。

### P1 —— 把硬编码知识外置（低成本、高可维护性）

> ⚠️ **路径已由 ISSUE-144 定案：不要走「启用 SDK 自带 Agent Skills」。**（2026-09-24 用户指出此处与 ISSUE-144 冲突，已修正）
> ISSUE-144 §四·2 论证过不启用 SDK 原生 Skills 的四条理由：
> ① 它给的是**绝对路径** `<location>`，而本项目 `read` 拒绝绝对路径、`learning-guard` 又把 FS 限在会话 cwd ⇒ 模型拿到路径也读不到；
> ② 打开默认发现目录会扫 `~/.pi/agent/skills`、`~/.agents/skills` 与 **cwd 及其祖先目录**的 `.pi/skills`，
>   而 **cwd 是模型自己可写的地方 ⇒ 等于让模型给自己写指令**（安全红线）；
> ③ 家长覆盖层本来就要自建；④ 少依赖一层 SDK 语义（server 精确 0.84.1）。

- 编程 agent 现为 `noSkills: true`（`programming-agent.ts:99`）+ 26 行硬编码 `buildProgrammingPrompt()`（含 PiBridge 协议全文）。
- 正确做法 = **沿用本项目自建的那套技能机制**（`agent/skills/parent/*` 是现成先例）：
  **TS 常量正文 + 自建索引 + 自建 `load_skill`**，编程会话照此加一份「如何做一份儿童友好的自包含 HTML 资料 + PiBridge 协议」技能。
  收益：可版本化、可单独 review、可让家长覆盖（与本项目 ISSUE-144 的 skill override 思路一致）、新增子 agent（绘图/翻译）不必再写一段长 prompt。
- ⚠️ **本 P1 未实施；P0 不碰 skill。**
- 顺带：子 agent 的「模型 + 工具集」提到**配置层**（对齐官方 frontmatter 的 `model`/`tools` 的思路），而不是写死在代码里。

### P2 —— 编排与产品化（可选，价值明确）

- **并行生成**：官方支持 parallel（8 任务/4 并发）。本项目实测单份中位 **321.4s**（ISSUE-146 §3.2），家长说"做 5 课资料"目前是**串行 ~27 分钟且途中被砍**；并行后 ≈ 1/3 时间。这是"值得投入"的收益。
- **链式**：`{previous}` 占位符做"生成 → 自审 → 修订"。
- **独立 hub key**：编程会话事件推到 `parent:<pid>:programming`，前端可显示"正在写 lesson-03.html（已 3.2KB）"。

### 附带修（独立缺陷，顺手处理）

- **会话泄漏**：`programming-agent.ts:34` 的 `sessions` Map 按 `parentId:sessionKey` 常驻，
  **只在 `disposeProgrammingSessions()`（重启/测试）清理**；每份资料一个 `SessionManager.inMemory()` 会话永不释放。
  家长做 20 课资料 = 20 个常驻会话（含完整上下文）→ 长跑内存堆积。建议加**空闲 LRU 淘汰**（如 30 分钟无活动 + 上限 N 个）。

---

## 七、验收口径

1. **不再被误杀**：以 201 上 lesson-01~05 的时间事实为基线（工具轮 242~654s，ISSUE-146 §3.2），修复后这些轮**不得再出现 `判定挂死`**；
2. **进度可见**：家长端在生成期间能看到持续的活动/进度（不再是空白等 5~11 分钟）；
3. **兜底不丢**：人为让模型 API 真挂起 → 仍在阈值内正确中止，且文案准确；
4. **不污染父会话**：编程 agent 的内部正文**不得**出现在家长正常回复里（校验 `turnTextBuffers`）；
5. **中止可用**：家长点停止 → 嵌套会话一并中止（日志可见）；
6. `tsc --noEmit` 0 错 + 相邻回归零新增失败 + 服务端 bundle 构建通过。

---

## 八、依据清单（复查用，全部已核实）

**pi SDK 0.84.1（`server/node_modules/@earendil-works/pi-coding-agent/`）**
- `README.md:500`「No sub-agents…」；`:387`「Sub-agents and plan mode」能力说明
- `docs/usage.md:303`「intentionally does not include … sub-agents …」
- `docs/sdk.md:11`「Build custom tools that spawn sub-agents」
- `docs/extensions.md:2970` subagent 示例索引行
- `examples/extensions/subagent/README.md`（机制全文）、`index.ts:294-296`（args）、`:314-317`（emitUpdate）、`:330`、`:335`（spawn）、`:379`（stdout 解析）、`:400-408`（kill）
- `dist/core/agent-session.d.ts:276`（subscribe）、`:283`（dispose）、`:355`（prompt）、`:371/374`（steer/followUp）、`:431`（abort）
- `dist/core/agent-session-runtime.d.ts:44,87`（AgentSessionRuntime / fork）
- `dist/core/sdk.d.ts:10-54`（CreateAgentSessionOptions，无 subagent 字段）
- `docs/skills.md`（Skills 位置/加载/`--no-skills`）
- `docs/rpc.md`（RPC 模式）

**本项目**
- `server/src/agent/programming-agent.ts:34`（sessions Map）、`:99`（noSkills:true）、`:103-112`（createAgentSession）、`:110`（tools）、`:210,226`（嵌套会话 + await prompt）、`:229`（≥100B 校验）、`:260-307`（工具定义）
- `server/src/agent/parent-registry.ts:240-284`（attachStream 样板）、`:234`（240s 常量）、`:306-319`（watchdog）
- `server/src/agent/session-registry.ts:414`（attachStream 同款）
- `server/src/agent/display-tool.ts:47`（唯一 `_onUpdate`，未使用）
- `server/src/agent/tool-kit.ts`（项目 defineTool 包装）
- `docs/PACKAGING.md:87`（esbuild 单文件 server.cjs）、`:90`（pkg 废弃）
- `docs/技术实现文档-功能实现与数据流转-2026-09-13.md:46`（编程 agent 无独立 REST 入口）

---

## 九、一句话结论

**pi 没有"更好的内置方案"——官方明说不做 sub-agent，而其唯一参考实现（`subagent/` 扩展）本身就是一个"工具"。**
**所以正确的问题不是"换哪个通道"，而是"工具的两个形参（`signal`/`onUpdate`）和一个订阅（`subscribe`）为什么没用"。**
本项目已具备全部零件（`attachStream` 就是现成样板），**补齐 P0 即可同时修掉 ISSUE-146 的误杀与"黑洞 11 分钟"**；
P1 把硬编码知识换成 pi 原生 Skill，P2 再考虑并行编排与独立 hub key。

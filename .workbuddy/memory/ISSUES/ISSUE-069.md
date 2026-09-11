## [ISSUE-069] 自动化测试 app 客户端：用真实对话驱动孩子/家长 agent，断言其行为与工具调用是否符合预期（测试框架讨论）
- **类型**：架构 / 讨论（测试框架；当前未实施）
- **需求（用户原话）**：新增 issue，如何自动化的测试 app 客户端？使用真实的用户操作，例如正式的与孩子 agent 对话，然后分析 agent 行为是否符合预期，工具调用是否正确。
- **现状确认（已读真实代码，确定可行性与缺口）**：
  1. **已有测试基建**：`vitest.config.ts` + `test/**/*.test.ts`（约 38 个用例）。但**全部是模块级单测/集成测**——直接 import `electron/lib/child-auth`、`kb-sqlite`、`config` 等函数做断言（见 `test/functional.test.ts`：测 bcrypt、profile 结构、kb.sqlite 表、task-state.json 路径等）。**没有任何用例驱动 agent LLM 会话，也不断言工具调用序列/行为**。
  2. **数据隔离已就位**：`vitest.config.ts` 通过 `PI_TEST_DATA_DIR`（系统 tmp）把 `getDataDir()` 重定向到临时目录，且 `fileParallelism:false` 串行执行，避免互相污染。可直接复用。
  3. **会话事件可采集（关键，harness 可复用）**：主进程 `electron/lib/ipc-handlers.ts:2662` `attachSessionEvents(session, childId, win)` 通过 `session.subscribe((event)=>{...})` 监听 SDK 会话事件并转发到渲染层。事件契约（SDK → 应用）为：
     - `message_update`（含 `text_delta` / `thinking_delta`）
     - `tool_execution_start`：`{toolCallId, toolName, args}`
     - `tool_execution_end`：`{toolCallId, toolName, result, isError}`
     - `agent_end` / `message_end` / `error`
     → **这正是行为测试需要的 transcript**：工具名、入参、结果、是否报错、思考/回复文本都暴露了。测试 harness 只需复用同一套 `session.subscribe` 订阅，把事件收集到内存数组而非转发 webContents。
  4. **会话可 headless 创建**：`electron/lib/pi-session.ts:591` `createChildSession`（被并发保护的 `getChildSession` 包裹）只依赖 `getChildDir`/`getProfile`/`fetchCourseLessonRemote`（可离线降级），**不依赖 BrowserWindow**。测试中 `import` 后 `await getChildSession(childId)` 即可拿到 `AgentSession` 并 `session.subscribe()`。SDK 还提供 `session.waitForIdle()` / `isIdle`（见 `agent-session.js:1173`）作为「一轮结束」的可靠信号。
- **核心难点（必须讨论清楚，否则方案落地会卡）**：
  1. **真实 LLM = 非确定性 + 成本 + 网络**：「真实用户操作」天然意味着打真实模型。但同一 prompt 多次跑，工具调用顺序/措辞/是否触发某工具都可能不同 → 纯文本精确匹配必 flaky。断言必须落在**结构化不变量**上（「调了 X 工具」「参数 Y 满足谓词」「全程无 isError」「未调受限工具」），而非具体文案。
  2. **行为「是否符合预期」无法精确判等**：开放域对话质量需要 **LLM-as-judge**（用一个更强的模型按 rubric 给 transcript 打分，如「是否先用 kb_query 核对课程名」「是否对超纲问题正确拒绝」「语气是否适龄」）。这正好对应需求里的「分析 agent 行为是否符合预期」。
  3. **可重复/离线 CI 矛盾**：真实调用不能进日常 CI（贵、慢、偶发 429/网络）。需要把「真实」与「可重复断言」解耦成分层。
- **建议方案（Tier 分层 + harness + 断言 DSL）**：
  - **Tier 0 — 结构化回放（离线、确定、进 CI，推荐为主力）**：
    - 录制：用一次真实会话，把「LLM 请求→响应」流（或高层 transcript）落盘为夹具。
    - 回放：把模型调用替换为录制响应。**待验证注入点**：`agent-session.js:747` 附近 `this.agent.streamFunction` 是 SDK 的模型调用入口，若可在测试里覆写为「按录制流返回」，即实现确定性回放；否则退而在「工具输出」层 mock（工具真实跑、仅 LLM 文本回放）。**这是方案能否落地的关键待办**。
    - 断言：对回放出的 transcript 做结构化断言（见下）。
  - **Tier 1 — 真实冒烟（门控、真实 API、按需跑）**：少量用例用 `process.env.PI_LIVE_AGENT_TEST` 守卫，实际打真实模型（建议 cheap/fast 档，如 qwen3-vl-flash 之类），只断言**结构化不变量**（工具是否被正确调用、是否无错误、是否在合理步数内结束），不判文本。手动/定时触发，不进日常 CI。
  - **Tier 2 — LLM-as-judge（评估行为质量）**：对真实或回放 transcript，调用 judge 模型按 rubric 打分，输出「通过/不通过 + 理由」。直接服务「分析行为是否符合预期」。
  - **harness 核心（`test/agent-harness.ts`，新增）**：
    - `setupChild(profile?)` → `childAuth.addChild` + 返回 childId。
    - `openSession(childId, courseKey?)` → `getChildSession` + `subscribe(collector)`（复用 `attachSessionEvents` 的订阅契约，内存收集）。
    - `async turn(userText)` → `await session.prompt(text)` + `await session.waitForIdle()`；返回本轮 `transcript` 片段。
    - `teardown(childId)` → 清临时目录。
  - **断言 DSL（建议）**：`called('display_content')` / `calledWith('kb_query', {type:'progress', topic: T})` / `order([...])` / `notCalled('xxx')` / `allToolsSucceeded()`（无 isError）/ `judge(rubric)`。
- **修改入口**：
  - 新增 `test/agent-harness.ts`（harness + 订阅收集，复用 `ipc-handlers.ts:2662` 的事件契约；headless 用 `pi-session.ts:getChildSession`，不依赖 BrowserWindow）。
  - 新增 `test/behavior/*.test.ts`（真实/回放行为套件），沿用 `vitest.config.ts` 的 `PI_TEST_DATA_DIR` 隔离 + 串行。
  - `vitest.config.ts`：可加 `test/include` 区分 `behavior` 或 env 门控（Tier1 真实用例），保持 `fileParallelism:false`。
  - （待验证）`agent-session.js` 的 `streamFunction`/`_modelRuntime` 注入点 → 决定 Tier0 回放能否实现；若 SDK 不允许外部注入，需改在应用层 model provider 加「录制/回放」开关（查 `electron/lib` 下 model provider 封装）。
- **验证**：
  - 冒烟：写一条行为用例「孩子问『今天学什么』→ 期望 agent 调用 kb_query 取进度/当天计划，并最终 display_content 或口头引导，全程无工具 isError」。Tier0 回放应稳定通过；Tier1 真实跑应结构通过。
  - 回归：新增行为用例不破坏现有 38 个模块测试（数据隔离已保证）。
  - judge：对一条真实对话 transcript 跑 rubric，确认打分合理、能区分「符合/不符合预期」。
- **优先级**：中（质量基础设施；不影响线上功能，但「真实对话行为可自动化验证」是后续迭代（ISSUE-054/062/060 等）能否安全验证的关键能力；且直接回应「agent 行为是否正确」的回归诉求）
- **记录时间**：2026-09-10
- **状态**：讨论/待实施（仅记录，未落地；关键待办：验证 SDK 模型回放注入点）

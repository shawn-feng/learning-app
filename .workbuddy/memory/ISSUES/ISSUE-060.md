## [ISSUE-060] 学习资料 iframe ↔ 主页面通讯：开放「作者可控」协议（特定操作才通讯 + 接口契约）
- **类型**：需求 / 架构增强（在学习资料桥 `page-bridge` 现有「自动全量采集」之外，增加「作者按协议主动通讯」能力）
- **需求（用户原话）**：左侧 iframe 与主页面的通讯能否定制——iframe 里执行了「特定操作」才有通讯；能否采用一种接口协议，制作 html 时即可按协议设计「要传递的数据 + 时机」。
- **现状（已读代码，确认当前是「自动、全量、不可控」）**：
  - 桥脚本 `BRIDGE_SCRIPT`（`src/lib/page-bridge.ts:98-438`）被 `injectBridge`（`page-bridge.ts:447`）**无条件注入每一份资料 html**，运行在 `sandbox="allow-scripts"` 不透明源 iframe 内。
  - 它**自动**挂 `click/scroll/change/submit/pagehide/mouseup/dblclick + speechSynthesis` 监听，把 `page:event`（kind∈open|click|scroll|input|submit|pagehide|tts|tts-cancel|lookup）经 `postMessage` 上抛（`page-bridge.ts:226-310`）。**采集时机与数据形状完全由桥写死，资料作者无法干预**——即「不特定操作也一直在通讯」。
  - 父页面 `src/components/MaterialsPanel.tsx:182-246` 的 `message` handler 只认 `page:*` 前缀：tts→edge-tts、lookup→查词浮层、其余→节流后 `onPageEvent` 上抛给 Learn→注入 agent。**没有「作者自定义事件 / 请求-响应」的任何通道**。
  - `PageEventKind` 是封闭 union（`page-bridge.ts:18`），无自定义类型；`onPageEvent` 回调（`MaterialsPanel.tsx:37`）只转发固定 `PageEvent`，资料作者没法带任意 payload。
- **需求拆解**：
  1. **可控触发**：资料作者能决定「什么操作才通讯」——而非桥全量自动抓。默认保留现状（兼容旧资料），但允许资料声明「手动模式」关掉 blanket 采集。
  2. **接口协议（契约）**：给作者一份稳定协议——规定消息信封、上行（自定义事件）、下行（宿主能力）的类型与字段；作者据此在 html 里 `emit('动作', {数据})` 并在「想要的时机」调用。
  3. **数据可设计**：作者能带任意结构化 payload（如 `emit('submit-answer',{qid,answer,correct})`），父页面透明上抛给 agent，让孩子/家长 agent 知道「资料里发生了 X 并带了 Y」。
  4. **（进阶）请求-响应**：资料可向宿主「调用」能力并拿回结果（如 `request('goto-course',{topic})`、`request('get-progress',{})`），形成真正的「接口」。
- **设计建议（推荐方案：开放 PiBridge SDK + 信封协议）**：
  - **信封**：所有自定义消息走统一信封 `{ __pi: 1, kind: "app"|"app-req"|"app-res", ... }`，与现有 `page:*` 自动事件区分，互不干扰。
  - **上行（iframe→主）**：`kind:"app"` = 作者自定义事件 `{ action: string, payload?: any, ts }`。父 handler 收到后，转成 `PageEvent` 新 kind `"app"`（`detail={action,payload}`）走原 `onPageEvent` 通道，agent 即知「资料触发了某动作」。
  - **请求（可选 v2）**：`kind:"app-req"` 带 `requestId` + `action` + `payload`；父页面经新增 prop `onAppRequest(action,payload):Promise<result>` 交给 Learn/agent 处理（跳转课程、取进度等），回执 `kind:"app-res"` + `requestId`。
  - **SDK（让作者不必手搓 postMessage）**：在 `BRIDGE_SCRIPT` 里暴露稳定全局 `window.PiBridge = { emit(action,payload), request(action,payload):Promise }`（request 内部生成 requestId 并挂一次性 `message` 监听收 `app-res`）。这就是「协议」官方客户端，作者只需 `PiBridge.emit(...)`。
  - **手动模式（满足「只有特定操作才通讯」）**：注入前识别资料是否声明 `<meta name="pi-bridge" content="capture=manual">` 或 `window.__PI_CAPTURE_MANUAL=1` → 桥**不挂** click/scroll/lookup 等 blanket 监听，仅保留 `page:ready` 握手 + `PiBridge` 出口 + speechSynthesis 接管。默认仍为 auto（向后兼容）。
  - **协议文档**：新增 `docs/MATERIAL-BRIDGE-PROTOCOL.md`，枚举信封、上行/下行消息类型、`PiBridge` API、字段约束与示例（含「随堂测验资料 emit('submit-answer')」「绘本 request('goto-course')」），`page-bridge.ts` 顶部注释引用。
- **修改入口 / 方向**：
  - `src/lib/page-bridge.ts`：① `PageEventKind` 加 `"app"`（:18）；② 新增 `PiAppEvent`/`PiAppRequest`/`PiAppResponse` 类型与 `PI_APP_MSG_*` 常量；③ `BRIDGE_SCRIPT` 内：a) 暴露 `window.PiBridge.emit/request`，b) 识别 `capture=manual` 跳过 blanket 监听（:226-310），c) 监听 `app-res` 兑现 request Promise；④ `injectBridge`（:447）支持把 manual 标志前置注入。
  - `src/components/MaterialsPanel.tsx`：handler（:182-246）识别 `__pi` 信封——`app`→转 `PageEvent{kind:"app"}` 走 `onPageEvent`；`app-req`→调新 prop `onAppRequest` 并 `postMessage(app-res)`；`window.PiBridge` 存在性兼容。
  - 类型导出：`MaterialsPanelHandle`/Props 增加 `onAppRequest?`；`Learn.tsx` 实现该 prop，把 app 事件/请求接入 agent 上下文（让 agent 感知资料内动作）。
  - `docs/MATERIAL-BRIDGE-PROTOCOL.md`（新建）：协议规范 + 示例。
  - `electron/lib/programming-agent.ts`：**制作侧主入口**——`buildProgrammingPrompt`（:28）内嵌协议默认约定（默认用 `PiBridge` 上报互动 + 可用 request 调宿主），使所有经 `generateHtmlLesson` 产出的网页自动合规；无需改动各学习 agent 的 prompt。
- **附：agent 如何「知道」协议、又如何「用它做网页」（家长 agent + 孩子 agent 双视角，仅讨论）**
  - **⚠️ 两个 page-bridge.ts 别混淆（已读代码确认）**：
    - 渲染层 `src/lib/page-bridge.ts`：定义 `PageEventKind` 联合、`PageEvent`、`BRIDGE_SCRIPT`（注入资料 html 的桥）、`injectBridge`、渲染层类型。协议**类型 + SDK(`window.PiBridge`)** 落这里。
    - 主进程 `electron/lib/page-bridge.ts`：定义 `PageBridgeEvent`、`queuePageEvent`(130)、`formatPageEvent`(59)、`executePageAction`、`recentInteractions`。**运行时把事件转成文注入 agent** 落这里。两处都要改，且互相通过 IPC（`pi:page:event`，ipc-handlers.ts:83）衔接。
  - **A. 孩子 agent 怎么「感知」资料里发生的自定义动作（运行时消费侧）**：
    - 现有链路（已读 `Learn.tsx:643` + `ipc-handlers.ts:83` + `electron/lib/page-bridge.ts:130/59`）：资料事件 → `MaterialsPanel.onPageEvent` → `Learn.handlePageEvent` → `window.api.pageEvent` → IPC `pi:page:event` → `queuePageEvent` → `formatPageEvent` 转自然语言 → 经 `session.steer`/`followUp`（或 `takePendingPageEvents` 附到下一轮消息）注入孩子 agent 上下文。即孩子 agent “看到”的是一段中文描述。
    - **当前缺口（必须补）**：`formatPageEvent` 的 `default` 分支只输出 `有互动事件（${kind}）`——自定义 `app` 事件会变成「有互动事件（app）」，**action 与 payload 全丢**，agent 不知发生了啥。需加 `case "app"`：`在资料「${title}」中触发了动作「${detail.action}」，数据：${JSON(detail.payload)}`（`detail` 须携带 action+payload，渲染层 `PageEvent` 的 `detail` 已留 `action?` 字段可复用）。
    - **行为规范（让 agent 会“用”这些事件）**：孩子 agent 的行为规范在 `LEARNING_NAV_INSTRUCTIONS`（pi-session.ts，经 `buildAgentsMd` 生成）里要新增一段：「学习资料可能通过桥协议上报自定义互动（动作 action + 任意数据 payload）；你要据此知情并适当回应/记录（如孩子提交答案后给予反馈、把对错记入学习记录）。」否则模型只收到一句描述却不知道该怎么处理。
  - **B. 「做网页的 agent」怎么「知道协议、从而做出合规网页」（制作侧，已读代码修正）**：
    - **⚠️ 关键架构事实（已读 `programming-agent.ts`）**：实际**动手写 HTML 的不是家长/孩子学习 agent，而是专门的「编程 agent」**。`generateHtmlLesson`（programming-agent.ts:178）由「调用方学习 agent（家长/孩子）」触发，学习 agent 只提供 `requirement`（需求描述，含结构/内容/交互要求），**真正把需求落成 HTML 代码的是编程 agent**（`buildProgrammingPrompt`，programming-agent.ts:28）。即链路：`学习 agent(家长/孩子)` → 提供 `requirement` → `编程 agent` → 写 HTML 落盘。
    - **结论（用户 9/7 提问点）**：协议**主要只需告诉「编程 agent」这一处**即可——因为它是 HTML 的唯一作者；家长/孩子学习 agent 只是调用方，**不必**深懂 `PiBridge` API。
    - **主入口（必改）**：在 `buildProgrammingPrompt`（programming-agent.ts:28）内嵌「协议默认约定」——「生成交互式学习资料时，默认用 `window.PiBridge.emit(action, payload)` 上报关键互动（如提交答案、完成小节）；可用 `PiBridge.request(action,payload)` 调用宿主能力；信封与标准 action 见 `MATERIAL-BRIDGE-PROTOCOL.md`」。把它做成**默认行为**，则无论哪个学习 agent 来调用，产出的网页都自动合规。
    - **调用方学习 agent（家长/孩子，选改，非必须）**：因编程 agent 已默认用协议，学习 agent 只需在 `requirement` 里**用自然语言描述交互意图**（如「学生提交答案后把结果上报」），不必写具体 API。仅在需要「请求-响应」等进阶能力时，才建议学习 agent 的 prompt（`buildParentPrompt` / `buildAgentsMd`）轻量提示「可要求编程 agent 用 PiBridge 请求宿主能力」。即：**协议知识集中在编程 agent，调用方零/低耦合**。
    - **唯一真源**：`docs/MATERIAL-BRIDGE-PROTOCOL.md`（信封、`PiBridge.emit/request` API、标准 action 目录、示例）。编程 agent 的 prompt 内嵌「简短契约 + 2 配方（随堂测验 `emit('submit-answer',{qid,answer,correct})`、绘本 `request('goto-course',{topic})`）」；完整文档留作人工参考 / 或给编程 agent 加 `get_material_protocol` 工具按需拉取（避免常驻 token）。
  - **C. 共享 action 词表（跨 agent 一致性的关键）**：家长 agent 制作时“发明” `action` 字符串，孩子 agent 运行时“解释”它——二者必须对齐。协议文档须定义**标准 action 目录**（种子：`submit-answer`/`complete-section`/`request-help`/`self-check`/`goto-course`…）并约定「自定义 action 须在 payload 自带语义说明」；两 agent 加载同一目录。否则自由命名无法被消费侧理解。
  - **D. 请求-响应（app-req/app-res）归谁 fulfil**：资料 `PiBridge.request('goto-course',{topic})` 上行后，宿主侧 `onAppRequest`（Learn 实现）可把请求转成「资料请求：goto-course {topic}」观察喂给孩子 agent 由其决策（如切课），或由专用工具直接处理。两边 prompt 都需说明「资料可能向你发请求、你如何响应」。
  - **E. 版本与兼容**：信封 `__pi` 建议带 `v:1`；旧资料（仅 `page:*`）仍走原通道，新协议默认降级为忽略，避免 breaking。
- **优先级**：中（增强，向后兼容；但「作者可编程资料」是英语/随堂测验类高质量资料的关键能力，当前完全不具备）
- **记录时间**：2026-09-07

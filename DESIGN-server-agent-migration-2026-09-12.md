# DESIGN：Agent 全量上移服务端（server-only agent）迁移设计

- **定案时间**：2026-09-12（用户拍板：不要过渡；agent 只在 server 端；client 不再有 agent）
- **决策记录**：`.workbuddy/memory/ISSUES/ISSUE-080.md` §七
- **前置评估**：ISSUE-080 §六（代码实测底数、服务端缺口 5 条、有利发现 4 条）
- **状态**：设计定案，待实施（P1 为分水岭）
- **实施后必须同步**：`ARCHITECTURE.md`（本文件落地后成为新架构真源，ARCHITECTURE.md 按本文件改写）

---

## 1. 目标架构

```
┌──────────────── 客户端（Electron / Web / 手机浏览器）────────────────┐
│  渲染层 src/**（17k 行，零 Electron 依赖，经 window.api 契约通信）    │
│    ├─ 显示：聊天流 / 资料面板 / 进度 / 考核 / 每日记录 / 排期          │
│    ├─ 采集：文本输入、语音录音（MediaRecorder）、图片/文件上传、     │
│    │        页面事件（孩子点了哪个词、看了哪页）                     │
│    └─ 播放：TTS 音频、铃声/提醒                                       │
│  适配层 window.api 实现（HTTP + SSE；替换 398 行 preload 契约）       │
│  ✗ 无 agent、无 LLM 调用、无 apiKey、无本地会话文件                   │
└───────────────────────────────┬──────────────────────────────────────┘
                    HTTP(REST) + SSE(下行流) + 事件上行
┌───────────────────────────────┴──────────────────────────────────────┐
│                    learning-server（唯一 agent 宿主）                 │
│  会话层：持久会话（孩子/课程/场景/家长）+ 隔离（childId/parentId）    │
│  运行时：ModelRuntime + provider 注册 + 模型选择 + token 统计         │
│  Agent：prompt 构建（孩子/家长/场景）+ learning-guard + 上下文压缩    │
│  工具层：                                                            │
│    ├─ 数据工具：kb / 计划域 / 考核 / 材料 / 进度（直调 handler）      │
│    ├─ 文件工具：server 作用域 read/write/edit/ls（路径沙箱）          │
│    └─ 能力协商工具：page_* 等仅当连接设备声明能力时注入               │
│  服务：材料存储（真源）+ display_content 多端推送 + TTS 合成          │
│  既有：worker（recording/todo 定时自主任务）、exam routes、同步镜像   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. 职责边界（红线级）

| 能力 | server | client |
|---|---|---|
| 会话状态、上下文、历史 | **唯一真源（持久化）** | 只读渲染 + 增量接收 |
| 模型调用 / apiKey | **唯一持有** | ✗ 不得出现 |
| prompt / 行为规范（AGENTS）/ learning-guard | **唯一执行方** | ✗ |
| 全部工具执行（含数据工具） | **唯一执行方** | ✗ |
| 资料页**内容感知** | 直接读材料源文件（server 真源，静态 html） | 渲染展示 |
| 资料页**实时态**（DOM 快照 / 孩子互动） | 经 PiBridge 事件上行（互动摘要）+ 按需向设备**查询**（实时快照） | 采集页面事件并回传 |
| 资料页**受控操作**（click/scroll/input） | 命令**发起方** | 命令**执行端点**（经 `page:app-cmd` 落到 iframe） |
| 编程 agent（生成资料页 html） | **server 端子 agent**，由 server agent 调用 | ✗（仅渲染产出） |
| TTS 合成 | 合成（edge-tts，跨端音色一致 + 可缓存） | 播放 |
| ASR / 发音评测 | 调 API（音频由客户端上传） | 录音采集 |
| 材料（html/媒体） | **唯一真源 + 存储 + 推送** | 渲染/播放 |
| 定时任务（recording/todo） | worker（已完成，ISSUE-028） | ✗ |
| 上课/下课提醒铃声 | 触发时间下发 | 本地播放（离线也可响） |
| 窗口控制、文件选择、浏览器面板 | ✗ | 设备能力（Electron 专有，web 端降级） |

**三条红线：**
1. **不双跑**：客户端不得保留任何 agent/LLM 路径，禁止「server 不可用时本地兜底」。
2. **不静默降级**：server 不可达 → 显式错误 UI + 禁用对话入口，明确提示原因。
3. **隔离不放松**：server 侧一律以 `parentId`+`childId` 做数据与路径沙箱（ISSUE-023 教训在服务端逐条对照重做）。

---

## 3. 接口契约（新增）

### 下行（server → client）
| 通道 | 形式 | 用途 |
|---|---|---|
| 发送消息 | `POST /api/v1/agent/:childId/prompt`（parentId 由 token 派生） | 提交用户输入（文本/附件 id/页面事件） |
| 事件流 | `GET /api/v1/agent/:childId/stream`（SSE） | 流式 token / thinking / tool 调用与结果 / 需要确认的交互 |
| 材料推送 | 复用 SSE（`event: materials`） | display_content 产出 → 各端 MaterialsPanel 订阅渲染 |
| TTS | `POST /api/v1/voice/tts` → MP3（或 URL + 缓存） | 合成后客户端播放 |
| 会话回看 | 复用现有 `GET /api/v1/sessions/:childId?date=` | 历史渲染 |
| **资料页命令**（click/scroll/input/read） | 复用 SSE（`event: page_cmd`，带 requestId） | 落到 `MaterialsPanel.appCmd` → iframe，结果经上行通道回执 |

### 上行（client → server）
| 通道 | 形式 | 用途 |
|---|---|---|
| 音频/文件 | `POST /api/v1/files` / `materials/upload`（已有） | 语音、图片、附件 |
| 能力声明 | SSE 建连时 query/header 上报：`caps=material-panel,mic,electron` | 决定 server 侧工具装配（如无 `mic` 则不注册录音相关能力） |
| 设备事件 | `POST /api/v1/agent/:childId/events` | 页面事件（`page:app` 信封原样透传）、窗口状态等 |
| **资料页命令回执** | 复用 events 通道（`page_cmd_result`，requestId 配对） | 命令执行结果回给 server agent |

### 会话与并发
- 单一活动会话（per childId）；后连设备**默认只读回看**，可「接管」（显式按钮，前设备降级只读）。
- 断线重连：SSE 带 `Last-Event-ID`，server 缓冲最近 N 条事件重放。

---

## 4. 资料页感知与操作（page_* 的 server 形态）——修正说明

**修正一个此前的误判**：早期评估把 `page_inspect`/`page_action` 归为「设备绑定工具、需能力协商裁剪」。**这是错的**——当年这两个工具走客户端，不是因为它属于客户端，而是因为**渲染态**在客户端；**资料源（html 真源）本就在 server**。

### 4.1 三层能力拆分（各归其位）

| 能力 | 实现位置 | 依据 |
|---|---|---|
| **看资料内容**（html 正文/结构） | **server 直接读材料源文件**（真源），用现有 read 工具 + 截断策略；**无需任何设备参与** | 资料 html 由 `material-doc.ts` 从服务端拉取（协议 §9），server 本就是唯一真源 |
| **知道孩子做了什么** | PiBridge 事件（`page:app` 信封 + 动作目录）由客户端透传到 server，**格式化后进 agent 上下文**；互动摘要由 server 侧存储/查询 | 协议 §4/§5 已定义信封与动作目录；`formatPageEvent`（`electron/lib/page-bridge.ts`）的格式化职能随 agent 一起上移 |
| **改页面 / 读实时 DOM** | 需要设备执行：命令经 **SSE 下行** → `MaterialsPanel.appCmd` → iframe → **回执上行**（`page_cmd_result`，requestId 配对） | 协议 §4/§9 的 `page:app-cmd` + `page:app-cmd:result` 通道**已实现**，只需把传输从本地 IPC 换成 HTTP/SSE |

### 4.2 因此

- **两个工具都保留，不是删除、也不是裁剪**；改的是**传输层**（IPC → SSE/HTTP），客户端侧代码（`src/lib/page-bridge.ts`、`MaterialsPanel.appCmd`）**基本不动**，只是把「对端」从本地 agent 换成 server agent。
- **能力协商（caps）只用于真实设备差异**：`mic`（录音/语音作答）、`electron`（窗口控制、浏览器面板等 Electron 专有件）、`material-panel`。page_* 工具只要设备有资料面板即可用。
- **实时 DOM 快照是可选降级**：绝大多数情况 server 读源文件 + 互动事件已足够；确实需要 JS 渲染后状态的场景，才走「向设备查询实时快照」（复用 page_action 的 `read`）。
- 协议拓扑变更需在 `MATERIAL-BRIDGE-PROTOCOL.md` 标注（host = 客户端渲染层，agent = server），本设计落地时同步。

---

## 5. 共享包结构（前置条件，必须先做）

现状坏味道：`server/src/worker/recording-prompt.ts` 与 `electron/lib/recording-prompt.ts` 是同源副本；`pi-session.ts` 的会话/prompt 逻辑与 `worker/tasks.ts` 的 ephemeral 会话是两份实现。继续复制必然漂移（ISSUE-056 教训）。

```
packages/agent-core/            # 新增，server 与 client(过渡期) 共用，最终只 server 用
  ├─ sessions/   会话管理（持久会话、autoNewSession、resetLeaf/newSession 语义、隔离）
  ├─ runtime/    ModelRuntime 工厂 + provider 注册 + 模型选择 + token 统计
  ├─ prompts/    buildChildPrompt / buildParentPrompt / 场景 prompt / AGENTS 注入
  ├─ guard/      learning-guard 扩展
  ├─ tools/      工具定义与实现（含 server 作用域 FS 工具、资料页工具、编程 agent 子 agent）
  ├─ bridge/     PiBridge 信封常量 + formatPageEvent 格式化 + 动作目录（与 MATERIAL-BRIDGE-PROTOCOL.md 对齐）
  └─ paths/      parentId/childId 路径沙箱（唯一真源，禁止各模块自行拼路径）
```

**规则**：`packages/` 内不得 import `electron`、不得读本地 `data/`（路径一律由调用方注入）；server 侧注入 `dataDir`，client 侧在过渡期注入同一契约。落成后 `recording-prompt` 两处副本合并为一份。

---

## 6. 迁移阶段（无过渡版本，直接迁）

### P0 — 共享包抽取（前置）
- 抽 `packages/agent-core`（§5 结构），先把 **prompt + guard + 路径沙箱 + 工具定义 + bridge 格式化** 五项抽净。
- 合并 `recording-prompt` 副本。
- 验收：server `tsc` 0 错；客户端 build 通过；worker 行为不变（已有冒烟脚本 `server/scripts/worker-*-check.mts` 全过）。

### P1 — 会话权威上移 + 流式（分水岭）
- 服务端**持久会话**：会话落盘（per parentId/childId），`session_files/session_messages` 由「客户端权威镜像」翻转为「server 权威」（客户端同步逻辑下线）。
- 新增 **SSE 流式端点** + 事件缓冲/重放；`POST prompt` 入口；**建连时 `caps` 上报骨架**（P3 起用于工具装配）。
- 新增 **server 作用域 FS 工具**（read/write/edit/ls，路径沙箱）。
- 迁移 `daily-summary`（summarize_conversation）到 server。
- 验收：孩子对话在 server 完整跑通（含工具调用、thinking 流、上下文压缩）；同一 childId 两个客户端可接管/回看；客户端关掉后 server 会话不丢。

### P2 — 家长 agent 上移（低成本模式验证）
- 家长通用会话 + content 会话迁 server；家长工具集 server 版（材料 list/read/write/delete/move 直调 handler —— **即 ISSUE-079 的 server 形态**；课程/主题/排期/考核/积分工具）。
- `parent-vision`（图片理解）迁 server。
- 验收：家长「整理课程资料」全流程在 server 跑通（079 场景验收）；上传/读取/删除/归并正确且带 parentId 隔离。

### P3 — 孩子 agent 上移
- 孩子主会话/课程会话/场景会话迁 server；平移 `buildChildPrompt` 课程注入、learning-guard、4 类会话语义。
- `display_content` 改建为「server 材料存储 + SSE 多端推送」。
- `exam-engine`（选课 LLM / 出题 / 判分）迁 server —— 考核彻底服务端化（server 现有 exam routes 只有数据层）。
- **资料页工具传输改造（§4）**：`page_inspect`/`page_action` 保留并上移为 server 工具——内容感知直读材料源；互动事件经 events 通道上行并格式化；受控操作经 SSE 下发 + 回执上行；实时 DOM 快照为可选降级。客户端 `page-bridge.ts` / `MaterialsPanel.appCmd` 不动。
- **`programming-agent` 上移为 server 端子 agent**（由 server agent 调用生成资料页），不再由客户端调用。
- `caps` 用于真实设备差异（`mic` / `electron` / `material-panel`）。
- 验收：孩子端学习对话 + 资料推送 + 页面操作 + 考核出题判分全链路在 server；手机浏览器可完成同样流程。

### P4 — 客户端瘦身 + web/手机端
- 实现「HTTP+SSE 版 `window.api`」适配层（对齐 398 行 preload 契约，280 处调用点不改）；Electron 专有件（TitleBar/窗口控制/浏览器面板）在 web 端降级隐藏。
- 拆除客户端 agent 全部代码：`pi-session.ts`、`pi-runtime.ts`、`exam-engine.ts`、`parent-vision.ts`、`programming-agent.ts`、本地 `kb-sqlite`（读路径改为 server API）、`custom-tools.ts` 中的 agent 工具部分。
- 客户端保留：渲染、录音、上传、播放、铃声提醒、窗口控制、**资料页桥（PiBridge 注入 + appCmd 执行端点 + 事件上抛）**。
- 验收：客户端零 `@earendil-works/pi-coding-agent` 依赖（`package.json` 可移除）；web 端在手机浏览器跑通孩子完整学习流程（含资料页互动）。

---

## 7. 设计点：全部已决（2026-09-12 20:10 用户拍板）

| # | 问题 | 定案 |
|---|---|---|
| 1 | `page_inspect`/`page_action` | **保留并上移**——资料源在 server 直读，孩子操作经 PiBridge 约定信封上送 server，仅「实时渲染态」按需向设备查询；传输层从 IPC 换 SSE。**不是删除、不是能力裁剪**（详见 §4） |
| 2 | TTS 合成位置 | **server 合成**（edge-tts，跨端音色一致 + 可缓存），客户端只播放 |
| 3 | 上课/下课提醒 | **server 下发时间 + 客户端本地播放**（离线也能响） |
| 4 | 旧客户端兼容 | **硬断代**：server 拒绝旧版本客户端，要求升级 |
| 5 | `programming-agent`（ISSUE-020） | **也在 server 端，由 server agent 调用**（作为 server 端子 agent），不单独立项 |

**连带**：`MATERIAL-BRIDGE-PROTOCOL.md` 需标注拓扑变更（host=客户端渲染层、agent=server），落地时同步。

---

## 8. 关联

- **ISSUE-080**：决策记录与本设计的来源（§六评估 / §七定案）
- **ISSUE-079**：形态变更 → 成为 P2 的一部分（server 端材料工具直调 handler）
- **ISSUE-028**：服务端 worker/runtime/kb-tools/scheduler 是本设计的现成基建
- **ISSUE-078**：已完成的上传路径/家长隔离修复保持有效（P2 后在 server 侧天然成立）
- **ISSUE-020**：编程 agent 定案并入服务端（server 端子 agent，由 server agent 调用）
- **MATERIAL-BRIDGE-PROTOCOL.md**：协议拓扑从「页面 ↔ 本地 agent」变为「页面 ↔ 客户端宿主 ↔ server agent」，落地时按本文件 §4 同步修订

---

## 9. 实施记录：P0 + P1（2026-09-12）

### 9.1 已落地

| 项 | 落点 | 说明 |
|---|---|---|
| 共享包 | `packages/agent-core` | `paths` / `bridge` / `sessions` / `runtime` / `prompts`（recording prompt 真源，已合并两端漂移副本） |
| 服务端 agent 路由 | `server/src/routes/agent.ts` | SSE 流 + prompt + 事件上行 + 资料页操作回执；feature 标志 `server_agent` |
| 会话注册表 | `server/src/agent/session-registry.ts` | 按 `parentId:childId` 复用**持久会话**，事件广播多端 |
| 事件中枢 | `server/src/agent/stream-hub.ts` | 环形缓冲 + `Last-Event-ID` 重放 + 订阅退订 |
| 服务端文件工具 | `server/src/agent/fs-tools.ts` | read/write/edit/ls，路径沙箱（越界拒绝） |
| 上下文压缩上移 | `server/src/agent/kb-summary-tool.ts` | `summarize_conversation` 复用 worker 的 `runRecordingSummary` |
| 构建对齐 | `server/tsconfig.json` / `scripts/build.mjs` / `package.json` | tsc 退为纯类型检查（noEmit）；构建物 = esbuild `dist/server.cjs`（与 201 生产一致）；SDK 别名锁定服务端副本 |
| 版本 | `SERVER_VERSION` → 0.4.0，features + `server_agent` | 客户端将来据此判断「可切换到服务端 agent」 |

### 9.2 与设计的两处偏差（均已落地并记录原因）

1. **共享包的消费方式**：客户端只引 **SDK-free 模块**（`bridge` / `prompts`，相对路径转发），服务端以包名引入全部模块并把 SDK 别名锁定到 `server/node_modules`。
   原因：两端固定了不同版本的 pi-coding-agent（服务端 0.84.1 精确、客户端 ^0.84.1），若共享模块直接解析 SDK，会从共享包位置向上命中**其中一侧**的副本，导致另一侧编译/打包静默用错版本——本次实测已出现类型差异（服务端 0.84.1 要求 `AgentToolResult.details` 必填，客户端不要求），印证了这个风险。
2. **新增两个服务端目录**（设计时未定，实施中确定）：
   - `agent-sessions/<parentId>/<childId>/`：服务端自持会话（与客户端镜像 `sessions/` 分开，避免命名/游标互相污染）；
   - `workspaces/<parentId>/<childId>/`：孩子 agent 工作区（文件工具根）。
   两者均已在 `packages/agent-core/src/paths.ts` 集中定义，并在 `ARCHITECTURE.md` §2.1 登记。

### 9.3 P1 的边界（尚未做的部分）

- **客户端尚未切换到服务端 agent**：切换属 P4（含 `window.api` web 适配层与客户端 agent 拆除）。当前客户端仍跑旧本地 agent，是迁移过程中的临时并存，不是设计目标。
- **DB 会话镜像未翻转**：`session_files/session_messages` 仍是客户端权威镜像；服务端会话已自持落盘（`agent-sessions/`），镜像通道保留兼容旧客户端，P4 随客户端改造下线。
- **孩子工具面仍是 P1 子集**：kb 三件套 + 文件工具 + `get_date` + `summarize_conversation`；`display_content` / page_* / 考核 / learning-guard / AGENTS 真源接入属 P3。

### 9.4 验证

- `server npm run typecheck` → 0 错；`node scripts/build.mjs` → `dist/server.cjs` 15.9MB（banner v0.4.0，import_meta 垫片 18 处）。
- `server/scripts/agent-session-check.mts` → **22 项全过**（事件中枢/沙箱/文件工具/路由鉴权与隔离/版本协商；prompt 在无模型 key 时干净报错并流出 `user_message,error,turn_end`，不烧 token）。
- `server/scripts/worker-catchup-check.mts` → 全过（证明共享包抽取未破坏既有 worker 行为）。
- 客户端 `npm run build` → 全绿；`test/page-bridge.test.ts` 32 通过 / 2 失败（两个失败均为**改动无关的既有失败**：`src/lib/page-bridge.ts` 的 `injectBridge` 组合断言与 BRIDGE_SCRIPT 体积断言）。
- 清理：`server/dist` 移除旧的 tsc 产物（只保留 `server.cjs`），避免「跑的是过期代码」；`worker-tasks-check.mts` 修正为不再假设第二个任务是 todo（todo 已于计划域重构迁至 plan-domain 游标驱动）。

### 9.5 踩坑登记

- **package.json 的 BOM**：用脚本重写 `server/package.json` 时若引入 UTF-8 BOM，Node 的 `JSON.parse` 会抛 `Unexpected token ''`（构建产物其实已生成，只在末尾读版本时崩）。已给 `scripts/build.mjs` 加 `replace(/^\uFEFF/, "")` 兜底。
- **SDK 版本严格类型差异**：见 9.2.1——服务端 `AgentToolResult` 要求 `details` 必填，新增工具须带 `details: {}`。

---

## 10. 实施记录：P2（2026-09-12）

### 10.1 已落地（家长 agent 上移 + ISSUE-079 server 形态）

| 项 | 落点 | 说明 |
|---|---|---|
| 材料域操作 | `server/src/agent/parent-materials.ts` | list/read/put/delete/move 直接操作真源（磁盘 + `materials` 索引表）；路径归一化 + 沙箱 + activity-log |
| 家长工具集 | `server/src/agent/parent-tools.ts` | 9 个家长工具 + 工作区文件工具 + get_date |
| 识图上移 | `server/src/agent/vision.ts` | 客户端 `parent-vision.ts` 逻辑上移；`pickVisionModel` 已加入共享包 runtime |
| 家长会话 | `server/src/agent/parent-registry.ts` | key=`<parentId>:<kind>`，持久落 `agent-sessions/<parentId>/<kind>/` |
| 家长路由 | `server/src/routes/parent-agent.ts` | SSE + prompt（kind 校验、busy→409）；feature `parent_agent` |

**ISSUE-079 的落地形态（取代原「客户端封装 agent 工具」方案）**：四个必备管理动作齐备；删除**工具层强制先演练后确认**（`confirm !== true` 只返回清单，不靠提示词约束）；read 文本 ≤200KB、二进制只回元数据；topic 白名单 + 禁 `.`/`..` 段 + `resolveWithin` 沙箱；跨家长路径被拒。

### 10.2 验证

- `server npm run typecheck` → 0 错；`node scripts/build.mjs` → `dist/server.cjs` 16.7MB（v0.4.0）。
- `server/scripts/parent-agent-check.mts` → **27 项全过**（四动作 + 隔离/穿越 + dryRun→confirm 两步语义 + 工具层 + 路由 401/400/kind + 家长库只读 + 版本协商；prompt 在无 key 时干净报错，不烧 token）。
- 回归：`agent-session-check.mts`、`worker-catchup-check.mts` 全过。

### 10.3 P2 余项（未做）

- 客户端尚未切换到服务端家长 agent（切换属 P4，与孩子端同批）。
- 家长侧的排期（study_plan_*）、考核（assess_*）、积分工具尚未上移——P2 先交付「资料治理」这条最痛链路（079 场景），其余随 P3/P4 或增量补齐。
- `parent_read_image` 目前支持材料相对路径与 `uploads/`、`files/` 前缀的上传路径。

---

## 11. 实施记录：P3 第一批（2026-09-12）

**已落地**：`display_content` 改建为「服务端登记 + SSE 推送」（校验路径 + 推事件 + 多端渲染）；`page_inspect`/`page_action`/`scene_command` 上移并以 SSE 完成传输层改造（下行 `page_cmd` / 上行 `page-result`，客户端桥实现不动）；设备能力协商 `caps`（`page_*` 仅在有资料面板时注册，caps 变化重建会话）；`learning-guard` 上移至共享包（客户端转发）；AGENTS 用户版本直读服务端真源注入 prompt。

**验证**：typecheck 0 错；`agent-session-check.mts` 44 项全过（含 page_action 下行→回执闭环、scene 映射、caps 装配、guard 拦截与日期注入、AGENTS 注入）；`parent-agent-check.mts`(27)、`worker-catchup-check.mts` 回归全过；客户端 build 全绿。

**P3 余项（下一批）**：考核 LLM 上移（选课/出题/判分，对应 §4 之外的 exam-engine 迁移）；`programming-agent` 上移为 server 端子 agent；课程会话/场景会话的完整语义平移（当前孩子会话为单会话形态，课程级 prompt 注入待接）；客户端切换（P4）。

---

## 12. 实施记录：P3 第二批（2026-09-12）—— 考核 LLM 上移

**已落地**：`server/src/agent/exam-engine.ts`（出题仅覆盖非结构化课程 + 逐题并发判分 + 选择题本地规则判分 + 服务端审计，prompt 默认不落盘）；`server/src/routes/exam-agent.ts`（generate / grade / scoring-prompt，feature `exam_agent`）——输入只给标识、配置由服务端真源拼装、判分口径不接受客户端传入；`fetchCoursesWithKnowledgePoints` 从 routes/exam.ts 导出复用。**选课 LLM 未迁**——2026-09-09 起固定档已用「计划周期内必学课全考」的内置规则替代，LLM 选课废弃。

**验证**：typecheck 0 错；`exam-agent-check.mts` 30 项全过（JSON 容错 / 选择题规则判分 / prompt 组装 / 审计 / 路由鉴权与 404 / 选择题不经模型即判出）；三个既有冒烟脚本回归全过。

**P3 剩余**：`programming-agent` 上移；课程/场景会话完整语义平移；客户端切换（P4）。

---

## 13. 实施记录：P3 第三批（2026-09-12）—— programming-agent + 会话类型

**已落地**：`server/src/agent/programming-agent.ts`（独立会话、按 sessionKey 复用、只做代码生成、模型取家长「编程 agent 模型」未配置即报错、输出沙箱、落盘非空校验），家长侧工具 `parent_build_material`、孩子侧 `create_html_lesson`；会话类型 `main`/`scene`/`course:<课程名>`（各自落盘、场景工具收窄 + 游戏主持人口径、课程注入教法/考核/资料路径、`sessionSlot` 路径安全），路由 `session` 参数区分。

**验证**：typecheck 0 错；`agent-session-check.mts` 54 项全过；三个既有冒烟脚本回归全过。踩坑：注释里 `kb_*/` 的 `*/` 会提前闭合块注释。

**P3 全部完成；剩余 = P4**。
- **ISSUE-023**：childId 隔离教训，P1/P3 在 server 侧重做时必须逐条对照
- **ISSUE-056**：两套纪律/两处副本漂移的教训，是 §4 共享包的直接动因

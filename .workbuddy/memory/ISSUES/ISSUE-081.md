# [ISSUE-081] P1：agent 服务端化·会话权威上移 + 持久会话 + SSE 流式（分水岭）

- **类型**：架构 / 实施（承接 ISSUE-080 §七定案）
- **优先级**：高
- **状态**：**P0 + P1 + P2 + P3（第一批）已实施（2026-09-12）**，P3 余项与 P4 待做
- **记录时间**：2026-09-12
- **设计真源**：`DESIGN-server-agent-migration-2026-09-12.md`（§6 P1 / §9 实施记录）
- **标签**：`server-agent` `SPLIT` `会话权威` `SSE` `分水岭`

---

## 〇、实施结果（2026-09-12）

**已落地**：`packages/agent-core` 共享包（paths/bridge/sessions/runtime/prompts，recording prompt 两端副本已合并为一份）；服务端 agent 路由（`routes/agent.ts`：SSE 流 + prompt + 事件上行 + 资料页操作回执；feature `server_agent`）；持久会话注册表（`agent/session-registry.ts` → `agent-sessions/<pid>/<cid>/`）；事件中枢（`stream-hub.ts`，Last-Event-ID 重放）；服务端文件工具（`fs-tools.ts`，路径沙箱）；上下文压缩上移（`kb-summary-tool.ts` 复用 worker 的 `runRecordingSummary`）；构建对齐（tsc 退为类型检查、产物 = esbuild `server.cjs`、SDK 锁定服务端副本）；版本 0.4.0。

**验证**：server typecheck 0 错；esbuild 产物 15.9MB（v0.4.0）；`scripts/agent-session-check.mts` 22 项全过；`worker-catchup-check.mts` 全过；客户端 build 全绿（page-bridge 2 个既有失败与本改动无关）。

**边界（未做）**：客户端尚未切换到服务端 agent（P4）；DB 会话镜像未翻转（服务端会话已自持落盘，镜像通道保留给旧客户端）；孩子工具面仍是 P1 子集（display_content / page_* / 考核 / learning-guard / AGENTS 属 P3）。

**新增目录约定**：`agent-sessions/<parentId>/<childId>/`（服务端自持会话）、`workspaces/<parentId>/<childId>/`（文件工具根），均已在 `paths.ts` 集中定义并登记 ARCHITECTURE §2.1。

**踩坑**：① 共享包直接解析 SDK 会命中错误版本（两端 SDK 版本不同、`AgentToolResult.details` 必填差异）→ 服务端用 alias 锁定自己的副本；② `server/package.json` 的 UTF-8 BOM 会让 `JSON.parse` 崩（build.mjs 已加剥 BOM 兜底）。

---

## 〇之二、P2 实施结果（2026-09-12，家长 agent 上移 + ISSUE-079 server 形态）

**已落地**：
- `server/src/agent/parent-materials.ts` 材料域操作（真源直操作）：`list / read / put / delete / move` + 路径归一化与沙箱（`..` 段、非法 topic、越界一律拒绝）+ `activity-log` 追加。
- `server/src/agent/parent-tools.ts` 家长 agent 工具集：`parent_list_materials / parent_read_material / parent_delete_material / parent_move_material / parent_put_material / parent_library_topics / parent_library_courses / parent_read_image / log_activity`（+ 工作区 read/write/edit/ls + get_date）。
- `server/src/agent/vision.ts` 识图旁路（客户端 `parent-vision.ts` 上移；`pickVisionModel` 已在共享包 runtime 提供）。
- `server/src/agent/parent-registry.ts` 家长会话（kind=`parent` / `parent-content`，持久落 `agent-sessions/<pid>/<kind>/`，工作区 `workspaces/<pid>/parent/`）。
- `server/src/routes/parent-agent.ts`：`GET /api/v1/parent-agent/stream`（SSE + Last-Event-ID 重放 + `?token=`）、`POST /api/v1/parent-agent/prompt`（kind 校验、busy→409）；feature 增 `parent_agent`。

**ISSUE-079 的落地方案**（原方案 A「客户端封装 agent 工具」已被本条取代）：
- 四个管理动作齐备：list / read / delete / move（+ put 发布）；
- **删除必须先演练后确认**：`confirm !== true` 只返回将删除清单（工具层实现，不是靠提示词约束），真删写 activity-log；
- read 限流：文本类 ≤200KB 返回正文，二进制只回元数据（避免灌爆上下文）——对应 079 待确认项 3；
- 路径白名单：topic 段 `^[a-zA-Z0-9_-]+$` + 禁 `.`/`..` 段 + `resolveWithin` 沙箱——对应 079 待确认项 1；
- 隔离：`materials/<parentId>` 为根，跨家长路径被拒（对应 079 待确认项 5 的客户端侧防护；服务端 `/materials/*` 路由的 parentId 校验属既有实现）。

**验证**：server typecheck 0 错；`scripts/parent-agent-check.mts` **27 项全过**（四动作 + 隔离/穿越 + dryRun→confirm 两步语义 + 工具层 + 路由 401/400/kind + 家长库只读 + 版本协商）；P1 的 `agent-session-check.mts` 与 `worker-catchup-check.mts` 回归全过；esbuild 产物 16.7MB（v0.4.0）。

**边界（未做）**：客户端尚未切换到服务端家长 agent（P4 统一切换）；家长侧的排期/考核/积分工具尚未上移（现只有资料治理 + 家长库只读）；`parent_read_image` 的 uploads 路径分支仅支持 `uploads/`、`files/` 前缀。这些随 P3/P4 或后续增量补齐。

---

## 〇之三、P3 实施结果（2026-09-12，孩子 agent 上移·第一批）

**已落地**：
- **`display_content` 改建为「服务端登记 + SSE 推送」**（`server/src/agent/display-tool.ts`）：服务端不渲染，只校验路径（材料真源 / 孩子工作区 `outputs/`，兼容旧 `materials/` 前缀）并推 `display_content` 事件；多端可同时渲染、断线重连可回放。对不存在的资料给出可执行报错（提示工作区与核对手段）。
- **`page_inspect` / `page_action` / `scene_command` 上移 + 传输层改造**（`server/src/agent/page-tools.ts` + `page-hub.ts`）：内容感知与实时 DOM 经 SSE 下发 `page_cmd` → 客户端执行端点 → 回执经 `POST /agent/:childId/page-result` 兑现；场景指令映射为 `scene.<command>`（与 MATERIAL-BRIDGE-PROTOCOL §5 一致）。**客户端 `src/lib/page-bridge.ts` / `MaterialsPanel.appCmd` 无需改动**。每会话一个桥实例（requestId 不跨会话串兑）。
- **设备能力协商（caps）**（`server/src/agent/caps.ts`）：SSE 建连上报 `material-panel`/`mic`/`electron`；`page_*` 只在声明 material-panel 时注册（工具表即事实，模型不会调用做不到的工具）；**caps 变化即重建会话**（工具表创建时定稿），避免「同一会话有时能操作页面有时不能」。装配逻辑抽为纯函数 `computeChildToolNames(caps)` 便于测试。
- **learning-guard 上移**（`packages/agent-core/src/guard/learning-guard.ts`，客户端 `electron/extensions/learning-guard.ts` 改为转发）：路径越界拦截 + 每轮注入「日期+星期」（不含时分秒，保前缀缓存），孩子/家长会话共用一份。
- **AGENTS 真源直读**（`server/src/agent/session-registry.ts`）：服务端本就持有唯一真源（`agents.sqlite`，scope=child/ref=childId），直接读库注入 system prompt，消除了旧架构「客户端预取缓存 → 同步回调读缓存」的时序问题。

**验证**：server typecheck 0 错；`scripts/agent-session-check.mts` 扩到 **44 项全过**（新增 22 项：display 校验/推送、page_action 下行→回执闭环、scene 映射、事件累积、caps 装配与解析、guard 拦截与日期注入、AGENTS 注入）；`parent-agent-check.mts`(27) 与 `worker-catchup-check.mts` 回归全过；客户端 build 全绿；esbuild 产物 v0.4.0。会话就绪日志实测显示「caps=none → 工具 10 项」（未注册 page_*），协商按预期生效。

**P3 余项（未做，下一批）**：
- **考核 LLM 上移**（`electron/lib/exam-engine.ts` 的选课 LLM / 出题 / 判分；server 现有 exam 路由只有数据层）。
- **`programming-agent` 上移**为 server 端子 agent（由 server agent 调用）。
- **课程会话 / 场景会话语义**的完整平移（当前孩子会话是单会话形态；课程级 prompt 注入与 scene 专用会话属下一批）。
- 客户端尚未切换到服务端 agent（P4）。

---

## 一、为什么是分水岭

用户定案「agent 只在 server 端、client 不再有 agent、不要过渡」（ISSUE-080 §七）。P1 是这条路线能否成立的技术关口：**server 必须能跑持久会话并流式输出**，后续 P2（家长）/P3（孩子）/P4（web 客户端）都建立在它之上。

## 二、范围（P1 交付物）

1. **共享包抽取（P0 并入本 issue 前置）**：新增 `packages/agent-core`，抽取 sessions / runtime / prompts / guard / tools / **bridge** / paths 七模块（`bridge` 含 PiBridge 信封常量 + `formatPageEvent` 格式化 + 动作目录）；合并 `server/src/worker/recording-prompt.ts` 与 `electron/lib/recording-prompt.ts` 的同源副本。硬约束：shared 内不得 import `electron`、不得自行拼路径。
2. **持久会话（服务端）**：会话按 `parentId/childId` 落盘；`session_files` / `session_messages` 从「客户端权威镜像」翻转为 **server 权威**；客户端 `session-sync.ts` 同步逻辑下线。
3. **SSE 流式通道**：`GET /api/v1/agent/:childId/stream`（流式 token / thinking / tool 调用与结果）+ `POST /api/v1/agent/:childId/prompt`（提交输入）+ 事件缓冲与 `Last-Event-ID` 重放 + **建连时 `caps` 上报骨架**（P3 起用于工具装配）。
4. **server 作用域文件工具**：read/write/edit/ls 的路径沙箱版（替代客户端 `cwd=data/children/<id>` 语义）。
5. **上下文压缩上移**：`daily-summary.ts`（summarize_conversation，客户端 L159）迁 server。
6. **并发语义最小实现**：同 childId 单活动会话；后连设备只读回看，「接管」按钮切换。

## 三、关键文件 / 入口

| 动作 | 位置 | 现状 |
|---|---|---|
| 现有 worker 会话（ephemeral，仅内存） | `server/src/worker/tasks.ts` L87-117（`SessionManager.inMemory()` L111） | 需扩展为持久会话 |
| 现有 worker 运行时（极简） | `server/src/worker/runtime.ts`（58 行） | 需并入 `packages/agent-core/runtime` 并补模型注册/token 统计 |
| 现有 kb 工具（直调 handler 先例） | `server/src/worker/kb-tools.ts`（290 行） | 复用模式到其余工具 |
| 服务端入口（仅 REST，无流式） | `server/src/index.ts`（Fastify + multipart） | 需注册 SSE 路由 |
| 会话表（客户端权威镜像） | `server/src/db/sessions.ts`（265 行）、`server/src/routes/sessions.ts`（130 行） | 权威反转 |
| 客户端会话/prompt 源 | `electron/lib/pi-session.ts`（1478 行）、`pi-runtime.ts`（401 行）、`agent-prompts.ts`（123 行） | 抽取来源 |
| 客户端同步（将下线） | `electron/lib/session-sync.ts`（198 行） | 权威反转后下线 |
| 压缩上移来源 | `electron/lib/daily-summary.ts` L159 | 迁 server |
| 副本坏味道 | `server/src/worker/recording-prompt.ts` ↔ `electron/lib/recording-prompt.ts` | 合并为一份 |

## 四、验收标准

1. 孩子对话在 server 完整跑通：流式 token、thinking、工具调用与结果、上下文压缩。
2. 客户端进程关闭后 server 会话不丢；重新打开客户端可完整回看。
3. 同一 childId 两个客户端：一个可「接管」继续对话，另一个自动降级只读。
4. server 不可达时客户端**显式错误 + 禁用对话**，无本地兜底路径（红线验证）。
5. `packages/agent-core` 内 `grep -r "electron"` 为空；`recording-prompt` 仅存一份。
6. server `tsc` 0 错 + 客户端 build 通过 + 既有 worker 冒烟脚本（`server/scripts/worker-*-check.mts`）全过。

> 范围说明：资料页工具（`page_inspect`/`page_action`）的**传输层改造属 P3**（见设计 §4/§6），不在 P1；P1 只需把 `bridge/` 模块（信封常量 + `formatPageEvent`）抽进共享包，避免后续再动。

## 五、红线

- 不双跑（client 不得留任何 agent/LLM 路径）；
- 不静默降级；
- 隔离不放松（`parentId`+`childId` 路径与数据沙箱，逐条对照 ISSUE-023）。

## 六、关联

- ISSUE-080（定案与设计来源）、`DESIGN-server-agent-migration-2026-09-12.md`
- ISSUE-028（worker/runtime/kb-tools 基建）
- ISSUE-023（隔离教训）、ISSUE-056（副本漂移教训）

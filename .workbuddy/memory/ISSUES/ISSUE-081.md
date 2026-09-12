# [ISSUE-081] P1：agent 服务端化·会话权威上移 + 持久会话 + SSE 流式（分水岭）

- **类型**：架构 / 实施（承接 ISSUE-080 §七定案）
- **优先级**：高
- **状态**：**P0 + P1 + P2 + P3（三批全部）+ P4 客户端瘦身 已实施（2026-09-12）**；web/手机端 `window.api` 适配层、客户端会话镜像通道下线、家长侧排期/考核/积分工具上移为后续增量（用户定范围「P4 只做客户端瘦身」）
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
- **考核 LLM 上移**（`electron/lib/exam-engine.ts` 的选课 LLM / 出题 / 判分；server 现有 exam 路由只有数据层）。→ **已实施，见下**
- **`programming-agent` 上移**为 server 端子 agent（由 server agent 调用）。
- **课程会话 / 场景会话语义**的完整平移（当前孩子会话是单会话形态；课程级 prompt 注入与 scene 专用会话属下一批）。
- 客户端尚未切换到服务端 agent（P4）。

---

## 〇之四、P3 第二批：考核 LLM 上移（2026-09-12）

**已落地**：
- `server/src/agent/exam-engine.ts`：出题与判分两条链路自客户端 `exam-engine.ts` 上移。
  - 出题：只覆盖**非结构化课程**（题库无挂题的课）——结构化课程本就走 `assess-selection.ts` 的题库直出，无需 LLM；prompt 组装抽为纯函数 `buildCourseGenerationPrompt`。
  - 判分：逐题并发（上限 3）、判分口径取服务端 `buildScoringPrompt()`；**带选项的选择题走本地规则判分**（`judgeChoice`，识别不清才交 LLM 兜底）；prompt 组装抽为纯函数 `buildScorePrompt`。
  - **选课 LLM 不迁**：2026-09-09 起固定档已改为「计划周期内必学课全考」的内置规则，LLM 选课已废弃（server 侧注释亦如此标记）。
  - 审计：服务端 `exam-audit/<childId>/<YYYYMMDD>.jsonl`；**prompt 原文默认不落盘**（`EXAM_AUDIT_PROMPTS=1` 才写入），避免把长文本无意义落库。
- `server/src/routes/exam-agent.ts`（feature `exam_agent`）：
  - `POST /api/v1/exam/agent/generate` { childId, topicName, courseTitle, childName? } → { questions }——**输入只给标识**，课程配置（知识点详情/主题考核方法）由服务端 `fetchCoursesWithKnowledgePoints` 取真源拼装；找不到课程返回 404 并提示核对课程名。
  - `POST /api/v1/exam/agent/grade` { childId, answers } → { perQuestion, overall }——**判分口径不接受客户端传入**（否则家长可编辑口径会被客户端覆盖，出现同答案不同分）。
  - `GET /api/v1/exam/agent/scoring-prompt`：只读展示当前判分口径。
- `fetchCoursesWithKnowledgePoints` 由 routes/exam.ts 导出复用。

**验证**：typecheck 0 错；新增 `scripts/exam-agent-check.mts` **30 项全过**（JSON 提取容错 5 / 选择题规则判分 6 / prompt 组装 11 / 审计落盘 3 / 路由 401-403-400-404 与「选择题不经模型即判出」/ 版本协商）；`agent-session-check`(44)、`parent-agent-check`(27)、`worker-catchup-check` 回归全过；esbuild 产物 16.7MB（v0.4.0）。

**P3 剩余**：`programming-agent` 上移；课程/场景会话完整语义平移；客户端切换（P4）。→ 见下「〇之五」；仅剩 P4。

---

## 〇之五、P3 第三批：programming-agent 上移 + 课程/场景会话语义（2026-09-12）

**已落地**：
- `server/src/agent/programming-agent.ts`：自客户端 `programming-agent.ts` 上移。
  - 独立会话（不共享上下文）、按 sessionKey 复用、只做代码生成（read/write/edit）、模型取家长设置的「编程 agent 模型」（**未配置即明确报错，不静默回退**）、输出路径沙箱（`materials/...` → 家长资料真源 / 其它 → 工作区）、扩展名校验（仅 .html/.htm）、落盘非空校验（≥100B）。
  - 暴露两个工具：家长侧 `parent_build_material`（产出到资料真源）、孩子侧 `create_html_lesson`（产出到孩子工作区）——共用同一编程 agent 与协议 prompt，分开命名让模型一眼看懂产出归属。
- **会话类型**（`session-registry.ts`）：`main` / `scene` / `course:<课程名>` 三种，各自持久落盘（`agent-sessions/<pid>/<childId>-<kind>/`）、互不污染上下文。
  - 场景会话：工具表收窄为 `display_content + scene_command + get_date`（不挂 kb/文件/出题），prompt 为「游戏主持人」口径（`buildServerScenePrompt`）。
  - 课程会话：注入该课上下文块（教法/教学文案/考核要点/已有资料路径，取自家长库 `courses` 真源），工具含 `create_html_lesson`。
  - 路由 `POST /api/v1/agent/:childId/prompt` 支持 `session` 参数（main/scene/course:…）；SSE 仍按孩子聚合（客户端订阅一个流即可收到全部会话事件）。
  - `sessionSlot()` 把课程名里的冒号等转成连字符，避免非法路径段。

**验证**：typecheck 0 错；`agent-session-check.mts` 扩到 **54 项全过**（新增 9 项：场景/课程工具表、sessionSlot 路径安全、场景 prompt、编程工具命名/拒绝非 html/拒绝越界/未配置模型明确报错）；`parent-agent-check`(27)、`exam-agent-check`(30)、`worker-catchup-check` 回归全过；esbuild 产物 16.75MB（v0.4.0）。踩坑：注释里 `kb_*/`、`page_*/` 的 `*/` 会提前闭合块注释 → 已改为 `kb_* /`、`page_* /`。

**P3 全部完成；剩余 = P4**（客户端瘦身 + web/手机端 `window.api` 适配层 + 客户端 agent 与镜像通道下线 + 家长侧排期/考核/积分工具上移）。

### P3 补漏（2026-09-13）：孩子 agent 缺计划域/教学方法工具
联调发现孩子 agent 问「今天学什么」答不上——P3 上移漏掉了旧客户端工具清单里的 plan_* / parent_content / child_self_info，且「今日计划」旧架构靠会话创建时 `getTodayPlan` 注入 prompt（服务端未注入）。修复（commit `2f57334`）：新增 `get_today_plan`（查当日三域计划）+ `parent_content`（查家长库教学方法），主会话挂载。遗留：child_self_info 数据源缺失（children 表仅 name）、plan_study/life/exam 与 schedule_task 未上移、AGENTS 用户版残留「todolist」旧文案、create_html_lesson 编程 agent 落盘失败待查。

---

## 〇之六、P4 客户端瘦身（✅ 已完成，2026-09-12）

用户定范围：**只做客户端瘦身，web/手机端先不做**；执行方式「直接切薄客户端」。

**已落地（分批 commit）**：
- `electron/lib/server-agent-client.ts` 薄客户端核心适配层——SSE 解析（`parseSseChunk`）、事件→渲染层 `pi:*` 通道翻译（`translateAgentEvent`，契约不变）、`streamChildAgent`/`streamParentAgent`/`promptChild`/`promptParent`/`postPageEvent`/`postPageResult`/`examGenerateCourse`/`examGrade`。新增 `pi:display_content` 通道。
- 服务端补「模型/密钥/app_settings」路由（`/api/v1/models/*`），设置页 handler 接线走服务端。
- 孩子/家长/场景/考核四类对话主链路全部切服务端；会话重置/历史回填读服务端。
- **收尾（commit `5ea8fd6`）**：删 8 个本地 agent 模块（pi-session/pi-runtime/exam-engine/parent-vision/programming-agent/custom-tools/daily-summary/recording-prompt）+ 12 个仅测本地 agent 的测试；`scheduler.ts` 移除本地 recording 调度、`runSessionReset` 改走服务端 `resetChildSession`；`main.ts` 移除 `disposeAllSessions`；`formatLocalDate` 迁独立 `electron/lib/dates.ts`。

**验证**：客户端 build 全绿；`test/server-agent-client.test.ts` 15 项全过；vitest 全量 238 通过 / 11 失败均为改动无关既有失败（mastery 已下线、assessment `aliyun-kid` 缺失、assess-guide 内容漂移、page-bridge 已知 2 项）。完整链路需 201 联调（本环境无服务端+key，无法 E2E）。

**后续增量（非本批）**：web/手机端 `window.api` 适配层；客户端会话镜像通道下线；家长侧排期/考核/积分工具上移；渲染层 `pi:display_content` 订阅 + MaterialsPanel 改接推送；prompt 图片上送（孩子/家长）。

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

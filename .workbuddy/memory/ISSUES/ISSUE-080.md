# [ISSUE-080] 设计讨论：把 agent 从客户端迁移到 server 端（客户端专注显示）是否更优

- **类型**：设计讨论（架构权衡，非 bug；与 ISSUE-054/062 同类）
- **需求（用户 2026-09-12 原话）**：评估一下，把 agent 从客户端转移到 server 端，因为文件数据都在 server 端，这样架构上是不是更好？客户端专注于显示？
- **优先级**：—（讨论定案后再排期）
- **记录时间**：2026-09-12

---

## 一、结论（先说答案）

**不建议「全量迁移」，建议「按 agent 分治」：**

| Agent | 建议 | 核心原因 |
|---|---|---|
| **孩子 agent** | **留在客户端** | 工具执行面天然在客户端：display_content→MaterialsPanel、TTS 朗读、录音/语音评测、浏览器面板预览、媒体转码——这些没法上服务端，硬迁会逼出「工具回传协议」（server agent → 客户端执行 UI/音频工具），复杂度远超收益 |
| **家长 agent** | **可迁，且收益真实**（中期候选） | 工具面 ~80% 是服务端数据操作（材料/课程/排期/考核/积分），正是 ISSUE-079/078/055/056 整类问题的根源；服务端 pi runtime + worker 基建已在（ISSUE-028） |

**判据：agent 的位置应由「工具执行面」决定，而不是「数据真源在哪里」。** 数据在服务端 ≠ agent 必须在服务端——只要工具能高效访问真源即可。

---

## 二、正反论据盘点

### 迁移的吸引力（真实存在）

1. **根治一整类 issue**：079（家长 agent 缺 list/read/delete/move）、078（附件路径剥前缀 + 未透传 pid）、055（缺上传工具）、056（上传纪律）——全是「agent 在客户端、真源在服务端」造成的跨机 impedance。agent 上 server 后工具直调本地 FS/DB，这整类问题消失。
2. **工具治理单点**：prompt、工具注册、activity log、危险操作审计集中一处，不再客户端/服务端两套纪律（ISSUE-056 就是两套纪律漂移的产物）。
3. **多端共享**：家长 web 端（pi-web 方向）、手机端可复用同一个家长 agent；会话真源统一，跨设备续聊成立。
4. **模型 key 收敛**：apiKey 已在服务端 AES-256-GCM 加密（ISSUE-028 任务5），agent 上 server 后客户端不再需要持有 key 直连模型。
5. **先例已验证**：ISSUE-028 无头 worker 已把 pi runtime（providers/runtime/kb-tools/tasks/scheduler）跑通，服务端跑 agent 不是从零开始。

### 迁移的代价（同样真实）

1. **孩子 agent 的客户端工具无法上移**（最重的一条）：display_content、TTS 播放、按住说话录音、语音评测音频采集、浏览器面板预览、H.264 转码——全要设备/UI 上下文。全量迁移 = 需要「服务端 agent 回调客户端工具」的双向协议（类似 MCP 反向通道），新增：断线重连、客户端离线时工具不可用的会话语义、每轮工具往返延迟。**这个复杂度比现在「给服务端数据补工具封装」高一个量级。**
2. **可用性单点**：孩子学习场景要求高可用（放学固定时段）。agent 全在 201 → 201 宕机/重启/断网 = 学习完全中断；现状客户端直连模型 + 本地数据兜底，服务端只影响同步。另外家庭服务器从外网访问需 frp/公网映射，孩子在爷爷奶奶家等情况直接不可用。
3. **链路延迟**：客户端→201→DeepSeek 多一跳 + 工具执行往返。流式可解，但每轮 tool loop 的感知延迟会上升。
4. **会话基建迁移**：现状会话按 childId 落客户端、增量同步上云且**客户端权威**（ISSUE-028 设计）；agent 上 server 意味着权威反转（server 权威），家长/孩子两套会话存储、autoNewSession、resetLeaf 语义全部要迁，刚修完的 ISSUE-023 隔离体系要重做。
5. **传输安全**：LAN HTTP 明文（028 已知注意点）。家长 agent 对话含家庭隐私与教育规划，上 server 前须先补 HTTPS/token，否则多一整类泄露面。
6. **服务端沙箱**：server agent 执行文件工具 = 服务端要按 parentId 做路径沙箱与并发隔离（现在客户端天然按机器隔离）。

### 反直觉点：ISSUE-079 的更便宜解法

079 的根因不是「agent 位置错了」，而是「真源在服务端、工具封装没跟上」。两个量级差距巨大的解法：
- **便宜**：补齐 4 个工具封装（079 方案 A，几天）；或更进一步做**一个通用 `serverFS` 工具**（list/read/write/delete/move 五动作、按登录 parentId 做路径沙箱），一个工具替代 parent_* 系列继续膨胀，078/055 同类问题一并终结。
- **昂贵**：迁移整个 agent（上述全部代价）。
**在家长 agent 迁移发生之前，079 仍应按方案 A 落地**——即使将来迁移，这套服务端工具函数也会被 server 端 agent 复用，不白做。

---

## 三、分阶段路线建议

| 阶段 | 动作 | 触发条件 |
|---|---|---|
| **现在** | ① 按 079 方案 A 补家长工具（先修 078）；② 设计通用 serverFS 工具替代零散封装膨胀 | 无（079 已立项） |
| **中期候选** | **家长 agent 迁 server**：复用 028 worker runtime，加交互式 SSE 会话端点 + 服务端工具集；家长会话上云从「客户端权威」翻转为「server 权威」；前置补 HTTPS/token 与 parentId 路径沙箱 | 出现真实多端需求（家长要在 web/手机上和 agent 聊、制作资料） |
| **长期** | 孩子 agent 是否迁，看工具回传协议的成熟度与家庭服务器可靠性 | 暂不评估 |

### 家长 agent 迁移的前置盘点（若立项）

1. 家长 agent 全量工具真源盘点：哪些已是服务端（materials/courses/study_plans/assess），哪些还在客户端 parent.sqlite——客户端真源部分需先上收，否则迁移后 agent 读不到。
2. 客户端特有工具的替代：parent_transcribe_media（API 型，server 可跑）、parent_read_image（视觉 API，server 可跑）、create_html_lesson（生成后 upload，server 可跑）——确认无硬 UI 依赖。
3. 传输安全先行：HTTPS 或 LAN token 签名。
4. 会话迁移与隔离：per-parentId 会话目录、autoNewSession 策略、家长对话回顾（SessionReview）改读 server 真源。
5. 客户端退化路径：server 不可达时家长 agent 降级为只读/禁用并显式提示（不许静默失败，网络失败显式 UI 错误的既有原则）。

---

## 四、关联

- ISSUE-028（服务端无头 worker 已就位——本讨论的基建前提）
- ISSUE-079（家长 agent 缺服务端数据工具——迁移前仍按方案 A 落地，工具函数将来可复用）
- ISSUE-078 / 055 / 056（同属「agent 在客户端、真源在服务端」的跨机 impedance 家族）
- SPLIT-REQUIREMENTS.md / DESIGN-SPLIT.md（现有拆分边界）

---

## 五、补充讨论（2026-09-12 19:22）：孩子端多设备需求确认，结论修订

**用户新信息：孩子也需要通过 web、手机或其他设备使用这套系统。** 多端不再是「家长的中期可能」，而是「孩子端的确定需求」→ 触发了原表中「长期才评估」的孩子 agent 迁移条件。结论修订如下。

### 修订结论

**服务端 agent 成为战略目标架构（家长+孩子都迁）；孩子的 UI/音频工具不是迁移动手前就无解的障碍，关键在于把「工具」重新归类为「输入事件」与「输出推送」两类，多数不需要双向工具回传协议。**

### 孩子 agent「客户端工具」的重新归类（关键推演）

| 现有工具/能力 | 归类 | server-side 形态 |
|---|---|---|
| `display_content` → MaterialsPanel | **输出推送**（非 UI 回调） | agent 在 server 写「会话材料存储」；各设备 MaterialsPanel 订阅推送渲染（面板本就跨重启持久，改为 server 真源 + 多端订阅） |
| TTS 朗读（聊天/资料页） | **输出推送** | server 合成音频（Edge TTS 本就 API 型）→ 客户端播放 + 缓存；音色/语速偏好随 childId 配置上 server |
| 按住说话录音（语音输入） | **输入事件** | 客户端采集 → 上传音频 → server 跑 ASR（transcribe 本就是 API 型）；不是 agent 工具 |
| 语音评测（SSECP 发音跟读） | **输入事件 + API** | 客户端浏览器 MediaRecorder 采集 → 上传 → server 调评测 API；采集端从 Electron 换成浏览器/手机录音组件 |
| `page_inspect` / 浏览器面板预览 | **设备绑定工具（少数派）** | 保留客户端执行；用「**设备能力协商**」解决——客户端连接时上报能力集（有无浏览器面板/麦克风），server 按能力集裁剪 agent 的工具表 |
| 媒体转码（H.256 纪律等） | server 更合适 | 本就该上 server |

**真正需要双向回传的只剩 page_inspect 一类少数工具** → 用能力协商 + 可选客户端工具通道覆盖，不是全量协议负担。

### 修订后分阶段路线

| 阶段 | 动作 | 说明 |
|---|---|---|
| **P0（现在）** | 079 方案 A 落地（先修 078 ✅已完成） | 服务端工具函数将来 server 端直接复用，不白做；同时评估通用 serverFS 工具 |
| **P1（基建）** | **会话权威上移 server**：per-childId 会话真源落 server（028 的 sessions 表已是镜像底子，翻转为权威）；各设备无状态 attach | 多端续聊的地基；客户端只做输入采集 + 渲染 |
| **P2（家长 agent 先迁）** | 复用 028 worker runtime + SSE 交互端点 + 服务端工具集；成本最低、验证整套交互 agent 上 server 的模式 | 跑通后孩子端照抄模式 |
| **P3（孩子 agent 迁）** | 按「输入事件/输出推送」重归类改造：materials 推送、TTS server 合成、语音输入上传、能力协商工具表；考核语音作答换浏览器录音 | 前置：P1/P2 完成 |
| **可用性（贯穿）** | 201 单点缓解：ECS（www.aixuexihao.top 已有）作外网中继/备份入口；server 不可达时客户端显式降级（禁用对话+提示，不静默失败） | 在家走 LAN 低延迟，在外走中继 |

### 新增的前置依赖 / 风险

1. **实时通道**：learning-server 目前只有 REST 同步，交互 agent 需补 SSE/WS 流式端点（028 worker 是 cron 型，无流式）。
2. **多设备会话锁**：同一孩子两台设备同时对话的并发语义（建议：单活动会话 + 后连设备只读回看，或 last-write 冲突提示）。
3. **web 端 MaterialsPanel / 资料渲染**：display_content 的 html 需 web 化渲染（iframe 沙箱方案已有 MATERIAL-BRIDGE-PROTOCOL 底子）。
4. **传输安全升级为硬前置**：孩子语音/对话出家庭 LAN，必须 HTTPS（ECS 域名证书已有，201 需规划）。
5. **成本重心转移**：token/key 全部收敛 server（028 crypto 已加密），家庭带宽上行要扛音频上传。
6. **孩子 agent 的 prompt/learning-guard/会话树语义**（newSession/resetLeaf/autoNewSession）需整体平移到 server runtime，childId 隔离体系（ISSUE-023 教训）在 server 侧重做时逐条对照。

### 与第一版结论的差异声明

第一版「孩子 agent 留客户端」的判断建立在「多端=家长中期可能」的前提下；孩子端多设备需求确认后，该前提失效。但第一版的核心判据（**工具执行面决定 agent 位置**）不变——只是推演发现孩子 agent 的工具面大多可重归类为输入/输出流，真正设备绑定的工具是少数派，可用能力协商覆盖。

---

## 六、二次评估（2026-09-12 19:35）：代码实测版工程量

第二次评估不再做概念推演，直接盘代码。**结论：迁移在技术上成立，成本比第一次评估更低（契约层已现成、领域逻辑已过半在服务端）；但它是「孩子多端」的宿主前提，不是「架构更优雅」的独立理由。**

### 实测底数

| 侧 | 规模 | 关键事实 |
|---|---|---|
| 客户端 agent 侧 | `electron/lib` 44 文件 ≈ **16.3k LOC** | 大头：`custom-tools.ts` 2706、`ipc-handlers.ts` 2588、`pi-session.ts` 1478、`kb-sqlite.ts` 1120、`parent-library.ts` 969 |
| 客户端渲染侧 | `src` 53 文件 ≈ **17k LOC** | **0 处 `import electron`**；全部经 398 行 preload 契约，**280 处 `window.api` 调用 / 40 文件** |
| 服务端 | `server/src` 36 文件 ≈ **10.0k LOC**（Fastify + REST + multipart） | 考核 routes 1702、计划域 plan-domain 566 + study-plans 419、材料 246、会话 395、worker（runtime/tasks/scheduler/kb-tools/providers）≈ 1.3k |

### 有利发现（成本比预想低，4 条）

1. **`window.api` 就是现成的客户端-服务端契约**。渲染层零 Electron 依赖 → web/手机端只需实现一份「HTTP + SSE 版 `window.api` 适配层」即可复用 17k 行渲染代码；仅 `TitleBar` 等少量窗口专有件需替换。这条把「客户端专注显示」从口号变成了机械工作量。
2. **领域逻辑过半已在服务端**：考核（config/schedules/attempts/course-records/assess）、计划域、材料、进度、会话镜像——server agent 可**直调 handler**（`worker/kb-tools.ts` 已有先例：直调 `routes/db.ts` 导出 handler，不重复实现 SQL），比现在「客户端 agent → 客户端 handler → HTTP 回服务端」少一跳。
3. **prompt 已在服务端下发**：`agent-prompts.ts` 的 `fetchAgentPromptRemote` → server 本就是行为规范真源，agent 上 server 后 prompt 治理天然就位。
4. **音频侧已是 web 标准技术**：语音输入 `useAudioRecorder.ts`（MediaRecorder）、考核语音作答 `exam-template.ts`（iframe + getUserMedia + allow-same-origin 安全上下文）→ 手机浏览器可直接跑；TTS 走 edge-tts（API 型），可服务端合成、客户端只播放。

### 服务端缺口（实测，5 条为真实拦路石）

| # | 缺口 | 证据 |
|---|---|---|
| 1 | **无持久会话** | worker 用 `SessionManager.inMemory()`（`worker/tasks.ts` L111）；`session_messages` 仅客户端权威镜像（ISSUE-028） |
| 2 | **无流式通道** | `server/src/index.ts` 只有 REST + multipart，无 SSE/WS；worker 是 cron 型 |
| 3 | **worker 运行时极简** | `worker/runtime.ts` 仅 58 行（ModelRuntime.create + provider 注册 + 选模型）；客户端 `pi-runtime.ts` 401 行（provider 清单/模型注册/默认模型/token stats）需移植 |
| 4 | **无 guard / 无课程级会话语义** | worker 无 `learning-guard` 扩展；客户端 4 类会话（孩子/课程/scene/家长）+ `buildChildPrompt` 课程注入（`pi-session.ts` L284+）需整体平移 |
| 5 | **工具缺口** | 孩子 20 工具（L761）中：`read/write/edit/ls` 需 server 作用域版（替代 cwd=`data/children/<id>`）；`display_content` 需改建为「服务端材料存储 + 多端订阅推送」；`page_action/page_inspect` 为主要设备绑定项（能力协商） |

### 孩子工具面实测分类（20 项，L761）

| 类别 | 工具 | server 侧状态 |
|---|---|---|
| 已有服务端对应 | `kb_query/kb_insert/kb_update`、`get_progress`、`child_self_info`、`parent_content`、`create_html_lesson` | ✅ worker kb-tools 已实现 kb 三件套（290 行） |
| 已有服务端逻辑可直调 | `plan_life/plan_study/plan_exam`、`schedule_task`、`summarize_conversation`、`get_date` | ✅ plan-domain 566 / study-plans 419 / worker scheduler 396 |
| 需新建（机械） | `read/write/edit/ls`（server 作用域） | 需做 parentId/childId 路径沙箱 |
| 需改建为推送 | `display_content` | 服务端材料存储 + 多端订阅 |
| 设备绑定（能力协商） | `page_action`、`page_inspect`、scene 会话 `scene_command` | 保留客户端执行 |

### 主要风险（与一版一致，未消解）

1. **单点可用性**：learning-server 挂 → 孩子完全无法学习（现在客户端可独立跑）。缓解：201 + ECS 中继/双实例；**不建议「双模」（client agent 与 server agent 并存）**——两套工具表维护必然漂移（ISSUE-056 就是纪律漂移的教训）。
2. **多端并发会话语义**未定（同一孩子两台设备同时对话）。
3. **上行带宽/成本**：音频上传 + 全部 token 收敛 server。
4. **传输安全**：需 HTTPS/token 强制（孩子语音出家庭 LAN）。**待确认：`/materials`、`/sessions` 路由当前是否强校验 parentId**（本次未逐条核）。

### 工程量估算（相对量）

| 阶段 | 内容 | 新增/改造量 |
|---|---|---|
| P1（分水岭） | 会话权威上移 + 持久会话 + SSE 流式端点 | ~1.5–2k |
| P2 | 家长 agent 上 server（复用 worker + 交互端点 + 家长工具 server 版） | ~1–1.5k |
| P3 | 孩子 agent（平移 pi-session 会话/prompt/guard + server FS 工具 + display_content 推送 + 能力协商） | ~2–3k |
| P4 | web/手机客户端（`window.api` web 适配层 + 去 Electron 专有件 + 响应式） | ~1.5–2k |

**合计约 +7–8k LOC（两侧合计）。**

### 二次评估的结论与推荐路径

- **判定**：迁移技术上成立；成本主要不在「搬 agent」（领域逻辑已在服务端），而在 **P1 会话权威+流式** 与 **P4 web 客户端** 两块新基建。
- **若要孩子 web/手机 → 必须做**，按 P1→P2→P3→P4 推进；P1 是分水岭，做完后 P2 是低成本模式验证。
- **过渡先手（可选）**：P0.5「只读 web 伴侣」——资料查看/进度/每日记录/对话回看，复用已有 server routes + 渲染组件，几天量级。缺点：**不含交互学习**，只能作过渡，不能作为「孩子可用手机学习」的答案。
- **不建议**：为「架构优雅」单独迁移（无多端需求时性价比为负）；双模并存（维护两套工具表）。
- **强烈建议的前置重构**：把客户端 agent 核心（会话/运行时/prompt/工具表）抽成**共享包**，server 与 client 共用一份——因为坏味道已经出现：`server/src/worker/recording-prompt.ts` 是客户端 `electron/lib/recording-prompt.ts` 的同源副本（两边各 130/139 行），继续复制就是第二份漂移源。

---

## 七、决策定案（2026-09-12 19:55，用户拍板）

**定案内容（三条，不再讨论）：**

1. **不要过渡方案**——不做 P0.5「只读 web 伴侣」这类中间态，直接迁。
2. **agent 只在 server 端**——交互 agent（孩子/场景/家长/家长内容）全部运行在 learning-server。
3. **client 不再有 agent**——客户端零 agent、零本地 LLM 调用，只负责显示、输入采集、音频播放。

**连带确认：**
- 客户端将不再持有模型 apiKey（key 全部收敛服务端，复用 ISSUE-028 的 AES-256-GCM 加密存储）。
- 服务端不可达时客户端**显式报错并禁用对话**，不做本地兜底、不静默回退（沿用既有「网络失败显式 UI 错误」原则）。
- **接受单点风险**：learning-server 是本系统的唯一 agent 宿主，201 宕机 = 无法学习（用户已知悉，不做双模）。

**客户端 agent/LLM 调用点实测清单（9 处，迁移影响面的准确定义）：**

| # | 位置 | 用途 | 归宿 |
|---|---|---|---|
| 1 | `pi-session.ts` L745 | 孩子主会话/课程会话 | → server（核心） |
| 2 | `pi-session.ts` L856 | 场景会话（scene_command） | → server（设备侧仅演出事件） |
| 3 | `pi-session.ts` L1057 | 家长通用会话 | → server（P2 先做） |
| 4 | `pi-session.ts` L1115 | 家长 content 会话 | → server（P2） |
| 5 | `exam-engine.ts` L72 / L208 / L440 | 选课 LLM / 出题 / 判分 | → server（考核完全上移；server 现有 routes/exam 仅数据层，无 LLM） |
| 6 | `daily-summary.ts` L159 | summarize_conversation 上下文压缩 | → server |
| 7 | `parent-vision.ts` L82 | 图片理解（视觉） | → server（视觉 API 型） |
| 8 | `programming-agent.ts` L97 | ISSUE-020 编程 agent | → server（与 020 一并规划） |

**据此废弃/变更的既有结论：**
- ISSUE-079 的方案 A（在客户端把服务端 material 能力封装成 agent 工具）**形态变更**：server-only 架构下家长材料工具直接是 server 端工具、直调 handler，不再需要「客户端工具 → IPC → server HTTP」的封装。079 的底层函数盘点仍然有用，但落地形态改为 server 端实现。
- ISSUE-078 的「家长 agent 读不到附件」类问题在同架构下自然消解（无跨机路径语义），但客户端上传仍要带正确 parentId，故 078 已完成的修复保持有效。
- 二次评估（§六）中的「不建议双模」与「抽共享 agent 核心包」两条**升格为实施前置条件**（不再是建议）。

**详细迁移设计**：见仓库根 `DESIGN-server-agent-migration-2026-09-12.md`（目标架构/职责边界/接口契约/共享包结构/P1~P4 阶段/验收标准/红线）。

---

## 八、设计点定案（2026-09-12 20:10，用户拍板，5 项全决）

| # | 问题 | 定案 |
|---|---|---|
| 1 | `page_inspect`/`page_action` | **保留并上移**——用户指出关键点：**资料页本身就在 server**，agent 读资料源无需设备；孩子操作仍走 PiBridge 约定格式上送 server。只需把「实时渲染态查询 / 受控操作下发」的传输从本地 IPC 换成 HTTP+SSE，客户端仍是执行端点。**早期「设备绑定工具需能力协商裁剪」的判断是误判，已修正**（详见设计 §4） |
| 2 | TTS 合成位置 | **server 合成**（edge-tts，跨端音色一致 + 可缓存），客户端只播放 |
| 3 | 上课/下课提醒 | **server 下发时间 + 客户端本地播放**（离线也能响） |
| 4 | 旧客户端兼容 | **硬断代**（server 拒绝旧版本客户端） |
| 5 | `programming-agent`（ISSUE-020） | **也在 server 端，由 server agent 调用**（server 端子 agent），不单独立项 |

**连带变更：**
- `MATERIAL-BRIDGE-PROTOCOL.md` 已加 2026-09-12 修订行：拓扑变为「页面 ↔ 客户端宿主 ↔ server agent」，**信封与动作目录不变**（页面作者无感）。
- 设计文档 §2 职责边界表新增资料页三层拆分行（内容感知=server 直读源 / 实时态=事件上行+按需查询 / 受控操作=server 发起、客户端执行端点）。
- `packages/agent-core` 增加 `bridge/` 模块（信封常量 + `formatPageEvent` 格式化 + 动作目录），`formatPageEvent` 随 agent 从客户端上移。

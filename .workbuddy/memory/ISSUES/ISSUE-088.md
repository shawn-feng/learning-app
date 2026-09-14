# [ISSUE-088] agent 上移服务端后，客户端遗留的死轮询 / 死接口（含打已删路由的 5min 会话同步）

- **类型**：架构清洁 / 死代码治理
- **优先级**：中（不是功能故障，但每 2/5/10 分钟产生无意义请求，且含一条打已删除路由的错误通道）
- **状态**：✅ 已解决（2026-09-14，删除 session-sync / sync-logger / server-features / app-config / assess-tools 及 SessionSyncPanel，main/ipc/preload/Dashboard 全解绑；云端 eventPoll 默认关闭；electron.vite 不再 bundle SDK；根 package.json 的 SDK 依赖仅剩 scripts/*.mjs 与 packages/agent-core 开发期引用）
- **记录时间**：2026-09-13
- **标签**：`client-legacy` `config-sync` `session-sync` `server-features` `死代码`

---

## 一、背景

9/12「agent 全量上移服务端」后，客户端不再持有 agent、不再持有业务库，但**若干为旧架构服务的定时通道与模块仍留在客户端**。本次核对「客户端每 2 分钟轮询拉什么」时一并查清，列出如下。

> **2026-09-13 用户定案**：**必须切换到服务端，以后客户端不再有 agent**（不再保留"服务端支持才切换"的过渡/门控判定）。因此本文中一切"能力探测 / 兼容旧服务端"性质的代码都应**直接删除**，而非降频或保留降级分支。

## 二、客户端现存周期性网络请求（现状）

| 频率 | 位置 | 请求 | 用途 / 结论 |
|---|---|---|---|
| **2 min** | `config-sync.ts`（登录后启动，登出停止） | `GET /config/revision`，变化时 `GET /config` | **仍需要**：拉本家长 `auth` / `app_settings` / `scheduler_config` 落本地文件。见 §三 逐项判断 |
| **2 min**（默认开启，per child） | `scheduler.ts` 的 `eventPoll` → `delivery.ts` → `sync-manager.apiCall` | 云端 `GET /api/sync/deliver/:childId`、`GET /api/sync/progress/:childId` | **遗留**：ISSUE-041 时期的「云端只做消息交换」通道（分配包 / 进度摘要），指向**云端**（`getCloudApiBase()`），与现在的自建服务端 + 服务端 agent 架构不同源。默认 `enabled: true, intervalMinutes: 2` |
| **5 min**（+ 每轮对话后 + 退出前） | `session-sync.ts` | `POST /sessions/:childId/sync` | **死通道**：该路由**已在本轮删除**；且客户端已无本地 agent 会话可同步（会话只在服务端 `agent-sessions/`）。仅当本地还残留旧 jsonl 时才会真正发请求（否则 `collectDeltas` 为空直接 return） |
| **10 min** | `server-features.ts` | `GET /version` | **死轮询 + 应删**：`hasServerFeature()` 全仓**无任何调用方**（迁移时消费者已删），拉回来的 features 没有任何人用；且按定案不需要"能否切换"门控 |
| 1 min（本地） | `scheduler.ts` cron | 无网络（除上面的 eventPoll 段） | 本地课程时间段提醒 / autoNewSession 热会话重置 / 本地备份 → 仍需要 |
| 24 h（本地） | `main.ts` | 无网络 | 本地 kb lint，仍需要 |

## 三、2 分钟 config 轮询拉到的信息，客户端还有没有用

| 落地文件 | 客户端现存消费方 | 结论 |
|---|---|---|
| `auth.json`（模型 API 密钥，服务端解密后明文下发） | 本地语音链路：`voice/voice-config.ts`、`voice/providers/qwen.ts`（ASR）、`qwen-tts.ts`、`mimo.ts`、`mimo-tts.ts` 均 `JSON.parse(getAuthPath())` 取 key | **仍有用**（ASR 仍本地运行、TTS provider 本地直连）；也是多设备密钥同步的唯一通道 |
| `scheduler-config.json` | 本地 cron：`classTemplates/classWeek` 课程提醒、`autoNewSession` 热会话重置、`backup`、`eventPoll`；同时保存时 `pushConfig` 上云给服务端 worker（recording 时间点） | **仍有用**（本地提醒/重置/备份都要读它） |
| `app-settings.json` | 仅 `getMaterialsLimit()` 仍被真实消费（孩子模式「学习资料」列表上限，经 IPC 读取）。`defaultModel/programmingModel/visionModel` 的本地 getter **只剩 `app-config.ts` 这个孤儿模块**在用 | **部分有用**：模型字段客户端已无消费方（模型由服务端 `app_settings` 决定）；`materialsLimit` 是**纯本地 UI 偏好**，本不该跨设备同步 |

> 说明：config 轮询是**双向**的——保存时 `pushConfig` 推送；拉取后还会执行 `reconcileMissingSecrets` 把「本地有、服务端缺」的 auth provider 与模型字段**反向补传**。

## 四、建议处理（待拍板）

1. **删除 5min 会话同步**（最高优先，含 `startSessionSyncTimer` / `flushSessionSync` / 每轮对话后的即时同步挂钩 / `sync-logger` 相关调用），因为对应服务端路由已删、客户端也无源数据。
2. **直接删除 10min `/version` 能力探测**：按 2026-09-13 定案（必须切服务端、客户端永不再有 agent），不再需要「服务端是否支持 worker / 能否切到服务端 agent」的门控 —— `server-features.ts`（含 `refreshServerFeatures` / `hasServerFeature`）整体删除，`main.ts` 的启动调用一并去掉。（原方案"改为登录拉一次"已作废。）
3. **删除 `electron/lib/app-config.ts` 孤儿模块**（无人 import），并评估 `app-settings.ts` 里已无消费方的 getter。
4. **评估云端 eventPoll 通道**：若 ISSUE-041 的云端消息交换（分配包/进度摘要）已被自建服务端取代，应关闭默认开关或整体下线；否则至少把默认 `enabled` 改 false，避免每 2 分钟无意义打云端。
5. **评估 `materialsLimit` 是否还需要上云同步**（纯本地 UI 偏好，跨设备同步意义不大）。
6. **清理客户端残留的 agent SDK 依赖（与"客户端零 agent"定案直接冲突）**：
   - `electron/lib/app-config.ts`、`electron/lib/assess-tools.ts` 仍 `import { defineTool } from "@earendil-works/pi-coding-agent"`，且两者**全仓均无引用**（assess-admin 才是活的，由 IPC 动态 import）。
   - 根 `package.json` 仍依赖 `@earendil-works/pi-coding-agent: ^0.84.1`，`electron.vite.config.ts` 仍把它列为 external。
   - 迁移设计（`DESIGN-server-agent-migration-2026-09-12.md` §164）的验收标准本就是「客户端零该依赖、package.json 可移除」——尚未达成。
7. **同步 `ARCHITECTURE.md`（架构真源失修）**：§8 主进程模块表仍列已删除的 `pi-session.ts` / `pi-runtime.ts` / `custom-tools.ts` / `exam-engine.ts` / `assessment/`，组件表仍列已移除的 `AgentPromptEditor`；§10 仍写「发音评测在客户端主进程本地评测、服务端 assessment 已删除」（实际 2026-09-13 已迁回服务端）；§11 仍写「ASR/TTS/agent 会话都在 app 壳」（agent 已在服务端）。

## 五、关联

- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §2（配置下发与轮询）、§9.2（会话索引；客户端不再同步会话）。
- 本轮已删除的服务端旧同步入口：`POST /api/v1/sessions/:childId/sync` + `appendAndIndexSession`（服务端已清，客户端未清）。
- `DESIGN-server-agent-migration-2026-09-12.md`（P4 薄客户端目标：客户端零 agent、不持有业务库）。
- 代码真源：`electron/lib/session-sync.ts`、`server-features.ts`、`config-sync.ts`、`scheduler.ts`（eventPoll 段）、`delivery.ts`、`sync-manager.ts`、`app-config.ts`。

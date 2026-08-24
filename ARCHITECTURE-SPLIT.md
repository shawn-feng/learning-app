# 学习伙伴 · 前后端分离架构方案

> 目标：把当前「Electron 一体应用（主进程内嵌 Pi 引擎 + React 渲染）」拆分为
> **前端（APP / 浏览器）+ 服务端后端** 两部分。
> 制定日期：2026-08-22

---

## 一、现状（已核实）

| 层 | 技术 | 关键事实 |
|----|------|---------|
| 渲染 | React 19（src/） | 通过 `window.api`（electron/preload.ts 暴露）与 main 通信；约 70+ 处 `window.api.*` 调用散落在组件里 |
| 主进程 | Electron main（electron/lib/*） | 内嵌 **Pi SDK**（`@earendil-works/pi-coding-agent`）、共享 ModelRuntime、会话管理、路径守卫、定时任务、同步、语音 |
| 语音 | Node 原生依赖 | `edge-tts`、`ffmpeg-static`、`tencentcloud asr` 均为 **Node-only** |
| 认证/同步 | Python FastAPI | 已存在 `cloud-service/`（部署阿里云 ECS `www.aixuexihao.top`）+ `benefit-auth/`（权益中台 `auth.aixuexihao.top`） |

**决定性约束（已验证）**：Pi SDK、edge-tts、ffmpeg-static、tencentcloud-asr 都直接 `require('fs')`/`child_process`，
**只能在 Node 跑，无法进浏览器**。因此「AI 引擎 + 语音」这一层**必然留在服务端（Node 进程）**，
浏览器端永远不可能直接调 Pi SDK。

---

## 二、目标拓扑

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│  前端（多端，纯展示+交互）     │        │  后端 · 服务端（Node）        │
│  ┌──────────┐ ┌──────────┐  │  HTTP  │  引擎服务 engine-server/      │
│  │ Electron壳│ │ 浏览器PWA │  │ ◀────▶│  ├ Pi SDK 会话（按 childId）  │
│  │ (厚壳)    │ │ /手机WebView│ │ (SSE) │  ├ ModelRuntime + 模型配置   │
│  └──────────┘ └──────────┘  │        │  ├ 路径守卫 / AGENTS.md 生成  │
│  共用同一套 React 代码        │        │  ├ 语音 TTS/STT（Node-only） │
└─────────────────────────────┘        │  ├ 定时任务 recording/tracker│
                                        │  └ 文件读写 / 上传落盘 / media│
                                        └───────────┬────────────────┘
                                                    │ HTTPS（复用现有云）
                                        ┌───────────┴────────────────┐
                                        │  既有 Python 云端（已部署）   │
                                        │  cloud-service: 认证/许可证/  │
                                        │    孩子数据同步 / 版本检测    │
                                        │  benefit-auth: 权益中台/OAuth │
                                        └────────────────────────────┘
```

要点：
- **前端**：一份 React 代码，同时跑在「Electron 壳」（保留本地文件选择、原生窗口、离线缓存）和「浏览器/PWA」（免安装、手机可访问）。
- **引擎服务端**：把现在 main 进程里的 Pi/语音/定时/文件逻辑**整体平移**成一个常驻 Node 服务（Fastify/Express + SSE 流式），对外用 HTTP/SSE。
- **既有 Python 云端**：不动，继续做账号/许可证/多设备同步/权益中台。它本来就独立部署在 ECS 上。

---

## 三、为什么不能「前端直接连 Pi SDK」

Pi SDK 强依赖 Node 运行时（fs、child_process、本地模型进程）。浏览器无这些能力。
所以「服务端跑引擎、前端走 HTTP」是唯一可行解；这也正好契合你「后端运行为服务端」的要求。

---

## 四、后端职责拆分（engine-server/ 新目录）

把 `electron/lib/*` 平移到此，去掉 Electron 依赖：

| 原文件 | 移到 engine-server | 备注 |
|--------|-------------------|------|
| pi-session.ts / pi-runtime.ts | engine/pi.ts | 会话、ModelRuntime、AGENTS.md |
| custom-tools.ts / extensions/learning-guard.ts | engine/ | 工具与扩展 |
| scheduler.ts / recording-prompt.ts | engine/scheduler.ts | 定时任务（服务端常驻，天然支持多端） |
| voice/* | engine/voice.ts | TTS/STT（Node-only，必须服务端） |
| sync-manager.ts | 保留调用 Python 云端 | 仍走 `www.aixuexihao.top` |
| auth-manager.ts | 拆：账号鉴权走 Python 云端；本地 childId 密码仍服务端持有 | 见第五节 |
| parent-library.ts / learning-summary.ts / kb-*.ts | engine/ | 家长库、进度、SQLite 知识库 |
| config.ts | 改为服务端配置（数据目录改服务端路径） | 数据归属服务端磁盘 |
| ipc-handlers.ts | 改写为 HTTP 路由 + SSE | 通道名 → REST/SSE 端点 |

**对外接口（HTTP/SSE）映射**（通道名保留便于对照）：
- `POST /api/session/child/:id/start` → `pi:start_child`（返回 history/materials）
- `POST /api/session/child/:id/prompt` → `pi:prompt`（SSE 推 `pi:streaming`/`tool_*`/`agent_end`/`reply`）
- `POST /api/session/child/:id/reset` → `pi:reset`
- `WS/SSE /api/session/child/:id/events` → 替代 `webContents.send` 事件流
- `GET/POST /api/children`、`/api/parent/*`、`/api/learning/*`、`/api/voice/*`、`/api/sync/*` 等一一对应

---

## 五、数据归属与隔离（关键边界）

现在孩子数据在**本地设备** `data/children/<childId>/`。拆分后：

1. **服务端磁盘成为唯一真源**：`engine-server/data/children/<childId>/`（含 `.pi` 会话、learning/、uploads/、kb.sqlite）。
2. **路径守卫不可丢**：服务端 `learning-guard` 扩展继续按 `cwd` 越界拦截；HTTP 层再加一道「childId 路由级隔离 + 路径参数白名单」，杜绝 A 孩子读 B 孩子。
3. **孩子本地密码**：原来只存本地不上云。拆分后由**引擎服务端**持有（服务端=受控环境），仍不写进 Python 云端账号库——与现有「孩子密码不上传云端」约定一致。
4. **多端一致性**：手机/浏览器/桌面同时访问同一服务端，天然共享同一份数据，比现在的「多设备文件同步」更简洁；Python 云端同步可降级为「服务端↔云备份」而非「设备↔设备」。
5. **离线**：浏览器端依赖服务端在线；若仍需「单机离线」，用 **Electron 厚壳**（壳内打包一份 engine-server 跑在 localhost）即可恢复离线能力——这正是 Electron 壳相比纯浏览器的核心价值。

---

## 六、前端改造（最小侵入）

渲染层已统一走 `window.api`（preload 暴露）。分两步：

1. **抽统一 client（先行，低风险）**：新增 `src/lib/api.ts`，把散落的 `window.api.*` 收口成 `api.child.add(...)` 等。内部目前仍调 `window.api`，但调用点已统一。
2. **切后端来源**：client 内部按环境决定走 `window.api`（Electron 壳）还是 `fetch`+SSE（浏览器连 engine-server）。渲染组件**零改动**。

这样「先抽象、后切换」可独立验证，不一次性大改。

---

## 七、分阶段迁移计划（推荐顺序，每阶段可独立交付/回退）

| 阶段 | 内容 | 风险 | 产出 |
|------|------|------|------|
| **P0 抽象** | 抽 `src/lib/api.ts`，调用点统一；功能不变 | 低 | 渲染层与通信解耦 |
| **P1 引擎服务骨架** | 新建 `engine-server/`，把 config/pi-session/voice 平移为 Node 服务，SSE 打通 `start`/`prompt`/`reset` | 中 | 浏览器可直连服务端对话（无需 Electron） |
| **P2 路由全量平移** | 其余 IPC 通道改写为 HTTP/SSE；child/parent/learning/voice/sync 全通 | 中 | 浏览器端完整可用 |
| **P3 多端前端** | 同一 React 套件打包为 Electron 壳（厚，含离线localhost引擎）与 Web/PWA（薄，连远程服务端） | 中 | 两种前端形态 |
| **P4 数据迁移** | 本地 `data/` 迁到服务端路径；Python 云端同步改为服务端↔云 | 中高 | 服务端为唯一真源 |
| **P5 收尾** | 去 Electron 内嵌引擎、补鉴权（前端登录态→服务端会话绑定）、测试与部署文档 | 中 | 架构切换完成 |

> 风险最高的是 **P4 数据归属迁移**（涉及孩子历史会话/进度/资料落盘位置改变），建议单独灰度、先做备份再切。

---

## 八、待你拍板的关键决策

1. **引擎服务端部署形态**：常驻独立进程（最快、最干净） vs 进程内嵌 Fastify（改动小但耦合）？
   → 建议：独立 Node 服务 `engine-server/`，Electron 壳以子进程拉起它。
2. **前端是否要「纯浏览器 + 远程服务端」立即可用**，还是先保 Electron 厚壳离线、浏览器作为附加形态？
3. **孩子数据归属**：确认「服务端磁盘为唯一真源、孩子密码仍不进 Python 云端账号库」是否符合预期？
4. **P4 数据迁移**是否现在就做，还是先让新旧并存、后续再迁？

---

## 九、结论

- 架构可干净拆成「前端多端 + 服务端引擎 + 既有 Python 云端」三层。
- **Pi 引擎与语音必须在服务端（Node）**，浏览器端只做展示与交互，通过 HTTP/SSE 通信。
- 现有渲染层已通过 `window.api` 统一通信，抽象一层 client 后即可零改动切换后端来源。
- 建议按 P0→P5 渐进迁移，P4 数据归属为最高风险点，单独灰度。

下一步：确认第八节 4 个决策后，我从 **P0（抽 `src/lib/api.ts`）** 开始落地。

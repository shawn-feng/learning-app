# [ISSUE-090] 客户端 SSE 桥缺 `page_cmd` 分支 → 场景课/资料页受控下行指令全部被丢弃（台词有、动作无）

- **类型**：功能缺陷（P0，回归）
- **优先级**：**P0**（英语场景课/资料页的"演出"能力完全不可用）
- **状态**：✅ 已解决（2026-09-14，`translateAgentEvent` 补 `page_cmd` 分支 → `pi:page:exec`；`pi:page:exec:result` 回执回传服务端 `postPageResult`）
- **记录时间**：2026-09-13
- **标签**：`page_cmd` `scene_command` `SSE` `场景课` `客户端桥`

---

## 一、问题要点

服务端受控下行指令（`page_cmd`）**在客户端 SSE 桥被丢弃**，到不了资料页：

1. **服务端下行链路正常**：`scene_command`（`server/src/agent/page-tools.ts`）把 `command ∈ {say,move,act,show,highlight,update}` 转成 `action = scene.<command>` → `PageBridgeHub` → `agentStreamHub.publish(streamKey, "page_cmd", {...})`（`server/src/agent/page-hub.ts`）经 SSE 下发。`page_cmd` 是 `page_action` / `page_inspect` / `scene_command` **所有受控操作的统一通道**，本身不专属场景。
2. **客户端断点在 `translateAgentEvent`**：`electron/lib/server-agent-client.ts` 的事件翻译函数（约 91–134 行）**没有 `page_cmd` 分支**，default 直接 `return null`。而消费链是 `openSse → onEvent → bridgeChildAgentEvents → translateAgentEvent` → 事件被丢弃，永远到不了 `MaterialsPanel.appCmd(action, payload)`。
3. **只有 `say` 还能显示**：字幕走的是另一条旁路——`extractSceneLines()` 从 assistant 消息里的 `scene_command` toolCall 抓 `say` 文本，经 `scene:reply` 送字幕，不依赖 `page_cmd`。

**结果**：`move / act / show / highlight / update` 全部丢失 —— 场景角色不动、不做动作、进度条不更新，即"**台词有、动作无**"。这与服务端会话日志里的 `no handler for action: scene.say` 现象一致。

## 二、影响范围

- **英语场景课**：只剩"念台词"，无法演出（角色位移/动作/登场/高亮/任务进度全失效）。
- **资料页受控操作**：`page_action` 类操作（如需宿主侧执行的动作）同样不可达。
- **回执链**：`POST /api/v1/agent/:childId/page-result` 因没有下行指令而不会产生，服务端无法得知页面执行结果。
- **性质**：P4 薄客户端迁移时"下行通道未接好"的**回归**（非新需求）。

## 三、修复方向（明确，改动集中在客户端桥）

1. 在 `translateAgentEvent` 增加 `page_cmd` 分支：把 `{ requestId, action, params }` 翻译回渲染层既有的 `pi:page:exec` 等价通道（或直接转 `MaterialsPanel.appCmd`），并接住回执调用 `POST /agent/:childId/page-result`（等价于旧的 `pi:page:exec` + 回执链路）。
2. 验证要点：跑一节场景课，确认角色 `move/act/show/highlight` 生效、`update` 更新进度、`say` 字幕照常；服务端日志不再出现 `no handler for action`。
3. 顺带核对资料页方向（`page_action` / `page_inspect`）在同一断点下是否也受影响。

## 四、关联

- 技术实现文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §4.3（资料页与 agent 交互）、§11（场景课 `scene_command` → `page_cmd`）、§17 #1（缺口清单同条，P0）。
- `MATERIAL-BRIDGE-PROTOCOL.md`（PiBridge 下行/回执约定）。
- 迁移设计 `DESIGN-server-agent-migration-2026-09-12.md`（§4：page_* 保留并上移，客户端 `page-bridge.ts` / `MaterialsPanel.appCmd` 基本不动、只换对端）。
- 代码真源：`electron/lib/server-agent-client.ts`（`translateAgentEvent`）、`electron/lib/ipc-handlers.ts`（`bridgeChildAgentEvents` / `appCmd` 分发）、`server/src/agent/page-hub.ts`（下发）、`server/src/agent/page-tools.ts`（`scene_command` / `page_action` / `page_inspect`）。

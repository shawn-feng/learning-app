# ISSUE-107：家长聊天区域重新进入后看不到当前会话历史消息（agent 服务端化把 ISSUE-039 的历史回填架空）

- **类型**：bug / 回归（家长端会话历史恢复；ISSUE-081 agent 上移服务端时引入，ISSUE-039 同症状复发）
- **描述**：家长聊天区域（家长中心右侧「家长助手」）退出 app 再进入（或切到别的管理页再回到聊天）时，**当前会话的历史消息全部不显示**，聊天框从空白开始。服务端会话落盘正常（下轮对话 agent 仍记得上下文），纯 UI 恢复链路断了。
- **现状 / 根因（已查证代码）**：
  - **根因①（IPC 硬编码空历史）**：`electron/lib/ipc-handlers.ts:1303-1310` `pi:start_parent` 只 `ensureParentStream("parent")`（仅建立 SSE 桥，不拉历史）然后 **`return { success: true, history: [] }`**——history 硬编码为空数组。孩子端同位置 `pi:start_child`（`:1295`）留有注释「历史与资料改由服务端会话/display_content 推送驱动；此处返回空（**联调点：会话历史回填**）」——ISSUE-081 迁移时把本地 SDK 读历史的旧实现拆掉、约定改由服务端驱动，孩子端后来补上了（`openChildSession`），**家长端这个联调点一直没接**。
  - **根因②（服务端无家长会话历史端点）**：`server/src/routes/parent-agent.ts` 只有 4 条路由——`GET /parent-agent/stream`（:58）、`POST /prompt`（:97）、`POST /reset`（:116）、`POST /abort`（:131）；**没有 history / open 端点**，客户端想拉也无处可拉。孩子端对应能力是 `POST /agent/:childId/open`（ISSUE-100 F1）与 `GET /agent/:childId/history`。
  - **客户端回填逻辑还在、只是永远拿到空数组**：`src/components/ParentChatPanel.tsx:68-80`（ISSUE-039 修复存留）`piStartParent().then` 里 `if (Array.isArray(r.history) && r.history.length > 0) setMessages(...)`——代码健在，但 `r.history` 恒为 `[]`，分支永不进入。
  - **同病灶**：`pi:start_parent_content`（`ipc-handlers.ts:1477-1484`，TopicDetail 教学内容生成会话）干脆连 `history` 字段都不返回，同类缺口。
- **可复用的现成设施**：
  - `electron/lib/server-agent-client.ts:462-480` `mapHistoryMessages()`——服务端原始消息 → 前端气泡（user/assistant 正文 + thinking、时间戳标签），与家长会话消息结构无关、通用。
  - 孩子端范式：`openChildSession()`（`:503-509`，POST `/agent/:childId/open`，服务端按落盘会话最后消息日期做跨天裁决后返回历史）；家长端照此办理即可。
  - 服务端家长会话落盘在 `data/agent-sessions/<parentId>/…`（session-registry / parent-registry 管辖），消息读取链路已存在（孩子 /open、/history 均走同一套读 jsonl）。
- **改造方向**：
  ① **服务端加家长会话历史端点**：`server/src/routes/parent-agent.ts` 新增（建议对齐孩子端语义用 `POST /parent-agent/open`，或 `GET /parent-agent/history`；按 token 解出的 parentId 定位会话，`kind` 区分 `parent` / `parent-content` 两 slot），返回当前会话 `messages`（role/content/timestamp）。
  ② **客户端薄桥透传**：`server-agent-client.ts` 加 `openParentSession(kind)`（调 ①并经 `mapHistoryMessages` 映射）；`ipc-handlers.ts` `pi:start_parent` / `pi:start_parent_content` 改为调它并返回真实 `history`（替代硬编码 `[]`）。
  ③ **渲染层零改动预期**：`ParentChatPanel.tsx:68-80` 回填分支已在，拿到真数据即恢复；TopicDetail 若也要恢复内容生成会话历史，同批接上（此前 ISSUE-039 边界注记「本次先修通用家长会话」）。
  ④ **与 ISSUE-100 跨天裁决的关系**：家长会话同样跨天持久累积（key 不含日期）；①若直接复用孩子端 `shouldAutoNewSession` 日期裁决口径，家长进聊天也能自动切当天新会话（可选增强，至少要明确家长端「不做跨天裁决、返回现会话全部历史」的口径，避免实现时含糊）。
- **回归**：家长发消息 → 退出/切页 → 重进历史完整恢复（含 AI 思考 thinking；工具调用气泡按孩子端现状不恢复，`mapHistoryMessages` 注释已声明）；孩子端 `/open`、/history 不受影响；`parent-content` 会话（建课引导）行为不回退；家长 agent 上下文记忆不受影响（本 issue 纯 UI 恢复链路）。
- **优先级**：中（家长日常高频路径，体验损伤明显；不丢数据、不阻塞对话功能）
- **记录时间**：2026-09-17

## 解决记录（2026-09-17）

### 落地内容
1. **服务端新端点 `POST /api/v1/parent-agent/open`**（`server/src/routes/parent-agent.ts`）：按 token 解出 parentId，`kind` 区分 `parent` / `parent-content` 两槽，返回 `{ messages }`（role/content/timestamp 原始 shape）。
   - `server/src/agent/parent-registry.ts` 新增 `getParentSessionHistory()`（读 `entry.session.messages`）与 `openParentSession()`（`ensureEntry` 续接落盘会话后返回历史——continueRecent 会从 jsonl 载入，服务端冷重启后历史同样可恢复）。
   - **口径明确：家长会话不做跨天裁决**——key 不含日期、registry 刻意不按日期自动新建（长期持续累积），进聊天返回现会话全部历史；与孩子端 `/open` 的「跨天自动新建」**有意不同**（代码注释已写明）。
2. **客户端薄桥**（`electron/lib/server-agent-client.ts`）：新增 `openParentSession(kind)`，调 ① 并经既有 `mapHistoryMessages()` 映射为前端气泡（user/assistant 正文 + thinking + 真实时间戳标签；工具调用气泡按孩子端同口径不恢复）。
3. **IPC 透传真实 history**（`electron/lib/ipc-handlers.ts`）：`pi:start_parent` 与 `pi:start_parent_content`（同病灶，原先连 history 字段都不返回）改为调 `openParentSession(kind).catch(() => [])` 并返回 `{ success, history }`——服务端旧版本 404 时兜底空数组，**向后兼容不回归**。
4. **渲染层**：`ParentChatPanel.tsx:68-80` 回填分支按预期零改动恢复；`TopicEditor.tsx`（parent-content 消费方）同批接上回填分支（与 ParentChatPanel 同构映射，含 thinking/tools；**不做** `[内部指令]` 剥离——该会话为打字输入，剥方括号会误伤课程名等正文）。

### 验证
- `server` 包 `tsc --noEmit` 0 错；`npm run build`（electron-vite main + preload + renderer）通过。
- vitest 套件 38 failed | 232 passed | 13 skipped——与改动前基线（git stash 对比跑）**完全一致**，失败均为既有环境问题（assessment/session-sync 模块解析 + 需活服务端 8788 的集成测试），非本次引入。
- 回归点核对：孩子端 `/open`、`/history` 未触碰；家长 agent 上下文记忆不受影响（纯 UI 恢复链路）；家长端「重置会话」语义（ISSUE-102 修复）不受影响。

### 未做
- **未部署 201**：服务端改动（`/parent-agent/open`）需随下次服务端部署生效；旧服务端 + 新客户端组合 = 历史仍不显示（兜底空数组，无其他影响），部署后自动恢复。
- 家长端跨天裁决（自动切当天新会话）未做——按「长期持续累积」口径维持现状，若要改再立 issue。

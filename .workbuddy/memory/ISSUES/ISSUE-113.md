# ISSUE-113：孩子会话重进后左侧资料列表清空（对话还在、资料没了）——display_content 只推不存，`pi:start_child` 硬编码返回 `materials:[]`

- **类型**：bug / 功能缺口（孩子端学习资料列表的会话内持久化；ISSUE-081 服务端化遗留「联调点」未接，与 ISSUE-107 家长历史丢失同款模式）
- **描述**：孩子会话中 AI 发了学习资料（display_content），左侧「学习资料」列表能看到；**退出再进后对话历史还在（ISSUE-100 已修），但左侧资料列表空了**。需求口径：**资料跟着会话走——只要对话还在，左侧就要显示该会话中发送过的资料；会话重置（/reset）才清空**。
- **现状 / 根因（已查证代码）**：
  - **live 路径正常**：服务端 `display_content` 工具执行时 `agentStreamHub.publish(streamKey, "display_content", {path, source, title, content, ts})`（`server/src/agent/display-tool.ts:80`）→ SSE → 客户端桥 → `Learn.tsx` 写入 materials 列表并自动展开（ISSUE-008/014 范式）。
  - **断点①（只推不存）**：display_content 事件**fire-and-forget**，服务端不持久化任何「该会话展示过哪些资料」的登记——退出后无处可取。
  - **断点②（IPC 硬编码空）**：`electron/lib/ipc-handlers.ts:1334-1335` `pi:start_child` 返回 `{ success:true, history, materials: [], materialsLimit }`——注释明写「历史与资料改由服务端会话/display_content 推送驱动；**此处返回空（联调点：会话历史回填）**」。历史那个联调点已被 ISSUE-100 F1 接上（`openChildSession` → `/agent/:childId/open`），**资料的联调点至今没人接**。
  - **客户端回填逻辑健在、永远拿到空数组**：`Learn.tsx:445-452` `if (Array.isArray(r.materials)) setMaterials(r.materials)` + `refreshStaleMaterials`——代码在，`r.materials` 恒 `[]`。
  - **有利条件**：display_content **path 必填**（`display-tool.ts:46`，只支持 .html/.htm）——重建资料列表只需要元数据 `{path,title,source,ts}`，正文渲染走现有 `materials:refresh`/文件链路，不必搬运大 content。
- **改造方向（建议方案 A）**：
  ① **服务端持久化 display 登记**：display_tool 执行推送成功后，把 `{path,title,source,ts}` 追加登记到该会话（session-registry 会话元数据或孩子库小表 `display_contents(session_key,path,title,source,ts)`）；**/reset（newSession）时清当前会话登记**，与 `pi:reset` 返回 `materials:[]`（`ipc-handlers.ts:1632`）语义对齐。
  ② **进会话返回**：`POST /agent/:childId/open`（或伴生端点）把当前会话的 display 登记一并返回；客户端薄桥加 `openChildMaterials()`（对齐 `openParentSession` 范式），`pi:start_child` 回填真实 `materials`（替代硬编码 `[]`）。
  ③ **备选方案 B（否决理由备查）**：/open 已返回消息数组，客户端/服务端扫历史里的 display_content toolCall 块重建——不改存储，但耦合会话 jsonl 内部结构（toolCall args 形状）、且跨天裁决后只看得到当天会话，历史语义模糊，不如显式登记干净。
  ④ **顺序与上限**：登记按 ts 升序回放（复现会话内出现顺序），`materialsLimit` 截断逻辑沿用；`refreshStaleMaterials` 在回填后照常跑一遍。
- **回归**：会话中 live 推送不受影响；/reset 后左侧清空 + 对话清空（现状语义保持）；课程会话 `course:<key>`（courseKey 会话）如同样有资料推送，需确认是否一并覆盖登记（display-tool 按 streamKey 推，登记应按会话 key 而非只 main）；ISSUE-021 资料刷新、ISSUE-008 自动展开行为不变。
- **优先级**：中（孩子每节课都踩：重进丢资料 → 需让 AI 重发，重复消耗 token；核心学习动线）
- **记录时间**：2026-09-18

---
**落地记录（2026-09-19）**：已实施方案 A。孩子库新增 `display_contents` 表（PK(child_key,path)，upsert 对齐 ISSUE-021「同 path 移到最新位置」）；display_tool 推送成功后登记（失败不阻断，sessionKey=会话种类 main/course:x/scene）；ensureEntry 新会话分支 + /agent/:childId/reset 端点清登记（跨天自动新建覆盖）；/agent/:childId/open 一并返回 materials（ts 升序、materialsLimit 截断，shape 对齐客户端 Material；materials 来源交给 refreshStaleMaterials 保鲜，workspace 来源直接带 content）。客户端 openChildSession 返回 {messages, materials}，pi:start_child 回填真实 materials（替代硬编码 []），scene 调用点同步。回归：live 推送、/reset 语义、自动展开、保鲜刷新均不变；测试 test/displays.test.ts 4 例全绿；全量 311 过/15 败（存量）。

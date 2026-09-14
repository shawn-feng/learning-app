# [ISSUE-087] 家长 agent 缺「添加 / 编辑孩子」能力（且明确不应暴露「删除孩子」）

- **类型**：需求 / agent 能力补齐
- **优先级**：中
- **状态**：✅ 已解决（2026-09-14，新增 `parent_child_create` / `parent_child_update`；`max_children` 上限已上移服务端校验，agent 与 REST 双路一致；密码仍由家长 UI 设置/重置，agent 不碰）
- **记录时间**：2026-09-13
- **标签**：`parent-agent` `children` `工具缺口` `权限边界`

---

## 一、问题要点

家长 agent（`parent` / `parent-content` 会话）目前在孩子管理上**只有只读能力**：

- 已挂载：`parent_list_children`（只读主库 `children` 的 `id, name`，用于把"孩子姓名"解析成 `childId`）。
- 缺失：**新增孩子**、**编辑孩子**（改名 / 头像 / 年龄 / 年级 / 兴趣 / AI 名 / AI 性格等 `profile_json` 字段）。

也就是说，家长在对话里说"再给妹妹加一个孩子""把闻闻的年龄改成 8 岁"，agent 无法落库，只能引导家长去 UI 表单操作。而孩子管理的 REST 能力本来就齐全（`POST /api/v1/children`、`PATCH /api/v1/children/:id`，见技术文档 §1.4），缺的只是 **agent 工具封装 + 挂载 + prompt 指令**。

同时用户明确**不要求**、也**不应**给 agent「删除孩子」能力（删除是破坏性操作，且当前服务端删除本身不清理孩子数据，见 ISSUE 记录中的删除缺口），保持 REST-only、由家长在 UI 显式确认。

## 二、影响范围

- **家长 agent**：无法用自然语言完成孩子的新增/编辑，体验与"计划域（study/life/exam 三域均有 create/update 工具）"不对齐。
- **一致性**：计划域已按 `parent_*` / `child_*` 前缀重构（ISSUE-084），孩子管理工具应沿用同一命名规范，如 `parent_child_create` / `parent_child_update`（**不提供** `parent_child_delete`）。
- **数据与隐私**：新增/编辑会写 `children` 表与 `profile_json`；若将来开放"编辑密码"入口，必须遵守现有 `forcePassword` 事故防护（见技术文档 §1.1）。

## 三、处理方向（仅列方案，本次不实施）

1. **新增 `parent_child_create`**：参数 `name` + 可选 profile 字段（`avatar/age/grade/interests/aiName/aiEmoji/aiPersonality`）；落库走与 REST 相同的 INSERT（`id` 由服务端生成或复用客户端 UUID 规则）。**是否允许 agent 设置孩子初始密码需单独决策**（建议不允许，密码由家长在 UI 显式设置，避免 agent 生成弱密码）。
2. **新增 `parent_child_update`**：按 `childName` 解析到 `childId` 后 PATCH 可编辑字段；**明确不包含 `passwordHash`**（遵守"无 `forcePassword` 不写密码"的防护，且 agent 不应触碰密码）。
3. **不提供 `parent_child_delete`**：删除仅保留 REST `DELETE /api/v1/children/:id`（家长 UI 确认后执行）。
4. **上限校验**：`max_children` 目前只在**客户端主进程** `child:add` 校验（服务端不校验）。若 agent 也能创建孩子，需决定上限校验放哪——否则会绕过客户端唯一的上限闸门（建议服务端 `POST /children` 补上限校验，或 agent 工具内复用同一判定）。
5. **prompt 指令**：在家长 agent prompt 的孩子管理段落补齐"可添加/编辑、不可删除"的口径。

> 决策点：① agent 是否允许设置孩子初始密码（建议否）；② `max_children` 校验是否上移服务端（不解决则 agent 创建可越过上限）。

## 四、关联

- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §1.1 / §1.4（孩子管理 REST 现状、密码与上限校验位置）。
- ISSUE-084（工具命名规范 `parent_*` / `child_*`）；ISSUE-086（孩子密码存储与文案口径）。
- 删除孩子残留数据缺口：技术文档 §17 #8。
- 代码真源：`parent-plans.ts`（`parent_list_children` 现状）、`server/src/routes/children.ts`（可复用的 INSERT/PATCH 逻辑）、`electron/lib/ipc-handlers.ts`（`child:add` 上限校验）。

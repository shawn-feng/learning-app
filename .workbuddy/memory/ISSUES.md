# 待解决问题清单 (Open Issues)

> 本文件用于记录待解决/待实现的问题，不在此处修改项目或展开讨论。
>
> **2026-08-30 重置说明**：项目已切换至「客户端 + 服务端」拆分架构（SPLIT，见 `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md`）。
> 原 ISSUE-001 ~ 052 均为旧架构（一体化 Electron「学习伙伴」应用）时期记录，已整体归档至
> `ISSUES-archive-2026-08-30.md`，不再在本文件保留。
> 本文件从空清单重新开始，只记录新架构下的问题。

## 新架构记录格式（模板）

- **类型**：bug / 需求 / 架构 / UI / 其他
- **描述**：
- **影响范围**：
- **排查/修改入口**：
- **优先级**：待定 / 高 / 中 / 低
- **记录时间**：YYYY-MM-DD

---

## [ISSUE-001] 家长界面孩子管理：孩子卡片上恢复学习进度展示

- **类型**：需求 / 功能回归（旧架构 ISSUE-019/027 曾实现家长页进度展示，SPLIT 拆分后未迁移）
- **描述**：家长界面「孩子管理」里，每个孩子卡片上要显示学习进度（如总进度 / 今日已学 / 最近学习），家长要能随时掌握孩子学习情况。当前卡片无任何进度信息。
- **现状 / 排查入口**：
  - 前端：`src/pages/Dashboard.tsx`（children 视图，`childList()` 拉列表渲染孩子卡片）——卡片无进度字段，`refresh()` 只取基础列表。
  - 服务端进度数据已存在、可复用：`server/src/routes/db.ts` 的 `kb.progress.list` / `parent_lib.progress.list`（topic_progress 视图：learned/total/next/updated），进度存服务端真源。
  - 建议：`server/src/routes/children.ts` 的 childList 聚合返回各孩子进度摘要（或新增独立接口），前端卡片渲染进度条 / 摘要；旧架构组件 `src/components/ProgressView.tsx` / `LearningDashboard.tsx` 可参考或复用。
- **优先级**：已完成（2026-08-30 实施：`children.ts` 聚合 topic_progress 返回 progress 摘要；`child-auth.ts` 透传；`Dashboard.tsx` 卡片加进度条 + 最近学习时间）
- **记录时间**：2026-08-30

## [ISSUE-002] 家长设置·定时任务：去掉「会话重置」，用「自动新建会话」即可

- **类型**：需求 / 功能移除
- **描述**：家长设置里的定时任务去掉「会话重置」（sessionReset），不再需要该功能——「自动新建会话」已覆盖其用途（跨天自动开新 + 每天定点开新），二者重叠，删除重置分支。
- **现状 / 排查入口**：
  - 前端：`src/components/SchedulerSettings.tsx:458-485`（session-reset 区块：开关 + 时/分）；:146 说明文字已注明「与每日会话重置功能重叠，二者择一即可」。
  - 配置模型：`SchedulerSettings.tsx:7` `sessionReset: { enabled, hour, minute }`，默认关闭（:38）。
  - 后端：会话重置执行逻辑（resetChildSession / runSessionReset / `pi:reset` IPC 链路）与「自动新建会话」共用调度框架，删 sessionReset 分支、保留新建会话分支。
- **优先级**：已完成（2026-08-30 实施：`SchedulerSettings.tsx` 删 UI 与配置字段；`scheduler.ts` 删 sessionReset 配置/分支/任务状态键；`pi:reset` 保留给聊天 /reset 与自动新建会话热路径）
- **记录时间**：2026-08-30

## [ISSUE-003] 家长设置·数据备份：改为服务端数据备份/恢复（zip 上传覆盖），去掉跨机进度查询

- **类型**：需求 / 架构调整
- **描述**：数据备份语义重定义：
  1. **去掉「跨机查进度」**（BackupSettings 现含该功能，旧 ISSUE-041 遗留，与 server 真源冲突）。
  2. **备份** = 把 server 端该家长的用户数据（课程 / 进度 / 生活记录等，**排除模型 API key 与登录凭证**）下载到 app 本地，打包为 zip。
  3. **恢复** = 上传这个 zip，server 用 zip 内数据**覆盖**其数据；**恢复前先对 server 当前数据做一次自动备份**（防误覆盖）。
- **现状 / 排查入口**：
  - 前端：`src/components/BackupSettings.tsx`（现为**本地** `data/` 全量 zip：一键备份 / 从备份恢复 / 定时备份 / 跨机查进度 :38）。
  - 服务端：`server/src/routes/*` 目前**无备份/恢复端点**（grep backup/restore 仅 agents.restore）——需新增：备份包生成接口、恢复上传覆盖接口、恢复前快照。
  - electron 侧备份 handler 需改为调 server 接口而非本地打包。
- **优先级**：已完成（2026-08-30 实施：`server/src/routes/backup.ts` 新增 GET /api/v1/backup（家长库+孩子 kb 打 zip）+ POST /backup/restore（multipart，恢复前自动快照 pre-restore）；`server-client.ts` 加 serverFetchBinary/serverUploadFile；`backup.ts` 改为服务端拉取/上传；`BackupSettings.tsx` 去掉跨机查进度）
- **记录时间**：2026-08-30

## [ISSUE-004] 孩子管理·分配学习主题：支持移除某孩子的某主题，有学习记录则保留记录

- **类型**：需求
- **描述**：分配主题弹窗里可以对某个孩子「移除」某个已分配主题；若该主题已有学习记录（topic_progress / 学习记录），**只解除孩子与该主题的关联（取消分配），学习记录保留在服务端不删除**；若将来重新分配，进度应能续上。
- **现状 / 排查入口**：
  - 前端：`src/components/ChildTopicsModal.tsx`（allocated map :47，分配时写每天学习量 :77/:212/:259）——目前**无移除 UI**。
  - 服务端：`server/src/routes/db.ts` 主题分配相关（topics 表 / 孩子库 topic_progress），**无 deallocate / 移除分配接口**（grep 未命中）——需新增：移除孩子库分配关系，保留 topic_progress 学习记录。
  - 注意边界：移除后孩子 agent 不再查询该主题；移除确认需二次确认（有学习记录时提示「记录保留」）。
- **优先级**：已完成（2026-08-30 实施：`db.ts` 新增 exec op `kb.topics.deallocate`（只删 topics 分配行、保留 courses/进度）；`parent-library.ts` 加 deallocateChildTopic；`ipc-handlers/preload` 加 parent:deallocate；`ChildTopicsModal.tsx` 已添加主题行加「移除」按钮（confirmDialog 提示记录保留））
- **记录时间**：2026-08-30

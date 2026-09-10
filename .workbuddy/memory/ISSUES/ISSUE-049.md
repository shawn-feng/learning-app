## [ISSUE-049] 家长端孩子管理：新增「每日记录(Daily)」标签页，左列条目 / 右显内容，默认最近 7 天 + 日期范围选择器

- **类型**：需求 / UI（家长端孩子详情页新增一个只读浏览 daily 的标签页）
- **描述**：
  1. 在「孩子详情页」（`ChildDetailPage.tsx` 的 tabs）新增一个 **「📅 每日记录」** 标签页，供家长浏览该孩子的 `daily_entries`（学习/生活/问答/任务四类记录）。
  2. **布局**：左侧一列显示 daily 条目（按日期倒序，同日期可再按 block 分组 / 按条 target 出），点击某条 → 右侧显示**该条完整内容**（raw 原文；raw 是 markdown 风格，可复用现有 markdown 渲染器，与聊天气泡一致）。
  3. **默认范围**：进入页面默认显示**最近 7 天**；顶部提供**日期范围选择器**（起止两个日期，native `<input type="date">` 即可），选定范围后重查并在左列刷新；范围外/无记录显示空态。
- **影响范围**：家长端孩子详情页（新增 tab + 新组件）；需一条「按 childId + 日期范围查 daily_entries」的渲染端可用查询链路（当前渲染端无此 IPC）。
- **现状 / 排查入口**：
  - **Tab 接入点**：`src/components/ChildDetailPage.tsx:18-26` `TABS` 数组（现含 学习进度/学习计划/学习主题/AI 提示词/考核记录/账号密码/对话回顾）+ `:110-` 各 tab 渲染分支。新增 `{ key: "daily", label: "📅 每日记录" }` 并加 `{tab === "daily" && <ChildDailyPanel childId={child.childId} />}`。
  - **数据真源**：孩子库 `kb.sqlite` 的 `daily_entries(date, block, title, raw, tags)`（`electron/lib/kb-sqlite.ts:8,86`）。查询函数 `queryDaily(childDir, q)`（`:673`，返回 `DailyEntry{date,block,title,raw,tags}`）——但 **`DailyQuery` 只支持精确 `date` / `month`(YYYY-MM) / `block` / `title` / `tag`，没有「日期范围」参数**（`:664-671`）。日期存 `YYYY-MM-DD` 文本（`:94` 有 `idx_daily_date`），范围查询需 `date >= ? AND date <= ?`（字典序即时间序，可直接用）。
  - **当前可用查询不足以支撑 UI**：
    - 家长 agent 工具 `parent_stats` 的 `daily` 分支（`electron/lib/custom-tools.ts:1057-1076`）：`date` 给定走 `kb.daily_entries.queryByDate`；**缺省"最近 7 天"是空 stub（`:1064-1068` 直接 return 空数组）**，且返回 markdown 文本而非结构化条目，**不适合直接喂 UI**。
    - 渲染端（renderer）**没有**查 child daily 的 IPC（grep preload 仅 `parent:setChildTopicDaily` 且是 ISSUE-033 前的旧设置接口，无关）。
  - **需新增渲染端查询链路（建议）**：新增 IPC `parent:childDaily`（或 `kb:dailyRange`），参数 `{ childId, from, to }` → 服务端/本地查 `daily_entries WHERE child_id=? AND date BETWEEN ? AND ? ORDER BY date DESC, block, title`，返回结构化条目数组 `[{date,block,title,raw,tags}]`。SPLIT 下 child kb 在服务端，链路走 `dbQuery`（与 `parent_stats` 同源），需在 `kb.daily_entries.*` 注册一个 `queryByRange` op（`kb-sqlite.ts` 补 range 支持或新函数）。
  - **markdown 渲染复用**：daily `raw` 为 markdown 风格文本，右栏可直接复用现有聊天气泡 markdown 渲染组件（参考 `src/components/CourseDetail.tsx:93` 单课"每一次学习/复习记录"时间线渲染 `daily_entries` 的现有做法，或 `LearningDashboard` 用的渲染器），保持样式统一；无现成"单条 daily 详情"组件，需新建 `ChildDailyPanel.tsx`。
  - **日期选择器**：项目内暂无现成"日期范围选择器"组件；最轻量 = 两个 `<input type="date">`（from/to）+ 一个"最近 7 天"按钮重置；如需更好体验可后续引入日历库，本 issue 不强制。
- **优先级**：待定（建议中——家长看孩子每日记录是高频诉求，且数据已有；主要工作量在「渲染端 range 查询 IPC + 左列/右栏组件」，不碰数据模型）
- **记录时间**：2026-09-05
- **✅ 修复落地（2026-09-05，改动集中在 server op + 渲染端查询链路 + 新组件；本地 tsc 0 错 + electron-vite build 过 + server.cjs 重建成功，未部署 201）**：
  - **数据查询（服务端）**：`server/src/routes/db.ts` `queryHandlers` 新增 `kb.daily_entries.queryByRange` op —— `requireChildId` 归属校验后 `WHERE date >= ? AND date <= ? ORDER BY date DESC, block, title`（对齐 idx_daily_date，字典序即时间序）；from/to 缺失抛 `ApiError(400)`。
  - **渲染端查询链路**：`electron/lib/ipc-handlers.ts` 新增 `parent:childDaily`（childId, from, to）→ `dbQuery("kb.daily_entries.queryByRange",{child_id,from,to})` 返回 `{success, entries}`（定义 `DailyEntryLite` 精简类型）；`electron/preload.ts` 暴露 `window.api.parentChildDaily`。SPLIT 下 child kb 真源在服务端，链路与 `learning:courseSummary` 同源。
  - **UI（新组件 + tab）**：新建 `src/components/ChildDailyPanel.tsx`——顶部日期范围选择器（from/to `<input type=date>` + 「查询」+「最近 7 天」重置，自动防 from>to 交换）+ 左列条目（服务端已按日期倒序，同日期按 block/title，4 区块 学习/生活/问答/任务 徽章配色，空态「该范围暂无每日记录」）+ 右栏选中条目 raw 原文（复用全局 `.markdown-body` + `react-markdown`+`remarkGfm`，与聊天气泡一致）。`src/components/ChildDetailPage.tsx` TABS 数组加 `{key:"daily",label:"📅 每日记录"}`（插在学习计划后）+ 渲染分支 `{tab==="daily" && <ChildDailyPanel childId={child.childId} />}`。
  - **验证**：根 tsc 仅 5 条已知环境 lib 告警（无业务错）；server tsc 0 错；electron-vite build 主/preload/渲染全过；server.cjs 重建成功；对本地真实 child kb（珊珊 `86a84278…/1f050a7f…`，737 条至 2026-09-04）实测 queryByRange SQL：2026-08-29~09-04 返回 6 条、日期倒序、block/title 归组正确、raw 可 markdown 渲染。
  - ⚠️ 与并行会话 ISSUE-049 前工作区（pi-session.ts/ChatWindow/Learn.tsx=ISSUE-050、db/sessions.ts=ISSUE-051、study-plans.ts、MEMORY.md 等）改动**尚未混提交**；本 issue 改动文件 = `server/src/routes/db.ts` + `electron/lib/ipc-handlers.ts` + `electron/preload.ts` + `src/components/ChildDetailPage.tsx` + 新 `src/components/ChildDailyPanel.tsx`。
  - **⚠️ 运行时修复（22:07）**：本地 dev 测试报 `未知查询操作: kb.daily_entries.queryByRange` —— **非代码 bug**（op 已注册 queryHandlers），是**本地 dev server（tsx src/index.ts 无 watch）在改动前已启动跑旧代码**。重启 dev server 即恢复；后台重启勿加 `| head`（SIGPIPE 风险）。已用 license token 直连 `/api/v1/db/query` 实测该 op 返回正常。
  - **➕ 增强（22:30）**：按用户要求给每日记录加**分类/标签/标题筛选**。queryByRange 增加可选 `block`(分类)/`tag`(标签，逗号包裹匹配防误中)/`title`(标题模糊 LIKE，ESCAPE 转义 %/_)；IPC `parent:childDaily` 与 preload 透传 `filters{block,tag,title}`；ChildDailyPanel 顶部筛选栏=日期范围+分类下拉(即时查询)+标签 input(datalist 联想自当前数据 tags)+标题 input(Enter/查询键应用)+「最近 7 天」重置全筛选。HTTP 实测：block=学习+title 含论语=283 条全匹配、block=生活+tag=亲情 组合精确命中。

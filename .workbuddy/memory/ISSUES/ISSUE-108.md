# ISSUE-108：家长界面可定制 Dashboard——家长自定义「孩子学习进度与情况」展示页，定制经家长 agent 完成（方案定稿建议）

- **类型**：需求 / 设计（含实施方案，待用户确认后实施）
- **描述**：家长中心目前是固定菜单（孩子管理/课程/题库/计划/考核/积分/定时任务/token/设置，`src/pages/Dashboard.tsx:30-32` view 枚举），家长想一眼看到的孩子学习进度与情况散在各页。需求：新增一个可定制的 **dashboard 页面**，展示内容/布局由家长**通过家长 agent 对话**来定制（如「给首页加一张珊珊的积分卡」「把进度卡放到最上面」）。
- **方案（建议定稿）：声明式 widget 配置 + 客户端注册表渲染 + agent 工具写配置**
  - **核心原则**：agent 只产出**受控配置 JSON**（widget 类型 + 参数的声明列表），**不生成任何自由 HTML/图表代码**——渲染安全（无注入面）、布局可控（网格约束）、agent 只需理解一个小 schema，幻觉空间最小。
  - **① 配置模型**（存服务端，per-parent）：
    ```json
    {
      "version": 1,
      "title": "孩子们的学习情况",
      "widgets": [
        { "id": "w1", "type": "child_progress", "childId": "uuid", "title": "珊珊的学习进度", "span": 1, "params": {} },
        { "id": "w2", "type": "points", "childId": "uuid", "title": "珊珊的积分", "span": 1, "params": {} }
      ]
    }
    ```
  - **② 存储（零新表）**：服务端 `settings` 表本就按家长隔离键（`{parent_id}:{key}`，`server/src/routes/config.ts:35`），dashboard 配置存键 `dashboard`（GET/PUT `/config` 现成，多设备同步白得）。不加新表、不加新存储路由。
  - **③ Widget 注册表（客户端）**：`type` 是**有界白名单枚举**，每类型一个渲染组件 + 独立数据 fetcher + loading/error 态。v1 候选（全部有现成数据源/组件，不新增后端聚合端点）：
    | type | 内容 | 数据源（现有） |
    |---|---|---|
    | `child_progress` | 课程进度概览（总数/已完成/完成率） | 孩子详情进度 tab（LearningDashboard/ProgressView）同源 |
    | `today_plan` | 当天学习计划及完成情况 | StudyPlanPanel（study_plans） |
    | `daily_recent` | 最近日常记录 N 条 | ChildDailyPanel（daily_entries，ISSUE-049） |
    | `points` | 积分余额 + 最近流水 | RewardPanel（points_balance/ledger） |
    | `recent_exams` | 最近考核成绩 | ExamRecords（exam_attempts） |
    | `task_runs` | 定时任务最近执行结果 | SchedulerTasksPanel |
    | `text_note` | agent 撰写的纯文本摘要卡（如「本周小结」，标注生成时间） | 配置内联文本，无 fetch |
  - **④ 家长 agent 工具**：`parent_dashboard_get`（读当前配置）+ `parent_dashboard_set`（整配置写入，服务端校验：type ∈ 白名单、childId 归属当前家长、widget 数量上限（如 12）、span ∈ 1~2、title 长度）。**注册时 `PARENT_AGENT_TOOL_NAMES` 白名单与 `createParentAgentTools` return 数组两处都要加**（ISSUE-089 教训）；parent prompt 加一段「dashboard 定制」说明（可用类型、参数、示例对话）。日常微调（改标题/排序/删卡）agent 直接改配置；渲染层组件日后扩充。
  - **⑤ UI**：`Dashboard.tsx` 新增 `dashboard` view，建议设为家长中心**默认落地页**（菜单第一项）。渲染：CSS grid（`span` 控制占 1/2 列），每 widget 独立取数互不阻塞；**无配置时的默认布局** = 每个孩子一张 `child_progress` 卡，附「让 AI 定制」按钮（一键聚焦右侧家长聊天并预填指令，如「帮我定制首页 dashboard：…」）。
  - **⑥ 边界（明确不做）**：agent 不产任意 HTML/JS/图表配置之外的渲染；widget 只读展示，不改任何业务数据；v1 不做拖拽手动布局（排序由 agent 按数组顺序表达）；不做后端聚合端点（每 widget 复用现有 REST，后续卡多再议）。
  - **备选方案（否决理由备查）**：B. agent 生成自由 HTML 卡片（iframe/innerHTML）——灵活但注入面/布局崩坏/调试成本高，否决；若未来需要自定义图表，走「受控图表参数」扩展 type，而非放开 HTML。C. 固定 dashboard 无定制——不满足需求本体。
- **实施拆步**：
  - **P1 服务端**：`parent_dashboard_get/set` 两工具 + schema 校验 + prompt 段（配置落 `settings` 键 `dashboard`）。
  - **P2 客户端渲染**：widget 注册表 + Dashboard `dashboard` view + 默认布局 + 「让 AI 定制」入口。
  - **P3 打磨**：agent 定制对话实测调 prompt（增删改/排序/常用话术）、空态/错误态、多孩子场景。
- **回归**：现有各管理页不受影响（dashboard 为新增 view）；家长聊天/agent 现有工具不受影响（新增两个工具）；多设备登录同一家长看到同一份 dashboard 配置（settings 上云）；未配置过的家长看到默认布局不空白。
- **优先级**：中（体验增强，需求已明确、方案待拍板）
- **记录时间**：2026-09-17

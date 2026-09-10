## [ISSUE-032] 全链路加载态：登录 / 主页 / 内容未加载完都要显示「正在干什么」，加载完再显示页面

- **类型**：UX / 加载体验（防误判数据丢失；涉及 App.tsx / Home.tsx / Dashboard.tsx / ParentLogin.tsx + 新增统一 Loading 组件/样式）
- **描述**：在孩子端和家长端，凡是有异步加载的地方都必须有明确的「正在加载」提示，**且提示文案要说明正在干什么**（如「正在加载孩子列表…」「正在验证家长身份…」「正在进入学习…」），不得只显示笼统的「加载中…」。尤其「内容还没加载完时不能把页面当成已加载」——加载完成前要么整页显示加载门控、要么区块内显示占位，**绝不能**渲染空列表让用户误以为数据丢了。核心诉求：登录家长界面、打开主页、以及任何内容未加载完的环节，都要先给提示，加载完再显示真实页面。
- **现状 / 根因（已查证代码）**：
  - **① 主页孩子列表无 loading（最致命）**：`Home.tsx:33-34` `useEffect` 调 `childList().then(setChildren)`，但在 promise resolve 前 `children` 初始为 `[]`，页面**直接渲染空头像区**（`Home.tsx:98` `children.map` 不产出任何卡片）。**无 loading 状态、无占位提示**——当 `childList()` 走服务端网络较慢（云端/局域网波动）时，用户看到空主页，**以为孩子数据丢了**。更糟：`[]` 与「真·没有孩子」无法区分。
  - **② 家长中心孩子列表同样无 loading（用户明确点名）**：`Dashboard.tsx:36-38` `refresh()` 调 `childList()` 但**无 loading flag**，pending 期间 `children=[]` →「孩子列表（点击卡片进入详情）」区（`:163`）渲染为空 → 家长看到「孩子列表没有了」，以为数据丢失。这与用户原话完全对应。
  - **③ 登录→主页过渡断点**：`ParentLogin.tsx:53-68` 登录按钮已有 `loading`→「处理中…」，登录成功 `onLogin`→`App.tsx:44 setView("home")`→`Home` 挂载后又要等 `childList()`（见①）——**这中间主页渲染空列表**，是「登录家长界面时」体验断点真正所在。
  - **④ App 初始 authCheck 有提示但信息量低**：`App.tsx:22-32` `authCheck()` 异步期间 `view="loading"`→`加载中...`(`:37`)，**有**提示，但文案笼统、且只覆盖 authCheck，不覆盖后续 childList；故初始 OK、进入 home/dashboard 后的 childList 没被覆盖。
  - **⑤ 现有 loading 零散无统一机制**：`CourseDetail.tsx:109` / `LearningDashboard.tsx:179` 已有 `.placeholder`「⏳ 正在加载…」范式；`ChatWindow.tsx:653 historyLoading` 有「加载中…」；但 home/dashboard 的孩子列表**没复用**这套，且没有「整页门控」概念。spinner 样式 `.working-spinner`(styles.css:1953) 可复用。
- **改造方向**：
  ① **主页孩子列表门控（Home.tsx）**：新增 `childrenLoading` state，`useEffect` 置 `true`、`childList().then` 后 `false`。**pending 期间渲染占位「正在加载孩子列表…」（带 `.working-spinner`）而非空列表**；仅当 `!loading && list.length===0` 才显示「还没有添加孩子」（区分「未加载」与「真·空」）。
  ② **家长中心孩子列表门控（Dashboard.tsx）**：`refresh()` 加 `loading` flag，pending 期间「孩子列表」区显示「正在加载孩子列表…」占位，loaded 且空才显示「还没有添加孩子」——直接消除用户点名的「列表没了」误判。
  ③ **统一 Loading 组件（推荐，防重复造轮）**：新增轻量 `<LoadingBlock text="正在加载孩子列表…" />`（复用 `.working-spinner` + 文案，低龄友好），或区分两种语义：
     - **占位型**：列表/区块内联显示「正在加载…」留出骨架（用于 ①②）；
     - **整页门控型** `<PageLoading text="正在进入学习…" />`：loading 期间整页覆盖显示「正在干什么…」，加载完才渲染页面（对应「加载完了，再显示页面」）——可用于登录成功→home、或 childList 整页门控。
  ④ **文案要说明「正在干什么」**：所有提示文案具体化（「正在加载孩子列表…」「正在验证家长身份…」「正在进入学习…」），避免笼统「加载中」；与用户原话一致。
  ⑤ **登录过渡**：登录成功进入 home 后由 ① 的门控兜住（home 内部先加载完再显列表）；可选在 `App.tsx setView("home")` 前后加短暂「正在进入…」整页门控，但更干净的做法是 home 内部 gate。
  ⑥ **回归**：现有 `historyLoading`/`CourseDetail`/`LearningDashboard` 的 `.placeholder`/`ParentLogin`「处理中…」不破坏；spinner 复用 `.working-spinner`；`authCheck` 的「加载中…」可升级为更具体文案。
- **⚠️ 关键原则（用户强调）**：**「加载完再显示页面」**——任何异步数据未到位时，宁可整页门控或区块占位，也**不要**把空数组当成「无数据」渲染给用户，避免「孩子列表没了 / 数据丢了」的恐慌。
- **优先级**：已实施（2026-09-02）
- **实施记录（2026-09-02）**：
  - 新建 `src/components/Loading.tsx`：导出占位型 `LoadingBlock`（复用现有 `.working-spinner`）+ 整页门控型 `PageLoading`；`styles.css` 加 `.loading-block`/`.loading-text`/`.page-loading`/`.page-loading-text`/`.working-spinner-lg`/`.avatars-loading`（主页头像区加载占位，占满一行居中）。
  - `Home.tsx`：加 `childrenLoading` state，`useEffect` 置 `true`、`.finally` 置 `false`；pending 期间在头像区渲染 `LoadingBlock text="正在加载孩子列表…"` 占位，**绝不**渲染空头像区；仅 `!loading && empty` 才显示「还没有添加孩子，请联系家长添加」。
  - `Dashboard.tsx`：`refresh()` 加 `childrenLoading` flag（try/finally）；sidebar 孩子列表与 main `view==="children"` 区 pending 期间均显示「正在加载孩子列表…」占位，loaded 且空才显示原空提示——直接消除用户点名的「孩子列表没了」误判。
  - `App.tsx`：初始 `loading` 文案「加载中…」→「正在验证身份…」（更具体）。
  - 验证：`tsc --noEmit` 对 Home/Dashboard/App/Loading 无业务错误（已过滤 @types/node26 环境告警）。
- **记录时间**：2026-09-02

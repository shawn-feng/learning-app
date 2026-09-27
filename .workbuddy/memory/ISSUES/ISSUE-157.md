# ISSUE-157：孩子端「学习进度」课程详情增强——课程页双 tab（学习情况 + 学习资料，直接看左侧展示过的资料，不用 agent 重发）+ 课程详情内上下键切换课程

- **类型**：UI / 需求（孩子端进度页钻取增强；与 ISSUE-113 display_contents 登记天然衔接）
- **需求描述（用户三点）**：
  1. 孩子端**学习进度**里也能看到展示在左侧的学习资料——**不需要让 agent 重发**（现在资料只在左侧「学习资料」面板，进度页钻到课程只看到文字字段，想再看资料得去聊天让 AI 再 display 一次）；
  2. 进度页点进课程后改**双 tab**：「学习情况」（现有 CourseDetail 内容）+「学习资料」；
  3. 课程详情里支持**上下键切换课程**，不用退回课程列表再点。
- **现状（已核实代码）**：
  - 进度钻取链：LearningDashboard（进度总览）→ drill 主题 → 课程列表 → `CourseDetail`（LearningDashboard.tsx:241，传 childId/topicDir/topicName/course/onBack）；
  - **资料的另一条完整展示通道已存在**：MaterialsPanel（左侧面板）本身就是「从磁盘/登记读资料渲染」——渲染层自己算路径+拉内容（MaterialsPanel.tsx:30 注释：display_contents 登记只存 path/title,渲染层可自取），说明**资料展示不依赖 agent 发送**，进度页复用同一能力即可；
  - `parent:readMaterial`（preload.ts:277）等读资料通道现成；courses.html_path / display_contents 表可定位资料文件；
  - 课程列表在 drill?.detail 分支（LearningDashboard.tsx:253+），CourseDetail 目前无前后课导航。
- **改造方向（建议）**：
  ① **CourseDetail 双 tab**：组件内加 tab state（默认「学习情况」保现有内容不动），「学习资料」tab 复用/抽自 MaterialsPanel 的资料渲染块（HTML iframe 渲染 + markdown 渲染 + 保鲜 key 那套，MaterialsPanel.tsx:293/300/724 已有成熟实现，抽成可复用子组件或以 props 复用 MaterialsPanel 的展示部分）；资料定位优先级：`display_contents`（该孩子该课最近推送，天然是「左侧展示过的」）→ `courses.html_path` → 手动上传区；无资料时空态提示；
  ② **上下键切课**：CourseDetail 增加 `onPrev/onNext`（或 courseList+index props,由 LearningDashboard 传入当前主题内课程列表）；键盘监听 ↑/↓（避免与页面滚动冲突：仅在非输入焦点时生效）；UI 上加前/后课按钮 + 当前位置（如 3/12）——列表顺序复用 `sortedCourseItems`（搜索过滤后**按列表顺序**切,不跨主题）；
  ③ **保持左侧「学习资料」面板不动**：两个入口（左侧面板=会话内最新资料流；进度页课程详情=按课程定点回看）并存，后者只是不再依赖 agent。
- **回归**：ISSUE-113 资料回填、ISSUE-030 资料字号（复用渲染块时 matFontSize 链路要接上）、ISSUE-017 查词浮层（资料 iframe 内选词查词在进度页 tab 里应同样可用）、ISSUE-008 自动展开行为不变；进度钻取返回链（goBack）不受 tab 切换影响；键盘切换在资料 iframe 聚焦时不劫持（iframe 内按键事件不冒泡，天然安全）。
- **优先级**：中（孩子复习动线增强；复用面大、新代码集中在 CourseDetail tab 化）
- **记录时间**：2026-09-27

---

## 实施记录（2026-09-27）

- **服务端**：`routes/db.ts` 新查询 op `kb.displays.course_materials`（child_id 归属校验）——两路定位：① `display_contents` 展示登记（全部会话种类、ts 降序、LIMIT 200）按 **登记标题==课程名 / 登记标题含课程名 / 文件名 stem==课程名 / 路径含课程名** 保守匹配，同 path 跨会话去重；② 家长库 `courses.html_path`（topic 兼容 key/中文名，同 kb.courses.get 口径）显式配置的资料**无条件收录**（排登记后、`time="课程资料"`）。正文服务端直读文件真源（`resolveMaterialFile` 新根优先/旧根兜底，材料目录双根口径与索引一致；outputs/ 页面正文取登记行）；shape 对齐客户端 Material（id/format/title/time/filePath/content/source）。**不依赖 agent 重发**。
- **electron**：IPC `course:materials`（dbQuery 透传）+ preload `courseMaterials(childId, topic, title)`；web-shim learning 域同名方法（web-shim 覆盖通过）。
- **CourseDetail.tsx 双 tab**：tab state（默认「📋 学习情况」= 原内容原样包进 fragment；「📚 学习资料」带清单计数徽标）。「学习资料」tab **整块复用 MaterialsPanel**（列表+详情两态、HtmlFrame docUrl/dataURL、ISSUE-017 查词浮层+错题上报 childId 透传、ISSUE-030 matFontSize 链路接通——Learn→LearningDashboard→CourseDetail→MaterialsPanel），onPageEvent 不转发（回看视图，左侧面板仍是 agent 互动入口）；空态提示「可以对 AI 老师说『展示这一课的学习资料』」。
- **上下键切课**：CourseDetail 新 props `courseList`（列表展示顺序 = sortedCourseItems 排序 + 搜索过滤后，不跨主题）/`onSelectCourse`；↑/↓ 键（仅非输入焦点时生效；iframe 内按键不冒泡天然不劫持）+ 头部「上一课/下一课」按钮 + 位置 n/N。LearningDashboard 传同口径列表（切课回写映射回原 CourseItem 对象）；detail 未加载时不启用。
- **测试**：`test/issue157-course-materials.test.ts` 3 用例（登记匹配+双源正文/同 path 去重/归属 403）；服务端相关回归（kb-query-progress）不受影响；根 tsc 无新增错误；双端 build 通过、web-shim 覆盖通过。
- **注**：左侧「学习资料」面板未动（会话内最新资料流），两入口并存。

---

## 实施记录二（2026-09-27，用户反馈调整）

- **点 tab 直接进资料渲染，不再进列表**：数据源 op 收窄为 `kb.courses.html_material`（原 `kb.displays.course_materials` 展示登记聚合**整体移除**，按用户拍板只取**课程配置的 html_path** 一路）：孩子库定位课程 topic_key → 家长库 courses.html_path → 服务端直读文件正文随行返回（resolveMaterialFile 双根口径 + 沙箱形状校验 .. / 盘符 / 裸文件名）；未配置/课程不在库/路径非法 → null。IPC `course:materials` → `course:htmlMaterial`，preload/web-shim 同名换（courseMaterials → courseHtmlMaterial，返回 {item|null}）。
- **去掉资料上方的标题**：MaterialsPanel 加 `bare` 模式（详情视图不渲染返回按钮行与 material-title h2，其余 iframe 沙盒/docUrl/查词浮层/错题上报/资料字号能力原样保留）；CourseDetail 以单条 Material 直喂 + `selectedId="cm-0"` 恒选中 + `bare`。
- **tab 按钮移到上一行中间**：面包屑行改三段 flex——左（返回+主题+课程名）/ 中（📋 学习情况 · 📚 学习资料，flex:1 居中）/ 右（上一课 n/N 下一课）；原独立 tab 行删除，count 徽标一并去掉（无列表概念了）。
- **测试**：issue157 测试重写为 3 用例（html_path 返回+前缀归一+正文直读 / 未配置或课程不在库→null / 沙箱形状+归属 403）；tsc 无新增错、双端 build 过、shim 覆盖过。

### 反馈现场排查补记（2026-09-27：「孩子端读不到学习资料」）

- **现象**：课程详情「学习资料」tab 显示空态「这门课还没有配置课程资料」，但家长库 html_path 明明有值（lunyu/论语学而篇第一章.html，1255/1317 门课都配了）。
- **排查**：用服务端源码 queryHandlers 直跑真实数据 → 闻闻/珊珊都正常返回正文 → op 没问题；查 server package.json `dev` 脚本 = `tsx src/index.ts`（**非 watch 模式**），本地 8788 的进程是改动前启动的旧代码，/db/query 不认识新 op `kb.courses.html_material` → 客户端 catch 后落入空态。
- **处置**：重启本地 dev 服务端（PID 33732→11332）+ 签家长 JWT 走 HTTP 全链路复验：闻闻/珊珊 200 + contentLen 4610，未订阅论语的小明正确 null。
- **教训**：**server 的 dev 是非 watch 模式，改服务端代码必须手动重启本地 dev 进程**，否则客户端新 UI + 旧服务端的组合会把「op 不存在」表现成「数据为空」。

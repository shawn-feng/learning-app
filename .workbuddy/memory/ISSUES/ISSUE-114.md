# ISSUE-114：错题/生字跟踪——把孩子学习过程中的「漏洞信号」（口述错题、不认识的字）结构化沉淀为可复习的错题本（需求分析 + 方案）

- **类型**：需求 / 设计（孩子学习闭环增强；待拍板后实施）
- **需求描述**：孩子会话里，孩子提到「做错某道题的经历」或「不认识某个字」，目前这些信号随对话流失——没有沉淀、没有复习、下次还错。需求：把这些整理出来并记录好，形成孩子的**错题/生字本**。
- **需求分析**：
  - **信号来源盘点（四类，按可靠性排序）**：
    | 渠道 | 信号 | 现状 |
    |---|---|---|
    | ① 对话口述 | 孩子说「我昨天有道题做错了」「这个字我不认识」 | 随会话流失；agent 有 summarize_conversation 写 daily_entries，但 daily 是自由文本（`kb.ts`: date/block/title/raw/tags），**无结构、无状态、无法复习** |
    | ② 查词浮层 | 在资料里选中字词查读音释义（ISSUE-017）——**查=不会的最强信号** | `WordLookupOverlay.tsx` 纯展示（props 仅 state/onSpeak/onClose），**查完不留任何痕迹** |
    | ③ 考核错题 | 考核做错的题 | 主库 `exam_attempts.wrong_questions` 已结构化存储（db.ts:202，ExamRecords 展示），但**只躺在成绩单里，无复习闭环**，也进不了孩子侧视野 |
    | ④ 口语评测 | 发音不过关的字词（speech_assessments） | 弱信号，二期再说 |
  - **需求本质**：不只是「记录」，是**闭环**——散落信号 → 结构化档案 → 复习触达 → 掌握关闭。只做记录不做复习，错题本会变坟场。
  - **关键设计决策**：谁触发记录（对话 agent 识别为主 + 显式渠道自动采）；存哪（孩子 kb，孩子自己的学习数据）；怎么去重（同一个字反复查 → 计数+时间线，正是遗忘曲线素材）；怎么标掌握（孩子确认 / 重测验证）。
- **方案（建议）**：
  ① **数据模型**：孩子 kb 新表 `mistake_book`（单表 `kind` 区分）：
    `id / kind('wrong_question'|'unknown_word'|'weak_point') / content(题干摘要或字词) / detail(正解、释义、aiComment) / source('conversation'|'lookup'|'exam') / source_ref(attempt id / 会话日期 / 课程) / question_id(可空，逻辑引用题库题，错题重做经此取原题) / course_ref(topic/course，可空) / knowledge_point_id(可空，逻辑引用家长库知识点) / knowledge_point_name(名称快照，防家长侧改删后悬挂) / count(重复次数) / status('open'|'mastered'|'dismissed') / first_seen / last_seen / mastered_at / created_at / updated_at`；去重 UNIQUE(content, kind, course_ref) 落空则 count+1 更新 last_seen——**重复出现本身就是「未掌握」的证据**。
    - **⚠️ 设计问答（2026-09-18 定）——知识点关联与题库关系**：
      - **知识点：关联但可选**。三来源不对称：C3 考核错题天然带 question_id + knowledge_point_id（per_question 逐题自带）；C1 口述 agent 能推断课程/知识点就填、推断不出留空；C2 查词生字一般不挂。价值在**按知识点聚合**（薄弱知识点视图 → 教学注入优先级 + 家长端展示）。跨库约束：knowledge_points 在 parent.sqlite、错题本在孩子 kb，SQLite 跨文件无外键——只存逻辑引用 + 名称快照（同 exam_plan_courses 存 course_uuid+course_name 的既有先例），引用悬挂不致 UI 崩。
      - **题库：不进，方向不能反**。错题是孩子私有学习数据（孩子 kb），题库是家长维护的共享内容库（parent.sqlite，全孩子共用、有 stem/answer/behavior 质量门槛）——让孩子错题流进题库 = 孩子 agent 写家长库，撞 ISSUE-105「孩子 agent 永不写家长内容库」边界，且污染共享内容。正确关系是**引用而非写入**：条目存 question_id，「错题重做」经 id 取原题复用；将来错题**统计**可反向供家长 agent 出题参考（读题库，不是写）。
  ② **采集三渠道（v1 全做，成本都低）**：
    - **C1 对话**：孩子 agent 新工具 `child_mistake_log`（写自己 kb；进 `child-db-tools` 白名单族——ISSUE-105 孩子写白名单仅 daily_entries/redemption_requests，错题本同属「孩子自己的学习记录」语义，扩白名单合理）；同一内容重复提及走 upsert。
      - **调用时机（2026-09-18 定，写进工具描述 + prompt 段）——只认「明确漏洞信号」，先教学后记录**：
        - **正面清单**：① 口述做错题（kind='wrong_question'）：孩子明确说出错误经历（「昨天有道题做错了」「这道题我上次就不会」「又错了」），记录题干摘要 + 卡住点 + 本次讲解要点；② 对话中问字词（kind='unknown_word'）：聊天打字/语音问读音释义——**与 C2 不重叠：资料内选词查走浮层（C2），聊天里口头问走 C1**；③ 表达稳定薄弱点（kind='weak_point'）：「最怕应用题」「课文总背不住」——反复表达或明确说「学不好」才记，一次性吐槽不记。
        - **反面清单（不调用）**：提问学习内容本身 ≠ 不会（「什么是比喻句」是求知，判断锚点=挫败/错误信号词：错了/不会/忘记/搞不懂/总是/又）；考核错题走 C3 自动同步 agent 不手动记（防重复）；口误玩笑；同会话已记过（工具 upsert 兜底，但不刷屏式调用）。
        - **调用时序**：先共情 + 讲解，**讲解完成后的同轮收尾时静默调用**（不打断教学节奏）；可轻轻带一句「已帮你记到错题本」——顺手转为正反馈与教学抓手（「要不要再来一道类似的？」）。
    - **C2 查词自动采**：WordLookupOverlay 查词成功时上报（REST `POST /kb/:childId/mistakes`，查词浮层加一行上报代码；服务端 upsert `kind='unknown_word'`）——零打扰、全覆盖，v1 性价比最高的一条。
    - **C3 考核错题同步**：attempt 挂接时（plan-domain `applyExamAttempts` 已逐题入 exam_plan_courses）把 `wrong_questions`/错题同步 upsert 进错题本（source='exam'，天然带 question_id + knowledge_point_id 引用）；后续重考该题做对可自动标 mastered（可选，二期）。
  ③ **呈现**：
    - 孩子端：左侧边栏新 icon 弹框「我的错题本」（ISSUE-025 todolist 弹框范式），按 kind 分组、显示次数与来源；agent 也有读工具可在对话中引用。
    - 家长端：孩子详情页新 tab 或作为 ISSUE-108 dashboard 的 widget 类型（`mistake_stats`：open 数 / 本周新增）——错题本天生是家长最想看的「学习情况」。
  ④ **复习闭环（价值所在）**：
    - 教学 prompt 注入 open 状态错题摘要（对齐 ISSUE-045 注入当天计划的机制），让 AI 老师在合适课时自然掺入复习；错题带 course_ref 时优先在对应课程会话注入。
    - 关闭路径：孩子说「会了」→ agent 小题验证 → `mastered`；家长/孩子也可手动 dismiss（记错/重复）。不做时间驱动的外部推送（避免打扰），复习交给 AI 老师在对话里完成。
  ⑤ **边界（明确不做）**：v1 不做「LLM 全文扫描对话自动判错题」——成本高、误报多，只记明确信号（口述+查词+考核）；家长对孩子 kb 默认只读（读经 ISSUE-110 P2「家长操作孩子库」通道或专用查询）；错题本不进考核/积分计算，纯学习档案。
- **实施拆步**：P1 表 + C2 查词上报 + 孩子端弹框查看（最小可用）；P2 C1 agent 工具 + prompt + 教学 prompt 注入；P3 C3 考核错题同步 + 家长端展示 + mastered 闭环打磨。
- **回归**：查词浮层展示/朗读行为不变（ISSUE-017/031）；daily_entries 与 summarize_conversation 不受影响（错题本独立表）；考核成绩/积分链路零改动（C3 只读 wrong_questions）；孩子 agent 写权限仅扩错题本一张表。
- **优先级**：中（学习闭环的核心缺口；采集端成本极低、价值随数据积累放大）
- **记录时间**：2026-09-18

---
**落地记录（2026-09-19）**：P1+P2+P3(C3 同步部分) 已实施。
- 表：mistake_book（kind/content/detail/source/source_ref/question_id/course_ref/knowledge_point_* 快照/count/status/first_seen/last_seen/mastered_at），UNIQUE(content,kind,course_ref) 去重，count+1 即「未掌握证据」，mastered 复发自动重开 open。
- C1：child_mistake_log 工具（log/list/master/dismiss，工具描述含正面/反面清单与时序契约），挂孩子 agent 非场景会话；prompt 注入：buildChildSelfBlock 附 open 错题摘要（top8），agent 复习触达。
- C2：WordLookupOverlay 加 onReport（浮层展示即上报一次，同浮层实例去重），ChatWindow/MaterialsPanel 传 childId 上报 unknown_word+拼音释义；POST /kb/:childId/mistakes。
- C3：plan-domain applyExamAttempts 挂接时同步错题（pointGot<pointMax，source=exam，(source_ref,question_id) 幂等哨兵防重复挂接刷次数）。
- 端点：POST/GET /kb/:childId/mistakes + POST .../mistakes/action（家长 JWT + 归属校验）。
- 状态流转：mastered（会了，验证后）/ dismissed（不算）/ reopen；重复出现自动重开 open。
- 未做：家长端 dashboard widget（等 ISSUE-108）；重考做对自动标 mastered（二期）。
- 测试 test/mistakes.test.ts 4 例全绿；全量 315 过/15 败（存量）。

---
**补全记录（2026-09-22）——家长端可见性（落地记录挂起的最后一项 v1 缺口）**：
- 根因：ISSUE-128 开放家长 db 通道「孩子库全部登记表」时，`childKbTableSpecs()` 登记清单漏了 `mistake_book`（和 `display_contents`）——家长 agent（parent / parent-data）读不到错题本，ISSUE-108 报表也因此无错题数据源。probe:registry-drift 此前已把它列为「未被注册表覆盖」。
- db-channel.ts：登记 `mistake_book`（13 列 + readOnlyColumns：count/first_seen/last_seen/mastered_at 服务端维护拒写——家长纠错走 status=dismissed，不碰遗忘曲线计数）+ `display_contents`（内部表，只读登记）+ 补 `exam_plans.retake` 列（ISSUE-115 加列时漏登记）。孩子库漂移清零。
- parent-registry.ts：家长 agent prompt 新增「孩子的错题本」段——status=open 按 last_seen 倒序 = 当前没掌握，count 越大越薄弱，按 kind/知识点聚合汇报；约束：不代孩子标 mastered（掌握要孩子自己验证）。
- 家长侧用法：对话直接问（「孩子最近哪里薄弱？」）或让 agent 生成含错题统计的学习报表（ISSUE-108 报表通道）。
- 测试：db-channel-child.test.ts 新增 2 例（错题本读过滤 + 管理口径写纠错/拒写维护列），10 例全绿；mistakes.test.ts 4 例回归绿；server tsc 零错误；probe:registry-drift 无漂移。
- 仍未做（维持原判）：重考做对自动标 mastered（二期，见落地记录 2026-09-19）。

---
**补全记录 2（2026-09-26）——家长端「孩子管理」直接查看错题本（方案③的「孩子详情页」分支落地）**：
- 此前家长只能经 agent 间接问错题；用户指出应在孩子管理里直接可见。IPC/服务端通道早已就绪（`mistake:list`/`mistake:action`，家庭 license token + 归属校验），只缺家长 UI。
- 新组件 `src/components/ChildMistakeBook.tsx`：顶部概览统计（待掌握 open 数 / 本周新增 first_seen 7 天内 / 已掌握）；open 条目按 kind 分组卡片（内容/讲解 detail/出现次数/首记与最近时间/来源/课程与知识点快照 chip）；家长动作仅「不算了」（dismiss，记错/重复）与已关闭区「重新打开」——**刻意不提供「会了」**：掌握要孩子自己验证（与家长 agent prompt 约束同口径）。
- 接线 `ChildDetailPage.tsx`：TABS 新增「📕 错题本」（排在每日记录之后），包裹面板样式对齐其余 tab。
- 数据：`mistakesList({childId, limit:200})` 不传 status → 服务端返回全部状态（open+closed），前端自行分组/统计。
- 验证：electron-vite build 通过（主进程/preload/renderer 三段全绿）；服务端无改动。孩子端 MistakeBookModal 行为不变。

---

## 备注（2026-09-27 晚）：C2 查词上报时机随交互改版调整

查词交互改为两段式（选中先出悬浮图标，点击图标才展开弹框，见 ISSUE-017 优化记录），C2 的上报触发点相应从「浮层出现」变为「孩子点击图标、弹框展开时」——`WordLookupOverlay` 的 `onReport` 机制不变，仅渲染时机收窄。语义变化：从「选中即记」变为「点了才查才记」，信号更主动（更接近 C1 的明确漏洞信号），代价是选中后不点图标的选择不再入本。资料 iframe 与聊天区两条通道一致。

---

## 线上事故记录（2026-09-29）：web 端错题本全空——数据无恙，shim 形态 bug，已修复并部署 201

- 用户报告本地 dev + 201 生产、孩子/家长界面错题本全空。排查：数据两端完好（本地 13 条 / 201 珊珊 231 条且持续新增），服务端 HTTP 直测（自签家长 JWT）均正常返回——空的是 **web 端**渲染。
- 根因：web shim `ops.mistakesList` 返回扁平 `{success, mistakes}`，组件按 electron IPC 契约读 `r.data?.mistakes` → HTTP 200 拿到数据仍渲染空列表；`mistakeAction` 同病（`data.ok` 缺失，成功误报失败）。electron 走真 IPC 形态正确——「昨天还能看到」= 看的是 electron 客户端。
- 修复 commit 6317cc3：shim 三方法（list/report/action）返回 `{success, data}` 对齐 ipc-handlers；web typecheck ops.ts 清零；已部署 201（bundle index-iC1EsYe6.js，sha256 校验一致，HTTP 200）。详见 2026-09-29.md（含部署顺带带上 ISSUE-165 web 语音 shim 的说明）。

---

## 方案 A 落地（2026-09-29 晚）：考核错题按原题 question_id 闭环 + 读侧附题干 + kpName 快照

用户评估定案（错题入题库 B 案缓行、字词建知识点 C 案不做，见 2026-09-29.md）后先做 A：
- **读侧附题干**：`attachQuestionStems`（db/mistakes.ts）按 question_id 跨库读家长库 question_bank.stem，挂到清单行 `question_stem`；GET /kb/:childId/mistakes 与 child_mistake_log list 都接了。前端（孩子弹框 + 家长 tab）标题优先显示真题干，摘要串（考核·课程·知识点（得分））退为小字。家长库不可达/题已删不阻断清单。
- **kpName 快照补齐**：exam-results 的 seed 补 `kpName`（courses 挂载表反查后本就在手边，此前没传进错题本）——考核错题的知识点名称从「显示为空」恢复，聚合视图可用。
- **考核错题按原题闭环**：新增 `upsertExamMistake`（按 question_id 匹配存量条目：count+1/复发重开/补空快照；无原题退回 content upsert 旧行为）+ `masterByQuestion`（做对→该原题全部 open 条目自动 mastered）。routes/exam 提交后同步改走 questionSeeds（全量题目素材，含 correct 标志）：做错 upsert、做对 master。**修复了 exam 来源 content 拼接（标题·得分）导致去重失效、同知识点每场另立条目的问题**（201 上「每日习惯养成背诵 · 2026/9/28」「…9/29」各一条即此症）。
- 兼容：wrongSeeds 保留（issue135 测试不断）；examMistakeSynced 哨兵在路由侧退役（attempt id 每次提交新生成，哨兵本就永不命中），db 函数保留供 worker 兜底路径。
- 测试：mistakes.test 新增 3 例（原题合并/复发重开、masterByQuestion 边界、attachQuestionStems 含家长库夹具），相关 4 文件 25 例全绿；server tsc 仅剩 topic-package.ts 存量 Buffer 报错（非本次改动）；electron-vite build 过。
- 待办：本地 dev 服务端与 201 需重启/部署后生效（服务端改动，客户端重打包后弹框显示题干）。

---

## 方案 B/C 合并定案（2026-09-29 深夜）：错题整理主题——字词成知识点 + LLM 分层归类（worker 任务）

用户定案：专门建「错题整理」主题；查词字词 → 主题下「字词」课程的知识点并自动出考核题；无法归类到既有知识点的错题 → LLM 分层分析（主题→课程→知识点）挂既有知识点，挂不上则归入错题整理主题下的归类课程。此前的 C 案疑虑（污染知识点表）由「专属主题隔离」化解。

- **新任务** `server/src/worker/mistake-sorting.ts`（type=mistake_sorting，每 2 小时 :17 触发 + catchUp latest；scheduler 启动时懒注册避免 tasks→exam-engine→scheduler 静态环）：
  - 扫孩子库 open 且 knowledge_point_id='' 的条目（≤40/轮）→ 一次性 LLM 会话三轮：①字词准入（只收 ≤6 字真字词，界面文案/长句跳过→knowledge_point_id='skipped' 终止重分析）+错题主题定位（带建议知识点名）②按选中主题列课程/知识点名单要求**逐字匹配** ③字词批量出题（读音/释义简答，stem 不含答案）。
  - 落库全幂等：ensureSortingTopic/Course（name=topic_key='错题整理'，同值规避 getMethodSpec/getCourseUuid 双匹配口径）、ensureKnowledgePoint（UNIQUE(course_uuid,name)）、attachGeneratedQuestion（kp 已挂题跳过）、note='错题整理任务自动生成'。
  - 主题课程自动分配进孩子库（topics+courses 带 uuid 锚点，INSERT OR IGNORE）——家长才能对这些课排考核（ISSUE-123 课程名校验的前提）。
  - method_spec.perChild[孩子].require = 该孩子 open 错题关联的知识点名（≤40）——「字词」课程全孩子共享但**各考各的薄弱词**，复用 attachStructuredQuestions 既有 perChild 机制零改动。
  - mistake_book.knowledge_point_id 非空=已处理（分类成功的挂 kpId+name 快照→错题本 UI 知识点 chip/聚合可用）；LLM 失败抛错→调度器不记 worker_state 下轮自愈；出题失败遗留的 kp 由 pendingQ 预检补齐（skip 判定含待出题数）。
- **顺手修复**：extractJson 顶级数组解析（此前截 {..} 会把数组切坏成 null——本次出题 0 道的直接原因）。
- **真实冒烟（本地 dev，珊珊 11 条字词）**：9 条建 kp 并关联、2 条噪音被 LLM 拦截、出题 8/9（1 条留给下轮=上限机制按设计工作）、孩子库分配+perChild require 全部正确。
- 未做/边界：不加家长审核环节（题库 note 有自动生成标记，家长可删）；mastered 词不自动出考核范围（require 只按 open 名单）；201 部署后生效。
- 测试 test/mistake-sorting.test.ts 6 例（ensure 幂等/分配/关联/perChild/prompt 契约）全绿。

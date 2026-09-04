# 英语学科(English subject)需求 — 完全复用现有科目体系

- 日期:2026-08-31 初版;2026-09-04 多次调整;**2026-09-04 终版定调:英语作为一门普通学科,课程管理/引导/考核/记录/家长排计划全部复用现有 topics/courses 体系,不单独创建;差异仅两点——教学用英文、教学后可做发音测评且测评记入 daily;会话层面英语课用独立子会话隔离上下文(复用主 agent 身份,仅隔离窗口防主会话中文污染)**。
- 前置调研:`RESEARCH-pronunciation-assessment-2026-08-31.md`(发音评测服务对比)
- 历史决策回溯:初版"英语角独立会话/显式入口/独立评测表/独立选课 UI/每条语音评测"等设计,于 2026-09-04 本终版**全部推翻**,统一为"复用现有科目 + 英文教学 + 教学后发音测评入 daily"。

## 1. 总体模型(复用现有科目)

家长在家长库建/配英语 `topic`(wowenglish 资料已存在) → 分配给孩子(快照拷贝,与其他科目同 `allocateTopicToChild`) → 家长排学习计划(study-plan worker 物化每日 todo,与其他科目同) → 孩子正常学习流进入该英语课 → child agent 读 `parent_content`(method/teaching_copy/html_path)**用英文教学**、`display_content` 展示资料(与其他科目同) → 教学后 agent 引导**发音测评**(跟读重点词/句式,智聆/阿里评测) → 测评作为「学习情况」写入 daily(与其他科目考核记录同机制) → 进度/掌握度复用 courses.status/mastery/first_learned/last_review(与其他科目同)。

**不新建**:独立英语身份 / 独立 AGENTS ref、独立入口/路由、独立评测表、独立选课 UI。英语课教学**使用独立子会话(上下文窗口隔离)**——进入英语课时开独立 sessions 子目录(如 `sessions/english-<courseKey>/`)、从干净上下文开始,确保全程英文不受主会话中文/其他科目对话干扰;但身份与 AGENTS 复用主学习 agent(仅隔离上下文)。session-sync 上云需递归扫描该子会话(或置于可被扫到的位置)。

## 2. 与普通科目的差异(仅两点)

| 维度 | 英语 | 其他科目 |
|---|---|---|
| 教学语言 | **英文**(agent 按 topic 语言设置切换) | 中文/混合 |
| 附加测评 | 教学后**发音测评**,结果作为学习情况记入 daily | 知识考核(exam / assess_rubric) |

其余——课程管理、引导过程、考核、记录、家长排计划、进度追踪、家长回顾——**完全一致**,共用 topics/courses 体系。

## 3. 教学语言切换(唯一结构性新增)

- 复用 topics/courses:英语 topic 增加「教学语言=英文」属性(topic 级 `teach_lang='en'`,或存 rules_json / method 首行指令)。child agent 进入该课教学时按语言设置用英文,其余沿用主学习 agent 身份(LEARNING_NAV_INSTRUCTIONS),**不再另建 English-buddy 独立会话 / 独立 AGENTS ref / 独立 prompt**。
- 零基础兜底(保留此前决策):家长可配「允许中文」开关(中英混合);agent 检测到孩子连续不理解时切中文解释,平时全英文沉浸式。
- 会话隔离(防干扰,本次新增修正):孩子端主会话是单一持续窗口、所有科目共用(同 `childId` 仅一个会话);英语课若进主会话,前面中文对话会污染上下文、纯靠 prompt 难保全程英文。故英语课教学开**独立子会话**(独立 sessions 子目录、干净上下文窗口),复用主 agent 身份(LEARNING_NAV_INSTRUCTIONS)+ 该课 lesson_method + teach_lang=en。该子会话归档后由 daily-summary 递归 walk 自动进 daily、session-sync 递归上云、家长端 SessionReview 可回顾。
- **切换/退出模型(会话组织)**:主会话 `sessions/` 承载所有**中文课**共享历史(数学/语文…`continueRecent` 带历史);英语课各自开 `sessions/english-<courseKey>/` 独立子会话、按 courseKey 隔离、互不串、只承载英语(不在英语子会话里学其他科目)。① 进入某英语课 → 开/复用对应 `english-<courseKey>/` 子会话并 `newSession()` 干净窗口;② 英语课学完退出 → 归档该子会话 jsonl(自动进 daily/上云/家长回看)→ 回到主会话或课程列表;③ 退出后去学其他中文课 → 主会话 `continueRecent`(带原数学/语文历史);④ 退出后去学另一门英语课 → 开对应 `english-<courseKey2>/` 新子会话(干净窗口,不串 Unit1)。前端顶部「课程/语言」标签 + 课程列表完成切换;孩子界面看不到主会话中文历史气泡、也看不到其他英语课气泡(隔离),但 agent 经 course 状态/KB 知孩子整体进度(不显示气泡)。

## 4. 发音测评(教学后环节,记入 daily)

- 触发:英语教学完成后,agent 引导跟读/朗读该课重点单词与句式(参考文本取 teach-data.js 的 `mastered` 词 + `lines` 句式)→ 调用评测 API(腾讯云智聆口语评测主,阿里门控)。
- 呈现:评测卡(总分、问题音素高亮、原声/标准音 A/B)+ agent 英文点评一句。
- 记录:**测评结果作为「学习情况」写入 daily**(与其他科目考核记录同机制,复用 readDailyConversation / RECORDING_PROMPT),家长端可在 daily/对话回顾查看;**不单独建 `english_assessments` 表**(推翻原决策③,简化)。
- 范围:仅教学后特定练习触发,**不每条语音都评**(保留"去掉每条都评"的调整)。

## 5. 教学内容与资料(与其他科目同,存 topic/course)

- 英语 course 的 `lesson_method`(教法)/`teaching_copy`(教学文案)/`html_path`(资料)/`assess_rubric`(考核要点)与其他科目同结构,统一存家长库 topics/courses。
- **现有 english/ 资料已结构化、可直接接入**(`server/data/materials/<pid>/english/`):每课含 `teach-data.js`(`window.__teach`:`mastered`=单词→IPA 映射、`lines`=逐句台词含逐词 IPA + `modules` M1-M4 搭配/句式)、`learn/` 下 `phonetics/phonics/grammar/vocabulary` HTML、`emma/*.mp4` 各音素口型视频、`media/lesson-XXX.mp4` 剧集动画。
- 接入任务:解析 teach-data.js 提取词表+句式 → 写入 course 的 `lesson_method`/`teaching_copy`(或作为 course 内容);`display_content` 展示 `learn/` HTML 与口型/剧集视频。无需为英语重新编写课程内容。

## 6. 实施任务(重排,大幅简化)

1. 评测服务接入(已完成):评测 provider(智聆主/阿里门控)+ voice 链路 `assess`;key 走家长端 `assessment-config.json`。
2. 英语课独立子会话 + 教学语言支持:进入英语课时开独立子会话(按课隔离 `sessions/english-<courseKey>/` + 每次进入 `newSession()` 干净窗口,复用主 agent 身份与 AGENTS);child agent 按 topic `teach_lang` 切换英文(prompt 注入语言指令);getChildSession 支持 course 维度;session-sync 递归上云 english 子会话。
3. 教学后发音测评环节 + 评测卡 UI + 测评结果写入 daily(复用现有 daily/RECORDING_PROMPT,不需独立表)。
4. 英语 course 内容接入:解析 teach-data.js 提词表/句式进 course 内容、`display_content` 展示 `learn/` 与口型视频(复用现有展示机制)。
5. 家长排计划/回顾:完全复用现有 study-plan + SessionReview,**仅验收、基本无需改动**(或仅英语课 `teach_lang` 标注 + 测评入 daily 两处)。

## 7. 数据模型(全复用)

- topics/courses:英语 topic 加 `teach_lang='en'`;course 内容(lesson_method/teaching_copy/html_path/assess_rubric)与其他科目同。
- 测评记录:进 daily(复用 readDailyConversation / RECORDING_PROMPT 英语类别),不建独立表。
- 进度/掌握度:复用 courses.status/mastery/first_learned/last_review(与其他科目同)。
- 评测配置:家长端 voice-config / assessment-config.json(已实现)。
- **已删除**:原独立英语会话(`<childId>-english` AGENTS ref)、`english_assessments` 独立表、session-sync 递归特殊化、独立选课/绑课 UI。

## 8. 范围 / 待定项

- **本期不做**:独立英语会话/英语角入口、独立评测表、独立选课 UI、每条语音评测、自动切换。
- **✅ 已确认(2026-09-04 终版)**:
  1. 英语=普通学科,课程管理/引导/考核/记录/排计划**完全复用**现有 topics/courses 体系,不单独建。
  2. 差异仅两点:教学用**英文**(topic `teach_lang`);教学后**发音测评**作为学习情况记入 daily。
  3. 评测服务商 = **智聆 + 阿里双备**,智聆为主(已实现且真实链路自测通过);阿里协议未实测,**门控**默认关闭,真实密钥验证通过再开放。
  4. 评测 key = 家长端 `assessment-config.json`(已实现)。
  5. 零基础双语兜底 = **中英混合开关**(家长可配「允许中文」,agent 检测孩子连续不理解自动中文解释,平时全英文)。
  6. 教学内容/资料存 topic/course,与其他科目同;现有 english/ 资料结构化可直接接入,无需重编。
  7. 英语课会话 = **独立子会话**(按课隔离 `sessions/english-<courseKey>/` + 每次进入 `newSession()` 干净窗口),复用主 agent 身份与 AGENTS,隔离上下文防主会话中文污染;该课历史 jsonl 保留供 daily/上云/回顾。

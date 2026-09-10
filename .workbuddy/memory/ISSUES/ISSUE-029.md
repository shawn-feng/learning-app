## [ISSUE-029] 英语学科：复用现有科目体系 + 英文教学 + 教学后发音测评入 daily（终版 2026-09-04）

- **类型**：需求 / 新功能（2026-08-31 起讨论；2026-09-04 终版定调：**英语=普通学科，完全复用 topics/courses 体系，不单独建**）
- **终版模型（2026-09-04 用户拍板）**：英语作为一门普通学科，课程管理/引导/考核/记录/家长排计划**全部复用现有 topics/courses 体系**；差异仅两点——① 教学时 child agent **用英文**(topic `teach_lang='en`)；② 教学后 agent 引导**发音测评**(跟读重点词/句式,智聆/阿里)，测评作为「学习情况」**记入 daily**(复用 readDailyConversation/RECORDING_PROMPT，不建独立表)。
- **完全复用、不新建**：独立英语会话/AGENTS ref、独立入口/路由、独立评测表 `english_assessments`、`session-sync` 递归特殊化、独立选课/绑课 UI——全部推翻(初版"英语角"设计)。教学内容/资料存 topic/course 与其他科目同；现有 `server/data/materials/<pid>/english/` 资料(teach-data.js 单词→IPA+句式、learn/ HTML、emma 口型视频、剧集)结构化可直接接入。
- **需求文档**：根目录 `ENGLISH-AGENT-REQUIREMENTS.md`（2026-09-04 终版：§1 复用总体模型 / §2 仅两点差异 / §3 教学语言切换 / §4 发音测评入 daily / §5 内容存 topic/course / §6 简化任务 / §7 全复用数据模型 / §8 范围）
- **评测调研**：`RESEARCH-pronunciation-assessment-2026-08-31.md`
- **✅ 已完成（2026-09-01，任务 1：评测服务接入）**：`electron/lib/assessment/`（types/assessment-config/providers/tencent-soe+aliyun-kid/index）；智聆完整实现真实链路自测通过；阿里实验性(协议逆向,门控默认关,待真实密钥实测)；家长端「设置→发音评测」tab；`test/assessment.test.ts` 9 例。
- **⏳ 待办（按 `ENGLISH-AGENT-REQUIREMENTS.md` §6 重排，大幅简化）**：
  1. 英语教学语言支持：child agent 按 topic `teach_lang` 切换英文(prompt 注入语言指令；复用现有会话/AGENTS，不新建)。
  2. 教学后发音测评环节 + 评测卡 UI + 测评结果写入 daily(复用现有 daily 机制，不需独立表)。
  3. 英语 course 内容接入：解析 teach-data.js 提词表/句式进 course 内容、`display_content` 展示 `learn/` 与口型视频(复用现有展示)。
  4. 家长排计划/回顾：完全复用 study-plan + SessionReview，仅验收 + 英语课 `teach_lang` 标注 + 测评入 daily 两处。
- **优先级**：需求终版已定(2026-09-04)，任务 1 已完成，任务 2-4 待实施。
- **记录时间**：2026-09-01（内容 2026-09-04 终版重写）

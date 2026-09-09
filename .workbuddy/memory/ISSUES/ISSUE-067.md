## [ISSUE-067] 考核内容结构化：题型目录 + 类型块(题干+内嵌评分, DB真源) + methodSpec 按孩子选类型（设计定案，待实施）
- **类型**：架构 / 需求（2026-09-09 与用户讨论定案，设计见仓库根 `DESIGN-course-assess-structured-2026-09-09.md`）
- **动机**：rubric 为自由文本（论语 489 课 avg 5.2K/max 8.7K 字），出题/判分整文喂 LLM（实测 40-100s）且随例题收集线性变贵；背诵原文靠正则抓引号；判分须带与题无关的大段内容。
- **设计要点（用户拍板）**：
  1. 内容 = 每课若干「类型块」：类型(题型目录) → 类型概述 → 若干主观题，**每题题干+评分一体**；**全主观问答题、无选择题**。
  2. **DB 为真源，工具直写块**：家长库新表 `course_assess_blocks`（kind=summary/question，payload JSON 含 stem/pointMax/scoring{dims,special,answerRef}，背诵类带 recite.refText）。旧 assess_rubric 保留仅作未迁移课兼容与预览渲染。
  3. 方法 = 主题级·每孩子结构化 `methodSpec`（topics）：`{require:{类型:数量}, exclude:[], rules:{recitePass}}`，key=childId。
  4. 题型目录 = 主题级 `type_catalog`：`{name, aliases[], behavior: speech_recite|speech_read|generic}`，解决字词同词多写漏匹配。
  5. 出题按方法取块、每类型抽 1 题；**某类型无备题 → 跳过该类型**（不做 LLM 临时命题）；speech_recite 置首题。
  6. 判分逐题小 prompt（题自带评分），与整份课程内容解耦。
- **待实现**：块表 DDL + type_catalog/method_spec 字段与工具 + agent/UI 写入口（整课事务/追加例题）+ 服务端 config 改读块 + 出题引擎代码直选(0 LLM) + 判分逐题评分 + assess-guide(066) 对齐改写 + 家长端结构化编辑器。
- **存量 489 课迁移**：解析建块 + 选择题转主观 + 类型标注；标注方式（自动/部分/人工）用户明确先不定，等结构落地后选。
- **验收**：珊珊=背诵+句意白话+道理各1(无字词/典故)；闻闻=背诵+句意白话；已结构化课出题 0 LLM；未建块课行为不回退。
- **状态**：设计定案，待实施（登记 ISSUE-067，2026-09-09）。

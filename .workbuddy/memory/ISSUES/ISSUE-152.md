# ISSUE-152：需要「评估/判断」的地方应支持「自然语言标准 + LLM 判断」——背诵通过线写死 90 只是其一；LLM 判完按字段要求回填结果

- **类型**：记录 / 需求建议（待拍板）
- **问题**：在一些需要评估的地方，可以用自然语言调 LLM 进行判断。例如背诵题，阿里云评测返回了分数，分析这个分数的标准可以是自然语言——现在代码写死 90 分以上算通过，但有的课程可以是 85 分。这类地方应该提供「自然语言 + LLM」的判断方法，LLM 判断后按照要求填写结果字段就行了。
- **现状（已核实代码）**：

  | 判断点 | 现状 | 位置 |
  |---|---|---|
  | 背诵/朗读题「通过与否」 | 阿里云 SSECP 已返回丰富分项（`overall/pron/accuracy/integrity/fluency/prosody`，`exam.ts:388` `SpeechAssessment`），但客户端只拿总分和数字线比较：`const pass = Number((q as any).recitePass) || 90; correct = total >= pass`。`recitePass` 是**纯数字**（主题方法/排期可覆盖，默认 90）——能配成 85，但**表达不了「准确度 90 且流利度 80 以上」「低于线但完整度 95 以上也算过」这类组合/人文标准**，每换一种标准就要改代码 | `src/components/ExamView.tsx:467-474` |
  | 背诵得分换算 pointGot | 写死线性换算 `Math.round((total/100) * pointMax)` | `ExamView.tsx:469` |
  | 背诵题 aiComment | 写死模板字符串（分数+分项罗列），不是 LLM 按标准写的评语 | `ExamView.tsx:475` |
  | 文字题/口述题判分 | **已是「LLM 按标准判」**：题目+学生作答+课程 rubric/题级 scoring 交给服务端判分引擎，LLM 回 `correct/pointGot/aiComment` | `server/src/agent/exam-engine.ts:141` |
  | 重考标准 retake | **已是自然语言**（「错两题以上当天原题重考」），服务端一次 LLM 调用生成当天重考计划（ISSUE-115） | `electron/lib/exam.ts:304` |

  **recitePass 数字链路**（若加自然语言标准，同链路各处都要跟进）：
  `server/src/assess-selection.ts:96/166`（默认 90、随题下发）→ `server/src/agent/parent-plans.ts:766/835/866`（methodSpec 持久化/展示）→ `server/src/agent/plan-tools.ts:550/568`（工具说明「缺省 90」）→ `server/src/agent/skills/parent/plan.ts:53/56`（场景技能口径）→ `electron/lib/assess-guide.ts:46/70`（出题规范）→ `electron/lib/assess-admin.ts:95` → `src/components/ExamView.tsx:134/467`（客户端判定）。
- **问题点**：
  ① **数字通过线表达力不足**：不同课程通过线不同（90/85）尚可配数字，但「考记忆与准确」的产品语义（分项组合条件、弹性标准）写不进一个数字，每变一种标准就得改代码；
  ② **同一场考核判定口径割裂**：文字题由服务端 LLM 按 rubric 判（会写评语），背诵题在客户端写死数字阈值判（评语是模板）——标准想变时两处无法一致；
  ③ **浪费评测能力**：SSECP 分项（accuracy/integrity/fluency/prosody）都已拿到，现在只用了总分一个数。
- **建议（待拍板）**：给「评测类判断」提供**自然语言标准 + LLM 判断 + 按要求回填结果**的方法：
  ① **标准字段**：在考核方法/排期（methodSpec 同链路）加自然语言标准字段（如 `reciteRule`：「85 分以上通过」或「准确度 90 且流利度 80 以上算通过」），**缺省回落现有数字 `recitePass` 默认 90**，存量方法不受影响；
  ② **判断执行**：背诵题 SSECP 评测完成后，把**分项 + 该题自然语言标准**交给判分 LLM（可与文字题判分同一引擎/同一调用），LLM 只负责「按标准下结论」，输出结构化 `correct/pointGot/aiComment`，客户端拿到后按字段要求回填即可——**阈值判断不再留在客户端代码里**；
  ③ **底线兜底**：LLM 不可用/超时回落现有数字判断（软失败路线已有先例，`ExamView.tsx:419`）；
  ④ **可推广**：凡「拿一个数值/一段内容按标准下结论」的地方都可套用该模式——考核域已有 retake（自然语言）与文字题判分（LLM+rubric）两个先例，本条是把背诵题补齐成第三块并沉淀成通用做法。
- **优先级**：中（现状可用——`recitePass` 已能配不同数字线；本条是表达力/口径统一的增强）
- **记录时间**：2026-09-26

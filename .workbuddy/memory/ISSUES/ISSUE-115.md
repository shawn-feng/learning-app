# ISSUE-115：考核当天重考——考核计划加「重考字段」，评分结束按字段经 LLM 生成重考计划并直接创建（✅ 已实施 2026-09-19；范围定稿：只做考核，通用 prompt 表机制缓议）

- **类型**：需求 / 设计（2026-09-18 用户定稿收窄：**先只支持考核场景，不考虑扩展到其它程序点**；原「通用 prompt 决策表」方案降级为备查，等第二个同类需求出现再抽象）
- **需求描述（用户口径）**：
  - 考核计划增加一个**重考字段**，内容 = 是否要当天重考 + 重考的标准或方式（自然语言描述，prompt 语义，家长可灵活定制，如「错两题以上当天原题重考」「背诵题不对的当天重新背诵」）；
  - **字段有值 = 当天必须重考**；
  - **考核评分结束后**读该字段：有值就把字段（连同评分结果）发给 LLM，**模型返回重考计划的 JSON，按 JSON 直接创建考核计划，时间区域为当天**；
  - **创建失败，则把错误发回给 LLM 再次生成 JSON**（错误反馈重试环）；
  - **整个过程属于考核评分环节**：评完分立刻判断是否重考，**重考计划生成后，评分才算完成**。
- **现状 / 已查证**：
  - **评分链路**：`POST /exam/agent/grade` → `scoreExamAttempt()`（`exam-engine.ts:343`，LLM 判分）→ 客户端上报 attempt（`routes/exam.ts:1326` INSERT exam_attempts，带 scheduleId/per_question/score）→ worker `applyExamAttempts`（`plan-domain.ts:340-384`）把 `exam_plans` 置 done + 回写 score + 逐题入 `exam_plan_courses`——**「考核结束」的权威点在 applyExamAttempts，重考钩子挂这里或 attempt 落库之后**。
  - **计划创建路径现成**：custom 计划直写 `exam_plans`（`routes/exam.ts:271` / `parent_exam_plan_create`，ISSUE-094 同口径）；scope_json.courses 格式 `[{title, kps:[{name,count}]}]`（ISSUE-104 定稿）——**LLM 返回的 JSON 直接复用这套 schema，零新格式**。
  - **表结构**：`exam_plans`（孩子 kb，`kb.ts:93-134`，kind=custom/fixed、count_in_rate 等），加列走既有幂等迁移先例（`ALTER TABLE ... ADD COLUMN`）。
- **方案（定稿）**：
  ① **加字段**：`exam_plans` 加 `retake TEXT NOT NULL DEFAULT ''`（幂等迁移）。`''`=不重考（现状）；有值=当天必须重考，值为重考标准/方式的自然语言描述。设置入口：`parent_exam_plan_create` 加参数 + 考核管理面板同口径（v1 至少 agent 工具支持）；固定考核（fixed，worker 从 `exam_fixed:<parentId>` 配置生成）配置项后续同形扩展。
  ② **评分后钩子（同步串入评分环节）**：`applyExamAttempts` 置 done 后读该计划 `retake`；有值 → 组装 LLM 请求（**retake 字段原文 + 评分摘要**：逐题对错/得分/aiComment/题目清单含 qid+知识点）→ LLM 返回重考计划 JSON（复用现有 scope schema，`start_at/due_at` = 当天）→ 校验 → **按现有创建路径直接创建**。
  ③ **错误反馈重试环**：创建/校验失败 → 把错误信息追加进对话再让 LLM 重新生成 JSON → 重试（上限 2~3 次）。
  ④ **完成语义（用户明确）**：重考计划生成后评分环节才算完成——attempt/计划的终态流转与客户端「评分中」等待要覆盖重考生成耗时（判分本身已 45~104s，ISSUE-098；重考生成再加一次 LLM 调用，客户端提交后的等待会变长，需在 UI 提示上体现）。
  ⑤ **失败兜底**：重试耗尽 → **评分结果照常落库（绝不丢分）**，重考生成标记失败 + 告警（日志/家长 agent 可见），人工兜底创建重考计划。
  ⑥ **防连环重考**：LLM 生成的重考计划自身 `retake` 默认 `''`（不允许模型带出，服务端强制），当天最多重考一层。
  ⑦ **重考是否计入评分档：设置项（2026-09-18 用户拍板，二选一）**：做为一个设置项（家长维度，存 settings 键，对齐 `exam_fixed:<parentId>` 先例；考核设置面板/家长 agent 均可改），两档：**计入评分档 / 不计入**，**默认不计入**（重考计划 `count_in_rate=0`，巩固性质不稀释当天评档分）；设为计入时 LLM 生成的重考计划 `count_in_rate=1`。服务端创建重考计划时按该设置项取值，不经 LLM。
- **待拍板（实施前确认）**：
  - ~~重考计划的 `count_in_rate` 口径~~ → **✅ 已拍板（2026-09-18）**：做成设置项二选一（计入/不计入评分档），**默认不计入**（见方案⑦）。
  - fixed 固定考核是否首批就支持 retake 配置（还是先 custom）。
  - 重考计划的呈现：孩子端「今日计划/考核」自然可见（现有机制），标题建议带「重考」前缀（LLM 生成 title 时约定）。
- **边界**：LLM 输出必须过 schema 校验才落库（不接受自由文本直接创建）；重考生成失败不影响评分/积分已有链路；通用 prompt 表机制（原方案）缓议——本文原「PROGRAM_PROMPT_SLOTS 注册表 + runProgramPrompt 执行器」设计保留在 git 历史与本 issue 记录时间线中备查。
- **实施拆步**：P1 加字段 + 迁移 + agent 工具参数；P2 评分后钩子 + LLM 生成 + 创建 + 错误反馈重试环 + 完成语义；P3 面板同口径 + 失败告警 + count_in_rate 口径落地。
- **回归**：无 retake 字段的计划行为零变化（''=跳过钩子）；评分/积分/挂接链路不回退（ISSUE-112 修复口径保持）；LLM 不可用时重试耗尽走兜底，不阻塞评分落库；重考计划当天出现在孩子端考核入口。
- **优先级**：中（考核闭环增强；机制简单，复用面大）
- **记录时间**：2026-09-18（2026-09-18 二稿：按用户定稿收窄为考核当天重考，通用机制缓议）

---

## ✅ 实施记录（2026-09-19）

- **P1 字段 + 入口**：
  - `exam_plans` 加 `retake TEXT NOT NULL DEFAULT ''`（孩子库 kb.ts：建表自带 + 老库 `ensureExamRetakeColumn` 幂等补列）。
  - agent 工具 `parent_exam_plan_create` 加 `retake` 参数（prompt 说明「考完错的当天再考一次」类需求必须转成该参数，不要写进 note）；面板创建路由 `POST /exam/schedules` 同口径收 `retake`。
- **P2 评分后钩子（新模块 `server/src/exam-retake.ts`）**：
  - 钩子位置：**提交路由 `POST /exam/attempts` 内、原计划置 done 之后同步执行**（09-14 v2 起计划置 done 在路由，issue 里「applyExamAttempts 置 done 后」的表述已随之修正；这也正是 ④ 完成语义要求的「客户端提交等待覆盖重考生成」）。
  - 链路：读计划 `retake` → 组 prompt（标准原文 + 总分 + 逐题摘要含 qid/课程/知识点/对错/评语）→ LLM（复用 `createExamSession`，同会话多轮）→ `parseRetakeDraft` schema 校验/归一化 → `validateRetakeCourses` 课程/知识点存在性校验（复用 `buildPlanSpecEntries`，kps 显式与否分组防 require 误过滤）→ 不过把错误**追加进同一会话**再生成（错误反馈重试环，上限 3 轮 + 总墙钟预算 100s）→ 创建 `exam_plans` 行（origin='retake'，scope_json 带 `retake_of`）。
  - 模型可输出 `{"retake_needed":false,"reason":…}`（标准未触发，如「错两题以上才重考」但只错一题）→ 不创建，原因回传。
- **硬约束（服务端强制，不经 LLM）**：
  - 防连环重考：生成的重考计划 `retake` 恒 `''`（⑥）；
  - `count_in_rate` 按家长设置 `exam_retake:<parentId>`（settings 键，默认不计入=0；`GET/POST /exam/fixed-config` 增 `retakeCountInRate` 字段，面板可接）（⑦）；
  - 计划 id 确定性 `retake_<原计划id>` → 重复提交天然幂等、一天最多一层；
  - 失败兜底：钩子吞掉一切错误，评分照常落库，失败原因折叠进响应 `retake.note` + 服务端 logWarn 告警，人工兜底创建（⑤）。
- **完成语义 / UI（④）**：客户端提交超时 30s→120s（对齐判分调用 120s 先例）；ExamView 报告页按响应 `retake` 字段显示提示条（已生成当天重考 → 绿色引导；生成失败 → 红色告警）。
- **待拍板项落地**：fixed 固定考核**首批不做 retake 录入入口**（按方案①口径 custom 先行；机制读的是计划行，fixed 行若手工设值钩子同样生效）；标题「重考」前缀由 prompt 约定 + 服务端强制兜底。
- **验证**：新增 `test/issue115-exam-retake.test.ts` 14 用例（迁移×2、解析/prompt×4、全链路×8：零变化回归/创建断言/幂等/重试环/幻觉课程名反馈/未触发/失败兜底/count_in_rate 设置），连同 ISSUE-112/exam/kb-domain-split/plan-scope 共 38 测试全过；server tsc 零错误；`electron-vite build` 通过。
- **遗留（P3 尾巴）**：考核设置面板的 retakeCountInRate 开关控件未接（HTTP 字段已就绪）；fixed 配置的 retake 录入入口缓议。

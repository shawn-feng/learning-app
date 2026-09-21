# ISSUE-119：背诵题最终打分是怎么计算的？——评分链路梳理（纯发音评测引擎分线性映射，不经 LLM；附三个值得注意的点）

- **类型**：记录 / 梳理（背诵题打分全链路；供后续调口径/排疑时引用）
- **问题**：一个背诵题（`behavior='speech_recite'`）的最终打分是怎么算出来的？
- **完整链路（已核实代码）**：
  1. **出题——不经 LLM**：LLM 出题被明确禁止出背诵（`exam-engine.ts:83-86`「背诵题由系统单独生成并用发音评测自动评分」）；背诵题从题库直出，自带 `refText`=标准原文（answer 列）、`recitePass` 通过线（主题方法/排期 methodSpec 覆盖，**默认 90**）、`pointMax`（默认 10）。
  2. **录音**：孩子按住说话，多段录音 `voiceMerge` 拼单段 16k WAV（`ExamView.tsx:446-454`）；**无录音直接 0 分**不调评测（`:434-445`）。
  3. **发音评测（服务端双 provider）**：`examAssessSpeech` → `server/src/assessment/`：
     - **腾讯智聆 SOE**：score = **SuggestedScore**（腾讯建议分 0-100），accuracy=PronAccuracy、fluency=PronFluency、completeness=PronCompletion（`providers/tencent-soe.ts:174-197`）；
     - **阿里声希 SSECP**：score = **r.overall ?? r.pron**（`providers/aliyun-ssecp.ts:175`）；
     - 统一经 `toSpeechAssessment.ts` 映射：**pron = score**、integrity=completeness、fluency 等（**注意：该映射从不设置 `overall` 字段**）。
     - **⚠️ 引擎分本身是黑盒（2026-09-19 追问补记；2026-09-19 修正：系统实际默认/使用的是阿里声希，非腾讯）**：「背诵 81 分」= **声希 `cn.pred.score` 返回的 `overall` 合成分**（中文背诵走 cn.pred.score——声希的段落/背诵预测评分 coreType，**天然支持长文本免拆段**（`coreTypeForText`，aliyun-ssecp.ts:16-18）；英文走 en.sent.score）。**计算发生在声希引擎内部，我方代码无任何加权公式、只做 round 取用**（`score = r.overall ?? r.pron`，:175）。引擎把录音与 refText 对齐后在内部对 准确度/完整度/流利度 等因子加权合成——权重不公开、无法本地复现（例：完整度 100/准确 83/流利 69 → 引擎给 81，三维均值 84，差异即引擎非均匀权重）。我方可控参数：`precision=1.0`（精度系数，aliyun-ssecp.ts:89；**2026-09-19 补：调整范围未确认**——值硬编码不可调，声希官方文档未公开收录（公开搜索无索引），合法区间需查厂商接口文档或实验法确认（同录音试 0.5/2.0 看报错/分数变化），行业惯例仅参考：默认 1.0、常见 0.5~2.0 浮点）。⚠️ 代码里 `DEFAULT_CONFIG.provider='tencent-soe'` 只是**无配置时的兜底值**（config.ts:17），实际家长配置/使用的是阿里声希——勿据兜底值推断线上行为。含义：同一录音换 provider/引擎版本分数可能漂移，recitePass 通过线的语义依赖引擎行为。
  4. **最终打分（客户端本地，`ExamView.tsx:465-478`）**：
     - `total = sp.overall ?? sp.pron` → 因映射不设 overall，**实际恒取 pron = 评测引擎总分（0-100）**；
     - **`pointGot = Math.round((total / 100) × pointMax)`——线性比例映射**：引擎 85 分 → 10 分制得 9 分（8.5 四舍五入）；引擎 60 分 → 6 分；
     - **`correct = total >= pass`（pass=recitePass，默认 90）——得分与通过是两条线**：引擎 85 分 = 得 9 分但 correct=false（未过线）；
     - `aiComment` 纯维度拼接（无 LLM）：「背诵 85 分（90 分以上通过；完整度 x / 准确 y / 流利 z）」；
     - **评测失败软失败记 0 分**（`:479-482`）。
  5. **上游聚合**：pointGot 累进 attempt.score → 提交 → `exam_plan_courses` → `computeExamRate`（考核得分率）→ 积分结算（ISSUE-112 修复后的口径）。
- **三个值得注意的点（后续可能要调）**：
  ① **`overall ?? pron` 双字段残留**：`overall` 是旧 SSECP 契约兼容字段、映射层从不赋值，`?? pron` 分支恒真——行为确定但代码误导（家长端展示、speech_assessments 落库 `routes/exam.ts:1370` 同样写法），建议收口成单字段；
  ② **得分与通过线分离**：pointGot 按比例给分、correct 按 recitePass 线判——「9 分但算错题」的组合是否符合预期（correct 影响 wrong_questions/错题本 ISSUE-114/重考 ISSUE-115），口径值得确认；
  ③ **软失败 0 分无区分**：录音噪音/音量不合格导致的评测失败与真没背都记 0 分，aiComment 无差异——可考虑给「评测失败」单独标记供家长甄别。
- **优先级**：低（记录性质；①是代码卫生、②③是口径确认，待用户判断是否调整）
- **记录时间**：2026-09-19

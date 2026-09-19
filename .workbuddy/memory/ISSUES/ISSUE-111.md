# ISSUE-111：SQLite 向量旁表 + 「精确匹配落空 → 向量检索兜底」——治 LLM 记错名字就全表列出的上下文爆炸

- **类型**：需求 / 设计（agent 数据检索能力，db-channel 与专用查询工具共用）
- **描述**：LLM 检索数据库时经常记错/写错名称（如课程名「论语·学而第一」写成「学而篇」），**精确匹配（WHERE =）查不到**，只能列出全部记录自己肉眼匹配——courses 表 600+ 行（ISSUE-076：珊珊 383/613 门），一次全表列出上下文爆炸。需求：给关键文本列建**向量索引**；**精确匹配落空时自动做一次向量检索**，把候选返回并**明确说明「精确匹配没有数据，以下是向量检索返回的，请判断选哪一个」**，让 LLM 决定用哪个/确认新建，而不是拉全表。
- **现状 / 根因（已查证代码）**：
  - **检索全靠等值 WHERE**：db-channel 的读/写引用校验全是 `= ?` 精确匹配（如 `db-channel.ts:479` refCheck `SELECT 1 FROM topics WHERE name = ?`）；落空只报「主题不存在：topic=xxx（须存在于 topics.name）」（`:480`），**无模糊提示、无候选**——LLM 被逼去 `SELECT` 全表。专用查询工具（`parent_library_course_content` 按课名、kb-summary-tool 等）同样只有精确查。
  - **项目无任何 embedding 基础设施**：全仓无 embedding/cosine/sqlite-vec 相关代码；驱动为 `node:sqlite`（`DatabaseSync`，`db.ts:1`），加载 sqlite 扩展的可行性与跨平台（Win/Mac/Ubuntu）二进制分发存疑。
  - **模型配置通道现成**：服务端 settings 按家长隔离（`config.ts:35`）+ 模型配置合并端点，加一个 embedding 模型键即可复用（ASR/LLM 均已走百炼/DashScope 生态，embedding 可用同生态 text-embedding 系列）。
- **方案（建议）**：
  ① **向量存旁表、不加业务列**（推荐）：每库一张 `embeddings(table_name, row_pk, column_name, model, dim, vector BLOB, updated_at)`——业务表零 schema 变更、跨三库（server.sqlite / parent.sqlite / kb.sqlite）统一写入器；**余弦相似度在 JS 内存算**（按 table+column 载入该列全部向量，千行级 × float32 ≈ 数 MB，毫无压力）。sqlite-vec 扩展作为后续数据量上来后的可选优化，不进一期（扩展加载 + 三平台二进制打包风险大、当前规模无收益）。
  ② **向量化对象（首批两列）**：`courses.title`、`topics.name`（错误率最高、引用最多，refChecks 强依赖）；`question_bank.stem`/`knowledge_summary` 视效果二期。**不做全库通用模糊搜索，只对登记列生效**。适用库随 ISSUE-110 定稿的布局走（家长内容库 + 孩子 kb），不与「主库」纠缠。
  ③ **Embedding 来源**：新增模型配置键（如 `embeddingModel`，走现有 settings/模型配置通道）；DashScope text-embedding 系列（或 openai 兼容 `/embeddings`）。
  ④ **写路径维护**：db-channel insert/update 触及登记列时**写后异步重嵌入**（失败不阻断写、留待 backfill）；一次性 backfill 脚本补存量（按行数分批）。
  ⑤ **读路径兜底钩子（核心，用户指定契约）**：收口一个 `lookupWithFallback(table, column, value)` 供 db-channel 等值查询与专用工具的课程/主题查找共用：
    - 精确 `=` 命中 → 原样返回；
    - **0 行 → 向量检索 top-K（如 5，相似度阈值如 0.6）**，返回格式明确标注：`精确匹配无数据；以下为向量检索候选（相似度降序），请判断选哪一个，均不符则确认新建`——**只提示、不自动代入**（写路径 refChecks 落空同样带候选，防 LLM 顺手写错引用）；
    - 嵌入服务不可用/未配置 → 静默降级为现状行为（报错 + 建议），不阻断。
- **备选（否决/缓议理由备查）**：sqlite-vec 扩展（一期否决，理由见①）；FTS5 全文索引（对「记错名字」的语义失配帮助有限，可作廉价的子串补充，缓议）；LLM 继续全表列出（现状，上下文成本随数据量无界增长，即本 issue 要消除的）。
- **回归**：精确命中路径零变化（不引入额外延迟）；写路径重嵌入失败不影响业务写入；三库既有迁移幂等性不破坏（旁表 `CREATE TABLE IF NOT EXISTS`）；向量候选仅提示不代入，考核/积分等只读域不受影响；与 ISSUE-110 的通道扩展（parent_db_read / 家长操作孩子库）正交——兜底钩子按「登记了向量的列」生效，不关心表在哪个库。
- **优先级**：中（LLM 高频痛点、上下文成本可度量地省；方案简单、依赖少）
- **记录时间**：2026-09-18

---
**落地记录（2026-09-19）**：已实施。provider 内置声明（agent-core providers.ts：qwen → text-embedding-v4，零用户配置，无可用 key 整体跳过）；旁表 embeddings（openParentLib 幂等挂载）；写路径 4 挂钩（executeWrite 回调/parent_upsert_course/parent_upsert_topic/RPC upsert，markStale 异步队列）+ backfill 脚本（scripts/backfill-embeddings.mts）；读兜底 lookupWithFallback 集成 3 处（executeRead 落空 missedEmbedded、refChecks 落空 missedRef、parent_library_course_content/parent_upsert_course_content 课程名）。实测：1328 行向量回填（courses 1317 + topics 11）；「论语·学而第一」落空 → 候选「论语学而篇第一章 0.863」居首。设置页能力提示（models/settings embedding 字段）已就绪，客户端展示待下次打包。回归：精确命中路径零变化；299 过/15 败（存量）。

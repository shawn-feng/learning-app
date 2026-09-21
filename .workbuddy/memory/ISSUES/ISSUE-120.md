# ISSUE-120：家长/孩子 agent 共用「知识库」——对话中快速检索可信赖知识；家长供料（视频/网页/PDF）自动摄取为可检索知识（需求 + 方案）

- **类型**：需求 / 设计（agent 能力扩展；待拍板后实施）
- **需求描述**：
  1. 给家长 agent 和孩子 agent 建一个**知识库**，主要场景是 **agent 与孩子聊天时查询**：孩子问到历史事件、自然现象等事实性问题时，agent 能检索到**相关度高**的信息再回答（而非仅靠模型参数知识——可能过时/不准/不适龄）；
  2. 知识库能**自我完善**：家长提供资料（**视频、网页、PDF 等文档**），系统自动整理为可被快速检索的知识。
- **需求分析**：
  - **为什么是「家长供料」而不是联网检索**：儿童产品的内容边界应由家长圈定——家长上传即家长认可，不引入未审内容；联网检索的风险面（不良结果、适龄性）完全避开。这是本方案的安全地基。
  - **两类消费方**：孩子 agent（聊天时查，回答引用）+ 家长 agent（备课/答疑引用，管理资料）。
  - **命名澄清**：本项目 "kb" 已被占用=孩子业务库（计划/积分等，`kb.sqlite`）；知识库需专名（建议 `knowledge`，独立 `knowledge.sqlite` 或挂 parent.sqlite 新表），避免混淆。
- **方案（建议）**：
  ① **数据模型（家长维度一库）**：`knowledge_docs`（id/title/source_type('pdf'|'web'|'video'|'text')/source_ref(文件 id 或 URL)/status('pending'|'ingesting'|'ingested'|'failed')/error/chunk_count/created_at）+ `knowledge_chunks`（id/doc_id/chunk_text/chunk_index/embedding BLOB/embedding_model/created_at）——文档级状态机 + 块级向量；**向量列复用 ISSUE-111 已落地的 embeddings 旁表基建**（`server/src/agent/embeddings.ts`：旁表 + OpenAI 兼容 /embeddings 客户端 + embeddingModel 配置键，均已实现），知识库是它的**首个纯语义消费方**（ISSUE-111 解决「精确匹配落空」，知识库则全程语义检索）。
  ② **摄取管线（异步，状态机驱动）**：家长上传/提交 URL → docs 记 pending → worker/异步任务按类型抽取文本 → **分块（固定长度+overlap，块带 doc 元数据）** → 逐块 embedding 入库 → ingested：
     - **PDF**：服务端文本抽取 → 分块；
     - **网页**：URL 抓取 + 正文提取（readability 类）→ 分块；
     - **视频**：**ffmpeg 抽音轨（系统 ffmpeg 已有，语音评测在用）→ ASR 转写（ASR 能力已有，ISSUE-052）→ 文本 → 分块**；关键帧 OCR 二期；
     - **失败**：status=failed + error，可重试，不阻塞其它文档。
  ③ **检索**：查询 embedding → 余弦 top-K（复用 ISSUE-111 的 JS 余弦原语）；返回 top-K（如 5）chunk + 来源元数据（doc 标题/类型）——agent 回答时可告诉孩子「出自爸爸上传的《XX》」。**混合检索（FTS5 关键词 + 向量加权）二期**，纯向量先行。
  ④ **agent 工具**：
     - 孩子 agent：`knowledge_search(query)` **只读**；prompt 段教触发时机——孩子问事实性/历史/自然问题时先查再答，无命中则回退自身知识并诚实说明（现有行为兜底）；回答用孩子语言转述（适龄化由教学 prompt 天然完成）。
     - 家长 agent：`knowledge_search` + 管理三件套（`knowledge_doc_list`（含摄取状态）/`knowledge_doc_delete`/触发重新摄取）；工具登记遵守 ISSUE-089 教训（白名单 + return 数组两处）。
  ⑤ **入口**：家长设置/新增「知识库」页（上传 PDF、提交 URL、看摄取状态列表）；家长 agent 对话上传亦可（走现有 uploads/materials 通道后转摄取）。
  ⑥ **自我完善的延伸（二期+）**：LLM 清洗——ASR 口语转写/长 PDF 由 LLM 整理为结构化知识条目（标题+要点）再入向量库，提升检索质量；孩子聊天中 agent 发现好答案可建议家长「要不要存入知识库」（家长确认制，孩子无写入权）。
- **待拍板**：① 知识库存放（独立 knowledge.sqlite vs parent.sqlite 新表）；② 分块参数与 embedding 模型（复用 embeddingModel 键即可）；③ 视频 ASR 用哪路（现有 ASR 通道 vs 专用转写）；④ 孩子 agent 是否允许查家长个人笔记类资料（建议：知识库即家长认可边界，全量可查，靠上传环节把关）。
- **检索方案调研——Obsidian 机制（2026-09-21，结论：主路线已被验证，吸收三点增量）**：
  - **Obsidian 本体**：纯本地 Markdown + **MetadataCache**（解析每条笔记的链接/标签/标题，维护 resolvedLinks 映射，反链/图谱查询免重解析）；搜索为**自研全文关键词检索（非 ripgrep，误传），无任何语义/向量能力**——本体的精髓是 **wikilink `[[链接]]` + 反向链接构成的知识图**，而非检索算法。
  - **AI 插件生态（检索真正的先进形态在插件层）**：
    - **Smart Connections**：本地 embedding 模型（transformers.js，可选 OpenAI）+ **按标题/markdown 结构分块**（非整篇一个向量）+ embeddings.json 本地存储 + 余弦检索——**与我们 ISSUE-111/120 的设计完全同构**，验证「本地 sqlite 向量 + 千行级 JS 余弦」路线在真实产品中够用；
    - **Copilot（Vault QA）**：混合检索 = 全文关键词（BM25 类）+ 向量融合，local-first；已知教训：融合排序存在「明显相关项排不上」的边界问题（GitHub issue #1799）；
    - 社区共识（Hybrid Search / VaultSearch 插件等）：**BM25 抓精确名词/标识符，向量抓同义改写，混合优于任何单一**。
  - **吸收进本方案的三点**：
    ① **分块升级为结构感知**：PDF/网页摄取按标题层级/段落结构分块（替代原「固定长度+overlap」单一策略）——Smart Connections 的分块实践，语义单元更完整、检索更准；
    ② **混合检索维持二期、但加一条验收**：融合排序（关键词分 × 向量分加权/RRF）要作为独立测试点（Copilot 的 #1799 即翻车于此），BM25 一路可用 sqlite FTS5；
    ③ **链接图一跳扩展（二期，数据模型预留）**：Obsidian 反链图谱的思想——摄取时（LLM 清洗阶段）抽实体/关联建 chunk 间 links；检索命中 top-K 后沿链接带出一跳邻域（问「赤壁之战」带出「三国时期/诸葛亮」相邻知识）。v1 不做，`knowledge_chunks` 预留 keywords/entities 字段即可。
  - **不借鉴**：Obsidian 本体关键词搜索（我们已有 FTS5 路线）；外部向量库（其 embeddings.json 本地 JSON 恰好证明我们 sqlite 方案的规模判断正确）。
- **实施拆步**：P1 表 + PDF 摄取 + 向量检索 + 家长 UI 上传 + 家长 agent 管理工具；P2 网页/视频摄取 + 孩子 agent `knowledge_search` + prompt 段；P3 LLM 清洗 + 混合检索 + 引用展示。
- **回归**：ISSUE-111 向量基建行为不变（KB 是新消费方，共享 embeddings 表时按 table_name 隔离）；现有 materials/资料下发链路零影响；孩子 agent 现有工具与教学行为不回退（新增只读工具）；家长内容库 6 表 db-channel 不受影响。
- **优先级**：中（对话质量与内容安全的双重提升；摄取管线是主要工作量，检索层现成）
- **记录时间**：2026-09-21

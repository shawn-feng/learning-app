# 英语角(English Corner)需求确认版

- 日期:2026-08-31
- 状态:需求已确认,暂不实施(代码/表/接口均未动)
- 前置调研:`RESEARCH-pronunciation-assessment-2026-08-31.md`(发音评测服务对比)

## 1. 总体模型

孩子端「英语角」显式入口 → 独立英语会话(与主学习会话并存) → 语音自由对话,每条语音并行 ASR 转写 + 发音评测 → 前端评测卡(总分+音素问题) + agent 英文点评 → 会话自动进 daily → 会话增量上云,家长端可回顾。

## 2. 已确认分叉(用户 2026-08-31 拍板)

| 决策点 | 结论 |
|---|---|
| 切换方式 | **显式入口**:孩子点「英语角」进入/退出,不做自动切换 |
| 词汇基线 | **课程提取 + 家长补充**:从孩子英语课程内容自动提取词表,家长可增减 |
| 评测范围 | **自由对话全评**:英语角每条语音都评测,ASR 文本回填 refText 自评分 |
| 会话归属 | **上云可回顾**:session-sync 改递归,英语会话同步服务端,家长端可回顾 |

## 3. 会话形态(照搬 parent-content 先例)

- 新增 `getChildEnglishSession(childId)`:独立单例缓存,会话目录 `childDir/.pi/agent/sessions/english/`(独立子目录,continueRecent 互不选中历史)。
- 独立 `systemPromptOverride` → `buildEnglishPrompt(childId, profile, vocabContext, topicContext)`:英文身份 + 词汇清单注入 + 当前主题限定;不沿用 LEARNING_NAV_INSTRUCTIONS。
- AGENTS 用户版本:agents.sqlite 按 `scope=child / ref=<childId>-english` 存英语专属行为规范,家长 AgentPromptEditor 可编辑(复用 ISSUE-033 机制,存储键需确认)。
- 工具集:主会话的导航类工具(display_content/page_action/todo_list 等)**不挂**英语会话;保留 get_date/kb_query(查词汇/课程),未来可按需加 vocab:update。

## 4. 专用 prompt(核心设计)

- **身份**:English buddy(饺子英语版),全英文交流;零基础兜底(双语开关/降级提示)待定。
- **词汇感知规则**(注入「已掌握词汇」清单后):90% 以上用词必须是孩子已认识词汇;新词每轮最多引入 2 个;引入后必须用提问确认孩子理解。
- **主题/场景限定**:家长配置「当前主题」(如 Food / Animals / Greeting / Numbers),prompt 注入「当前主题=X,只围绕该主题对话,词汇范围=主题词表」,限制交流范围防跑题。

## 5. 词汇表

- 基线来源:孩子英语课程内容(逐课提取词表)+ 家长在家长端补充/删除。
- 存储:词表属「内容/孩子画像」,按 SPLIT 约定真源上服务端;第一版可退化为注入 prompt 的文本清单(家长配置),后续迁服务端表。
- 进阶(本期不做):agent 每轮把「确认掌握的新词」写回词表(vocab:update 工具)。

## 6. 发音评测(自由对话全评)

- 链路:录音 webm → 16k wav → **并行** ASR 转写(现有 transcribeAudio)+ 发音评测 API(腾讯云智聆口语评测,备选阿里云儿童模型)。
- 自评分:自由对话无参考文本 → 以 ASR 转写文本回填 refText;评测返回整体分 + 音素级问题(如 /θ/→/s/)+ 时间戳。
- 呈现:前端评测卡(总分、问题音素高亮、原声/标准音 A/B)+ 评测结果以 user 消息附注注入 agent 上下文,agent 用英文自然点评一句。
- 接入位置:客户端主进程直连评测 API(与 voice provider 一致,key 走配置),仅英语角模式启用。

## 7. daily 记录

- **零改动自动收录**:`readDailyConversation` 递归扫 sessions 全部 jsonl(已验证),英语会话自动并入按天总结。
- 增强(可选,本期默认做):RECORDING_PROMPT 增加「英语口语练习」类别,摘要当天评测平均分 / 高频音素问题 → 家长可见发音成长。

## 8. 上云与家长回顾

- `session-sync.ts` 扫描改**递归**(当前 `fs.readdirSync` 只扫根目录),覆盖 `sessions/english/` 子目录。
- 家长端回顾:复用现有 SessionReview(ChildDetailPage「💬 对话回顾」tab),按日期可见英语会话逐字稿。

## 9. 数据模型(新增)

- agents.sqlite:`ref=<childId>-english`(英语 AGENTS 用户版本,prompt_history 回退同 ISSUE-033)。
- 词表:待定(服务端表 vs 本地 json 注入)。
- 评测配置:voice-config 扩展或独立 english-config(评测服务商 + key)。
- 评测结果:每条语音的评分建议落库(家长可见发音成长曲线),位置待定(服务端表或随 daily)。

## 10. 实施任务拆分(顺序建议)

1. 评测服务接入:新增评测 provider(腾讯云智聆)+ voice 链路 `assess`(转写/评测并行),配置项 + 设置页。
2. `getChildEnglishSession` + `buildEnglishPrompt`(独立 prompt、独立子目录、独立 AGENTS ref)。
3. 前端「英语角」入口 + chat 路由切换(进入用英语 session、退出回主会话)。
4. 词表:课程词表提取 + 家长端编辑 UI + prompt 注入。
5. 评测卡 UI + 评测结果注入 agent 点评。
6. `session-sync` 递归 + 家长端回顾验证。
7. RECORDING_PROMPT 加英语类别 + daily 摘要。

## 11. 范围 / 待定项

- **本期不做**:自动切换、手动词表维护为主、跟读题精确评测(有参考文本时天然支持,后续加)。
- **待定**:评测 API 最终选型(智聆 vs 阿里儿童 vs 开源);评测 key 存放位置;评测结果落库位置;零基础双语兜底策略。

# 设计：用阿里云 SSECP 实现「语文朗读背诵 + 英语听说」考核

- 设计日期：2026-09-07
- 依赖调研：`RESEARCH-aliyun-ssecp-child-assessment-2026-09-07.md`
- 目标：在 pi 学习伴侣中，用阿里云**智能科教内容生成平台（SSECP / AiContent）**的语音评测能力，实现两类考核：
  - **语文朗读背诵**：拼音/识字、句子/段落朗读、古诗文背诵
  - **英语听说**：单词/句子/段落跟读、自然拼读、听后问答、口语表达（看图说话/故事复述）
- 衔接现状：8-31 报告首选腾讯云智聆；本次确认阿里 SSECP 平台能力更全（且仓库已有半个客户端实现，见 §1），故本设计选 SSECP 作为语音评测引擎。

---

## 一、现有基础（避免重复造轮子）

探索确认仓库里已经具备：

| 现有模块 | 路径 | 可复用点 |
|---|---|---|
| 音频采集+转码 | `electron/lib/voice/audio.ts` → `webmToWav16k()` | 已是 **16kHz / 单声道 / 16bit PCM WAV**（`-ar 16000 -ac 1 -c:a pcm_s16le`），与 SSECP 输入一致 |
| 评测封装 | `electron/lib/assessment/index.ts` → `assessAudio()` | 已封装 `webm→wav→provider→AssessmentResult` 流程 |
| 阿里云旧接口 | `electron/lib/assessment/providers/aliyun-kid.ts` | **旧的** `en.word_kid.score`（仅英文单词、<12岁），WebSocket 流式；是 SSECP 前身，结构可借鉴但**接口不同** |
| 评测类型 | `electron/lib/assessment/types.ts` → `AssessmentResult{score, words[]}` | 扩展为多维 + 音素级结构 |
| 密钥配置 | `electron/lib/assessment/assessment-config.ts` | `providers` 已含 `aliyun-kid{appKey,appSecret,userId}`，补 `aliyun-ssecp` 即可 |
| 文件上传 | `server/src/routes/files.ts:51` → `POST /api/v1/files/upload` | 存 `data/files/<parentId>/<uuid>.wav`，返回 `file.id`；`GET /api/v1/files/:id` 下载 |
| EXAM 上报 | `server/src/routes/exam.ts` + `electron/lib/exam.ts` | `ExamPerQuestion.audioFileId`、`exam_attempts.per_question` 已支持音频题 |
| 服务端路由 | `server/src/index.ts`（`/api/v1` 前缀，`registerXxxRoutes`） | 新增 `assessment` 路由同此模式 |
| 学习计划 | `study_plan_items`（`db.ts:177`） | 本功能**不依赖**学习计划（语音评测只在考核内使用，与学习计划解耦）；仅列作上下文参考 |

> **关键判断**：SSECP 新平台的 21 种题型是 **REST API**（域名 `api.cloud.ssapi.cn`），与现有 `aliyun-kid.ts` 的 WebSocket `en.word_kid.score` **不是同一接口**。因此本设计新建服务端 SSECP REST 客户端，不直接复用 `aliyun-kid.ts`，但复用其 `AssessmentResult` 类型与鉴权思路。

---

## 二、总体架构与数据流

遵循「AI+语音留服务端、写操作在线、结果服务端为唯一真源」的架构约定，**评测调用放在 `learning-server`，不在孩子端**。

```
孩子端 Electron                        learning-server (8788)               阿里云 SSECP
─────────────────                    ──────────────────────              ───────────────
录音(MediaRecorder webm)
   │
   ├─webmToWav16k()──► 16k mono WAV
   │
   └─POST /api/v1/assessment/speech ──► 路由鉴权(assertChildOwned)
        multipart: audio(wav)              │
        + JSON: {childId,                 ├─ 读 audioFileId 或直接用上传流
            questionType,                  │
            refText, topicKey}             ├─ ssecp.ts: 调 SSECP REST
                                            │     (audio + refText + qType + token)
                                            │           │
                                            │           └──► HTTPS api.cloud.ssapi.cn
                                            │                返回 维度+音素级
                                            ├─ 落库 speech_assessments
                                            ├─ (若是 EXAM 题) 回写 exam_attempts.per_question
                                            └─ 返回 AssessmentResult(JSON)
   │
   ◄── AssessmentResult
   │
渲染：音素红/绿高亮 + A/B  playback + 维度分(完整/准确/流利/韵律)
```

**两种上传方式（二选一，推荐 B）**
- A. 直接 multipart 把 wav 传 `POST /api/v1/assessment/speech`，服务端临时落盘调 API。
- B. 先 `POST /api/v1/files/upload` 拿 `audioFileId`，再 `POST /api/v1/assessment/speech {audioFileId, questionType, refText}`。复用现有文件表，便于回放与家长端下载。**推荐 B**（与 EXAM 现有 `audioFileId` 一致）。

> **定位**：本评测端点**服务于考核（EXAM）的口语/听说题**，由考核的「作答提交」流程调用——孩子答一道口语题→录音→评测→维度分写入该次考核结果。**与学习计划无关**。

---

## 三、题型 ↔ 考核场景映射

服务端用统一 `questionType` 枚举，映射到 SSECP 题型。

### 3.1 语文朗读背诵
| 场景 | questionType | SSECP 题型 | 反馈维度 | 时长上限 |
|---|---|---|---|---|
| 拼音/识字（低龄） | `cn_pinyin` | 中文拼音 | 总分/流利/每拼音声韵母/声调 | 300s |
| 字词朗读 | `cn_word` | 中文字词 | 总体/声韵母/声调判断 | 20s |
| 句子朗读 | `cn_sentence` | 中文句子 | 流利/完整/发音/漏复读 | 40s |
| 段落朗读 | `cn_paragraph` | 中文段落 | 流利/完整/发音/漏复读 | 300s |
| 古诗文背诵 | `cn_recitation` | 中文背诵（逐字发音评分） | 流利/发音/完整 | 300s |
| 诗歌朗读 | `cn_poem` | 中文诗歌 | 流利/完整/发音/漏复读 | 300s |

### 3.2 英语听说
| 场景 | questionType | SSECP 题型 | 反馈维度 | 时长上限 |
|---|---|---|---|---|
| 单词跟读（<10岁） | `en_word_kid` | 英文儿童单词 | 单词分/重音/音素 | 20s |
| 单词跟读（≥10岁） | `en_word` | 英文单词 | 单词分/重音/音素 | 20s |
| 句子跟读（<10岁） | `en_sentence_kid` | 英文儿童句子 | 流利/完整/发音/漏复读/升降调 | 40s |
| 句子跟读（≥10岁） | `en_sentence` | 英文句子 | 同上 | 40s |
| 段落朗读 | `en_paragraph` | 英文段落 | 流利/完整/发音/漏复读 | 300s |
| 自然拼读（低龄） | `en_phonics` | 自然拼读 | 总分/发音分 | 20s |
| 发音纠错（低龄） | `en_correction` | 英文单词纠错 | 整体分/实际音标(漏多错读对比) | 20s |
| 听后问答（听说） | `en_qa` | 英文问答题 | 总体/流利/完整/发音 | 60s |
| 口语表达（看图/复述） | `en_oral` | 英文口语作文 | 总体/流利/发音/要点 | 300s |

**儿童年龄分支**：`<10 岁` 走 `*_kid` 题型；`≥10 岁` 走成人题型。年龄取自 child profile（`child_id` 对应出生日期/年级），在出题时由服务端判定注入正确 `questionType`。

---

## 四、服务端设计

### 4.1 SSECP REST 客户端 —— `server/src/assessment/ssecp.ts`（新建）
```ts
// 调用 api.cloud.ssapi.cn REST；鉴权用 AccessKeyId/Secret 做 HMAC 签名（参考 aliyun-kid 的鉴权思路）
export async function ssecpAssess(opts: {
  audio: Buffer | string;        // wav 路径或二进制
  questionType: SsecpQType;      // 见 §3 枚举
  refText: string;               // 参考文本（背诵/朗读内容）
  ext?: { userId?: string; token?: string };
}): Promise<SsecpResult> { /* ... */ }
```
- 处理题型→SSECP 参数映射、音频格式（wav/mp3 均可，服务端已转 wav）、时长上限校验（超长截断或拒绝）。
- 返回统一 `SsecpResult`：
```ts
interface SsecpResult {
  overall: number; pron: number;          // 取总分用 pron（FAQ 提示 overall 虚高）
  dimensions: { integrity: number; accuracy: number; fluency: number; prosody?: number };
  words?: { text: string; score: number; phones?: { phone: string; score: number }[] }[];
  cnSyllables?: { syllable: string; initial: number; final: number; tone: number }[]; // 中文声韵母/声调
  keyPoints?: number;                     // en_oral 要点覆盖
  raw: unknown;                           // 原始 JSON 留存
}
```

### 4.2 路由 —— `server/src/routes/assessment.ts`（新建，在 `index.ts` 注册）
```ts
// POST /api/v1/assessment/speech
// body(JSON): { childId, audioFileId, questionType, refText, topicKey?, isExam? }
// 鉴权: authParent → verifySession → assertChildOwned
// 流程: 读 files 表拿 wav → ssecpAssess → 落库 → 返回 SsecpResult
// GET  /api/v1/assessment/results/:childId?from=&to=   // 历史（家长端/离线浏览）
```

### 4.3 存储 —— `speech_assessments` 表（新建，`db.ts`）
```sql
CREATE TABLE speech_assessments (
  id INTEGER PRIMARY KEY,
  parent_id TEXT NOT NULL,
  child_id  TEXT NOT NULL,
  topic_key TEXT,
  course_name TEXT,
  question_type TEXT NOT NULL,   -- §3 枚举
  ref_text TEXT,
  audio_file_id TEXT,            -- 关联 files 表，便于回放
  overall REAL, pron REAL,
  dimensions_json TEXT,          -- 完整/准确/流利/韵律
  detail_json TEXT,              -- 音素级/声韵母级（用于高亮）
  is_exam INTEGER DEFAULT 0,
  exam_attempt_id TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```
> 结果落服务端 = 唯一真源；缓存键可用 `hash(audioFileId+questionType+refText)` 去重，省调用（按并发计费场景下省钱）。

---

## 五、孩子端体验

1. **录音**：复用 `webmToWav16k()`，按 `questionType` 设最大时长（单词 20s / 句子 40s / 段落·背诵 300s），到点自动停。
2. **上传+评测**：调 `POST /api/v1/assessment/speech`（方式 B），拿 `SsecpResult`。
3. **结果展示**：
   - 维度卡：完整度 / 准确度 / 流利度 / 韵律度（韵律需标注才有）。
   - **音素级高亮**：英文按 `words[].phones[].score` 红(低)/绿(高)着色每个音素；中文按 `cnSyllables` 声韵母/声调着色。
   - **A/B 对比**：原声（TTS 或素材音频）vs 孩子录音，逐句/逐字回放。
   - 背诵题：逐字发音评分（用 `cn_recitation`，**考核提交时统一打分**，不打断答题）。
4. 反馈文案：低分音素给「再来一次 / 慢放 / 示范」按钮。

---

## 六、核心集成：语音评测 = 考核（EXAM）的口语/听说题判分引擎

本功能**只在考核内使用**。一道考核可以包含若干「口语题」（语文朗读/背诵、英语听说），其判分由 SSECP 完成，而非现有客户端 LLM（EXAM 客观题仍走 LLM）。

### 6.1 题目表达（出题侧）
- 在 EXAM 的 course 配置里，口语题用 `assess_method='speech'` 标记，并带 `questionType`（见 §3 枚举：如 `cn_recitation` / `en_qa`）、`refText`（参考文本/背诵内容）、`rubric`（分数映射规则）。
- 沿用 EXAM v3 的两段式 config：`?schedule`（排期，无 rubric）+ `&courses`（带 rubric+scoring）；口语题只在 `&courses` 段表达。固定每天/每周考核（weekly{weekday,time}）因此可直接编排「语文朗读」「英语听说」题。

### 6.2 作答与判分流程（一次口语题的生命周期）
```
1. 出题: 服务端下发口语题(questionType, refText, rubric) 给孩子端
2. 作答: 孩子端录音 → webmToWav16k → POST /api/v1/files/upload → audioFileId
3. 判分: 孩子端/服务端 调 POST /api/v1/assessment/speech
          { audioFileId, questionType, refText }
        → 服务端 ssecp.ts 调 SSECP → SsecpResult(维度分+音素级)
4. 映射: pointGot = rubric(pron/维度分) ; aiComment = 维度+音素汇总
5. 上报: POST /api/v1/exam/attempts，该题写入 ExamPerQuestion:
        { qid, question, audioFileId, speech: SsecpResult,
          pointGot, pointMax, correct, aiComment }
6. 落库: exam_attempts.per_question(JSON) 已支持 audioFileId，扩展含 speech 明细
```
- `ExamPerQuestion` 扩展字段：`speech: SsecpResult`（维度分 + 音素/声韵母级明细），其余字段（pointGot/aiComment）沿用现有结构。
- 判分口径服务端单一真源（延续 ISSUE-027 原则）：客户端不再用 LLM 判口语题，改调服务端 SSECP。

### 6.3 与现有 EXAM 的兼容
- 客观题（选择/填空等）保持原 LLM 判分不变；**仅 `assess_method='speech'` 的题走 SSECP**。
- `speech_assessments` 表（§4.3）作为口语题结果的详细存档，通过 `exam_attempt_id` 关联回 `exam_attempts`，便于家长端回放与审计。

---

## 七、家长端：在考核结果结构里查看维度分与录音回放

家长看到的是**一次考核（exam attempt）的结果**，口语题在该结果内展开，不另起一套"学习记录"feed。

- **入口**：家长端打开某次考核结果 → 逐题列表；口语题（语文朗读/背诵、英语听说）卡片内展示：
  - **维度分**：完整度 / 准确度 / 流利度 / 韵律度（韵律需标注才有），以及总分 `pron`。
  - **录音回放**：点击播放孩子当题录音（`GET /api/v1/files/:id`，经 `audioFileId` 取 wav，流式 + 归属校验）。
  - **音素级明细**：英文按 `words[].phones[].score` 红/绿高亮每个音素；中文按 `cnSyllables` 声韵母/声调着色（可折叠，默认展示维度分+回放）。
- **数据来源**：全部来自服务端 `exam_attempts.per_question` 中该题的 `speech` 字段（SSECP 结果），遵循「学习记录永远在服务端」约定；客户端离线仅可浏览缓存。
- **音素高亮截图** optional：可在回放旁附静态高亮图，便于家长快速扫读薄弱音素。
- **与学习计划解耦**：本功能不写入 `study_plan_items`，也不依赖学习计划；它只是考核体系内的一类题型与判分方式。

---

## 八、配置与密钥

- 在 `assessment-config.ts` 的 `providers` 加 `aliyun-ssecp { accessKeyId, accessKeySecret, endpoint? }`；**服务端**从 `SERVER_DATA_DIR/assessment-config.json` 或环境变量读取（密钥不出服务端）。
- ⚠️ **安全**：仓库根 `aliyun-aksk.txt` / `tencent-aksk.txt` 含明文 AK/SK 且已提交 git —— 生产必须移入环境变量/config，并从 git 清理（或加 .gitignore + 轮换密钥）。
- 复用 `maskSecret` 打码逻辑，前端不展示明文。

---

## 九、音频与工程约束（对齐 SSECP FAQ）

- 格式：wav/mp3/ogg/ogg_opus/amr；服务端已转 wav，OK。
- 采样：16k 单声道（已满足）。
- 时长上限：单词 20 / 句子 40 / 段落·背诵·诗歌 300 / 问答·口语作文 60~300（见 §3）。
- `pron` vs `overall`：展示与判分统一用 `pron`。
- 开放式（en_qa/en_oral）= 语音+语义+语法综合，返回要点分，适合主观口语考核。

---

## 十、计费与并发（据调研）

- 按并发：4.25 元/天·并发、85/月、1020/年；或后付+资源包（单 call 价未公开需询价）。
- 家庭局域网单孩子并发极低（≤1~2），按并发按天档足够；**结果缓存去重**进一步降本。
- ⚠️ 平台 2026-03 才公测，价格/稳定性可能变动，接入前控制台确认。

---

## 十一、分阶段落地里程碑

| 阶段 | 内容 | 交付 |
|---|---|---|
| P0 | 服务端 `ssecp.ts` REST 客户端 + 鉴权 + 1 题型冒烟（en_word） | 能返回维度分 |
| P1 | 语文：cn_sentence/cn_paragraph/cn_recitation/cn_poem/cn_pinyin | 朗读背诵闭环 |
| P2 | 英语：en_word/en_sentence/en_paragraph/en_phonics/en_correction/en_qa/en_oral + 年龄分支 | 听说闭环 |
| P3 | EXAM `assess_method='speech'` 题型 + 判分改写 | 固定考核含口语 |
| P4 | 家长端考核结果展示（维度分+录音回放）+ 音素红绿高亮 UI + A/B 对比 | 全链路可见 |
| P5 | 密钥安全清理（去 git）+ 结果缓存降本 + 并发压测 | 生产可用 |

---

## 十二、风险与待确认

1. **接口本质**：新 SSECP 口语评测**底层就是**旧 `aliyun-kid.ts` 那套声希引擎（同 `api.cloud.ssapi.cn`、同 `coreType` 协议、同 MD5 鉴权）。故实现是**扩展**该协议到全部 coreType 并移植服务端，而非另接 AiContent OpenAPI（见 §13）。
2. **公测风险**：2026-03 公测，文档/价格/稳定性可能变；建议先 P0 冒烟再投入 P1+。
3. **儿童年龄边界**：阿里儿童题型仅 <10 岁，≥10 走成人题型，出题逻辑须分支（年龄来源待确认：child profile 年级/生日）。
4. **密钥已泄露风险**：`aliyun-aksk.txt` 明文进 git，上线前必须轮换+移出仓库。
5. **网络出口**：learning-server 在 192.168.1.201，需确认能访问公网 `api.cloud.ssapi.cn`（家庭宽带/防火墙）。
6. **与腾讯云智聆的取舍**：若只做单词/句子跟读，腾讯更便宜且已接；本设计选阿里是因需中文朗读背诵+开放式口语（腾讯覆盖不全）。可在 P0 后复核成本。
7. **韵律维度**：需标注文本才返回，背诵/段落若不需要可省略。

## 十三、实现进展（2026-09-07 落地）

**关键修正**：设计阶段原以为 SSECP 新平台要走 AiContent OpenAPI（`alibabacloud-aicontent20240611`）。实测确认其**口语评测底层就是现有 `electron/lib/assessment/providers/aliyun-kid.ts` 那套声希引擎**（`api.cloud.ssapi.cn`、同一 `coreType` 协议、同一 MD5 鉴权）。因此实现改为**把已验证协议移植到 `learning-server` 并扩展全部 coreType**，而非另接 OpenAPI——复用成熟代码、降风险，且评测调用放服务端（符合「服务端真源」）。

**已落地（服务端为评测调用真源）**
- `server/src/assessment/question-types.ts`：题型枚举 ↔ 声希 coreType 映射（21 题型；不确定项标注 ⚠️ 待实测）。
- `server/src/assessment/ssecp.ts`：Node 端口（全局 WebSocket + node:crypto）调声希引擎；解析 `overall/pron/accuracy/integrity/fluency{rhythm}/words{phones,dp_type}/cnSyllables/audioQuality`。
- `server/src/db.ts`：新增 `speech_assessments` 表（维度分 + 音素级明细 + audio_file_id 回放）。
- `server/src/routes/assessment.ts`：`POST /api/v1/assessment/speech`（audioFileId+题型→调 SSECP→存档→返维度分）、`GET /api/v1/assessment/results/:childId`（家长回放/审计）。
- `server/src/index.ts`：注册路由。
- `electron/lib/exam.ts`：`assessSpeech()` 客户端助手 + `speechPronToPoint()`（pron→pointMax 默认算分）。

**待完成（客户端/UI 接线，需渲染层）**
- **T5 EXAM 判分接线**：考核口语题在作答流中改调 `assessSpeech`（而非 LLM），`pointGot` 用 `speechPronToPoint`；在 ExamView/判分入口按 `assessMethod==='speech'` 分支（题目需带 `questionType`+`refText`）。
- **T6 家长端**：在考核结果组件内渲染维度分（完整/准确/流利/韵律+pron）+ 录音回放（复用 `getExamAudioDataUrl`/`audioFileId`）+ 音素红绿高亮。
- **密钥**：服务端读 `assessment-config.json` 的 `aliyun-kid`/`aliyun-ssecp`；生产应移出 git（`aliyun-aksk.txt` 明文风险）。
- **coreType 实测**：标注 ⚠️ 的题型（`en_sent_kid`/`en_qa`/`en_oral`/`cn_pinyin` 映射）首次联调需确认。

> 服务端引擎已落地并通过类型检查；下一步接 T5（EXAM 判分分支）与 T6（家长端维度分+回放 UI）。

---

## 十四、中文背诵集成设计（论语场景 · 2026-09-07 调研）

> 用户场景：考核《论语》时出「背诵题」，孩子点击语音按钮开始背诵，**考核结束后一次性提交，服务端对背诵音频批量自动评分**（逐字发音分 + 维度分），家长端在考核结果里看维度分与录音回放。不打断答题实时评分（避免阻塞）。
> 本节基于通读真实代码给出**精确接线点**（非空想）。改动只涉及「出题扩展 + 类型 + 客户端分支 + UI + 家长端渲染」，服务端 `/assessment/speech` 与 `speech_assessments` 表已在 §13 落地。

### 14.1 现有考核全链路（实测，文件:行）

| 阶段 | 真实代码 | 行为 |
|---|---|---|
| **出题** | `src/components/ExamView.tsx:172` `beginStreaming` → `examGenerateCourse`(:199) → `electron/lib/exam-engine.ts:131` `generateCourseQuestions` → `:148` `generateForCourse` | LLM 读课程 `assessRubric`，输出 `{"questions":[{"qid","course","stem","pointMax":10}]}`。**全是口述题**（无题型/refText 概念）。流式逐门追加（`exam-template.ts:218` `appendCourseQuestions`）。 |
| **答题录音** | `src/lib/exam-template.ts`（iframe）`startRec`(:293)/`onStopRecording`(:305) | 每题一个 🎤「按住说话」按钮（push-to-talk）→ `MediaRecorder` → blob→base64 存 `answers[qid].segs` → `postMessage({type:"exam:asr",qid,blob})`(:333)。 |
| **转写** | `ExamView.tsx:229` `onMessage` `exam:asr` → `window.api.voiceTranscribe` → `postMessage({type:"exam:asr:done",qid,text})` | ASR 文本回填文本框（当前所有题都走这条）。 |
| **判分** | `ExamView.tsx:251` `handleSubmit` → `examScore`(:282) → `electron/lib/exam-engine.ts:236` `scoreExamAttempt` | LLM 按 rubric 给每题 `pointGot/correct/aiComment`（基于 ASR 文本）。 |
| **上传+提交** | `ExamView.tsx:286-337` → `window.api.examSubmit` → `ipc-handlers.ts:2147` `exam:submit`（合并多段语音→`uploadExamVoice`→`audioFileId`→`submitExamAttempt`） | 录音在**提交时**才上传，写 `exam_attempts.per_question.audioFileId`。 |
| **家长端** | `src/components/ExamRecords.tsx` `AttemptPerQuestion`(:21) + `playAudio`(:101 `examAudio`) | 逐题得分 + ASR + ▶听原音。**无维度分/音素高亮字段**。 |

### 14.2 现状与背诵需求的 Gap

1. **语料无「背诵」题型**：`lunyu_exam/*考核内容.json` 只有 `题目类别:选择题/问答题`，评分标准里一句「若只背原文未用自己的话解释则少给分」——背诵是被 LLM 贬低的弱答案，**没有 refText、没有逐字评**。
2. **出题只输出 stem**：`GeneratedQuestion`（`exam-engine.ts:20`）无 `assessMethod/questionType/refText`，背什么完全靠 LLM 即兴，易错字漏字。
3. **录音→ASR→LLM 链路对背诵不适用**：背诵是 refText 已知的，应走「录音→SSECP 发音评测→逐字分」，不该绕 ASR+LLM。
4. **preload 未暴露 `assessSpeech`**：`electron/preload.ts` 有 `saveUpload`(:81)/`voiceTranscribe`(:317)/`assessmentTest`(:326)，但**没有生产级 `assessSpeech` 桥**——host 渲染层不能直接调 SSECP（客户端助手 `exam.ts:380` 走 `serverFetch`，渲染层无法 import 主进程 lib）。**必须新增桥**。
5. **评测时机定为「提交时批量」**：背诵**不打断答题实时评分**（避免阻塞）。沿用现有「提交时上传音频」架构，在 `handleSubmit` 的 `scoring` 阶段对背诵题并行调 SSECP（与口述题 LLM 判分同处一个「老师正在批改」等待屏）。

### 14.3 集成方案（论语背诵端到端）

**A. 语料层** — 给《论语》每章补 `题目类别:"背诵"` + `refText`（原文，如「学而时习之，不亦说乎」）。refText 由语料**结构化直给**，不靠 LLM 转写（避免错字）。可放在 `必考题` 或新增 `背诵题` 块。

**B. 出题层** — `exam-engine.ts generateForCourse`：
- 识别 rubric 里的「背诵」题，输出扩展结构（扩展 `GeneratedQuestion`）：`{qid,course,stem,pointMax,assessMethod:"speech",questionType:"cn_recitation",refText}`。
- 理解/应用题仍走原 LLM 口述题（维持现状）。
- 扩展类型：`electron/lib/exam.ts` `ExamCourseConfig`/`ExamTopicConfig` 不变；`GeneratedQuestion`(:20)、`ExamPerQuestion`(:73) 加 `assessMethod?/questionType?/refText?/speech?:SpeechAssessment`。
- iframe `appendCourseQuestions`(:218) 把 `questionType/refText` 透传到题对象。

**C. 答题 UI（iframe `exam-template.ts`）** — 背诵题**复用现有「按住说话」录制交互**（按压录音、松手即停，避免长录忘关），与口述题一致；支持**多段录音**，提交时由现有 `voiceMerge` 拼接为单段音频（拼接逻辑已有，无需新写）。仅两处差异：
- `cn_recitation` 显示参考原文；`onStopRecording` 后**不发 `exam:asr`**（背诵不需要 ASR 文本），多段录音照存 `answers[qid].segs`，待提交时统一上传+拼接+打分。
- 口述题维持原样（发 `exam:asr` → LLM 判分）。
- 答题过程不回填分数（避免阻塞），维度分/红绿高亮在提交后的结果页展示。

**D. 判分/提交时批量评（host `ExamView.tsx.handleSubmit`）** — 复用现有「提交时上传」架构，评测放在 `scoring` 阶段（与口述题 LLM 判分同处一个等待屏，不阻塞答题）：
1. `handleSubmit`(:251) 先把口述题交给 `examScore`(:282)（LLM，基于 ASR 文本），**背诵题从送判答案中剔除**（不送 LLM）。
2. 原有上传步骤(:286-337)对每题合成音频；**背诵题额外取 `audioFileId`**（服务端统一转 16k wav 再送 SSECP）。
3. 对背诵题 `Promise.all` 并行调 `window.api.examAssessSpeech(childId,audioFileId,questionType,refText)`（**新增 preload 桥** → `exam.ts assessSpeech` → `/assessment/speech`），获 `speech` 维度分；并行降低总等待。
4. `speechPronToPoint(speech,pointMax)`（v1 用 `pron`；背诵后续加权 `0.5*integrity+0.5*pron`）得 `pointGot`，回填 `perQuestion`。
5. `perQuestion` 写 `audioFileId` + `speech`（维度分/音素明细），随 `examSubmit` 入库。

**E. 家长端（`ExamRecords.tsx`）** — `AttemptPerQuestion` 增 `speech?` 字段；该题渲染：维度分（完整/准确/流利/韵律+pron）+ ▶回放（`examAudio(audioFileId)`）+ 音素红绿高亮（折叠加 `speech.cnSyllables`/`words`）。与 §7 一致。

### 14.4 接线点清单（实现时按此改，本节为设计不打码）

| 改动 | 文件:位置 | 说明 |
|---|---|---|
| 语料加背诵题+refText | `lunyu_exam/*.json` | 每章 1 道必背，refText=原文 |
| 扩展题型类型 | `exam-engine.ts:20` `GeneratedQuestion`；`exam.ts:73` `ExamPerQuestion` | + assessMethod/questionType/refText/speech |
| 出题识别背诵 | `exam-engine.ts:148` `generateForCourse` | rubric 含背诵→输出 speech 题 |
| 新增 preload 桥 | `preload.ts`（仿 `:326` `assessmentTest`）+ `ipc-handlers.ts` | `examAssessSpeech` → `exam.ts assessSpeech` |
| iframe 背诵交互 | `exam-template.ts:293/333` | 背诵题沿用「按住说话」+多段拼接(`voiceMerge`)，不发 `exam:asr` |
| 提交时批量评 | `ExamView.tsx:251/282` | 背诵题跳过 LLM，改并行 `examAssessSpeech` |
| 家长端渲染 | `ExamRecords.tsx:21/101` | 维度分+回放+高亮 |
| 服务端（已完） | `routes/assessment.ts` + `ssecp.ts` + `speech_assessments` | §13 已落地 |

### 14.5 关键设计决策与风险

- **refText 来源**：必须语料结构化给，**不要**让 LLM 重写原文（错字漏字会让逐字评失真）。
- **评测时机（已定）**：背诵**提交时批量评**，不打断答题实时评分（避免阻塞考核）。沿用现有「提交时上传音频」架构，在 `handleSubmit` 的 `scoring` 阶段并行调 SSECP。口述题维持 LLM 判分现状。
- **coreType**：中文背诵用 `cn_recitation`（声希 `cn.pred.score` 族，§12 已记录 ⚠️ 待首测确认映射）。
- **年龄分支**：≥10 岁用成人题型；论语通常 ≥6 岁，按 child profile 年龄选 coreType（§12-3）。
- **背诵算分权重**：v1 用 `pron`（=speechPronToPoint）；背诵更应重「完整度 integrity」（考记忆），后续可加权 `0.5*integrity+0.5*pron`。
- **语料规模**：`lunyu_exam/` 有 100+ 章 json，批量补 `refText` 可用脚本；建议先挑 3~5 章做 POC。
- **缺口修复优先级**：preload `examAssessSpeech` 桥仍是拦路项（否则 host 在提交时调不到 SSECP），在 `handleSubmit` 提交阶段调用即可；iframe 背诵交互只需改「点击录制」且无需发实时消息。

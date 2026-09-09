# 考核内容结构化（类型块 + 内嵌评分）设计定案 — 2026-09-09

> 状态：**设计已与用户定案，待实施**（ISSUE-067）。本文是实施唯一依据；改动前先读此文档与
> `electron/lib/assess-guide.ts`（ISSUE-066 产物，写作规范，后续需与本设计对齐改写）。

## 0. 背景与目标

- 现状：每课考核内容（rubric）为**一整段 markdown 自由文本**（家长库 `courses.assess_rubric`，
  论语 489 课 avg 5,153 字 / max 8,685），且将随「收集例题」持续增长。
- 出题/判分当前**整文喂给 LLM** → 慢（实测出题 40-90s / 判分 60-100s）、费 token，且例题越多越贵。
- 目标（用户 2026-09-09 拍板）：
  1. 考核方法决定「考什么类型」→ 出题只取对应**类型块**，不必读整份内容；
  2. 评分标准**随题内嵌** → 判分只带抽中那题的评分，与整份课程内容解耦；
  3. 例题/题量增长不影响单场读取量（每类型多题 = 池内抽题，不是全文变大）；
  4. 背诵原文结构化（refText 字段），不再靠正则从全文抓引号。

## 1. 三层模型

| 层 | 职责 | 存放 | 谁维护 |
|---|---|---|---|
| **题型目录**（主题级） | 定义该主题有哪些「类型」：类型名 + 别名归组 + 引擎行为 | 主题（`topics`） | 家长 agent / 后台脚本（低频） |
| **课程考核内容**（每课） | 每课的「类型 → 概述 → 若干主观题（题干+评分一体）」 | 家长库块表 `course_assess_blocks` | 家长 agent / UI / 后台脚本 |
| **考核方法 methodSpec**（主题级·每孩子） | 每孩子考哪些类型（数量）、排除哪些、特殊口径（背诵通过线） | 主题（`topics`） | 家长 agent / 配置界面 |

读取规则：**方法 → 目录（别名归组）→ 逐类型取题/取 refText → 题自带评分 → 判分随题走**。

## 2. 数据模型（DB 为真源，工具直写块）

### 2.1 题型目录 —— `topics.type_catalog`（JSON）

```jsonc
{
  "catalog": [
    { "name": "背诵",      "aliases": ["原文背诵", "背诵原文"],        "behavior": "speech_recite" },
    { "name": "朗读",      "aliases": ["朗读", "跟读"],                "behavior": "speech_read" },
    { "name": "句意白话",  "aliases": ["句子意思", "白话翻译", "句意理解", "翻译"], "behavior": "generic" },
    { "name": "道理",      "aliases": ["道理应用", "情景应用", "生活应用"], "behavior": "generic" },
    { "name": "字词",      "aliases": ["字词读音", "字词理解", "字词含义", "字词读音与含义", "重点字词"], "behavior": "generic" },
    { "name": "典故",      "aliases": ["典故理解", "相关典故"],        "behavior": "generic" }
  ]
}
```

- `name` 为规范类型名（块表与 methodSpec 都用它）；`aliases` 负责旧文本/口语归组（解决
  「字词读音/字词理解/字词含义」同词多写漏匹配问题）。
- 引擎只认 `behavior`：`speech_recite`（发音评测：refText、不显原文、置首题、通过线见 method）、
  `speech_read`（同链路但显示原文，可扩展）、`generic`（口述主观题：LLM 判分）。**引擎不需要为每个学科加特例。**

### 2.2 考核方法 —— `topics.method_spec`（JSON，key 用 childId 不用显示名）

```jsonc
{
  "perChild": {
    "<child_uuid>": {
      "require": { "背诵": 1, "句意白话": 1, "道理": 1 },
      "exclude": ["字词", "典故"],
      "rules": { "recitePass": 90 }
    }
  }
}
```

- 每主题默认一套「未声明孩子」回退（如 `default` 节点），保证新孩子也有方法可用。
- 旧 `assess_method` 散文保留给人看/迁移期对照（真源是 methodSpec）；孩子改名不断链（uuid key）。

### 2.3 课程考核内容 —— 家长库新表 `course_assess_blocks`

```sql
CREATE TABLE IF NOT EXISTS course_assess_blocks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  topic       TEXT NOT NULL,            -- topic_key
  course      TEXT NOT NULL,            -- 课程标题（与 courses.title 对应）
  type        TEXT NOT NULL,            -- 规范类型名（取自该主题 catalog）
  seq         INTEGER NOT NULL DEFAULT 0, -- 块内/作者展示顺序
  kind        TEXT NOT NULL,            -- 'summary' | 'question'
  payload     TEXT NOT NULL,            -- JSON，见下
  created_at  TEXT, updated_at TEXT,
  UNIQUE(topic, course, type, kind, seq)
);
CREATE INDEX IF NOT EXISTS idx_cab_course ON course_assess_blocks(topic, course);
CREATE INDEX IF NOT EXISTS idx_cab_type    ON course_assess_blocks(topic, type);
```

payload：

```jsonc
// kind='summary'：类型概述
{ "overview": "能用自己的话把三句话意思讲清楚，允许生活小例子；背诵逐字发音评测、90 分通过。" }

// kind='question'：一道主观题（题干 + 评分一体）。背诵/朗读类额外带 recite。
{
  "stem": "请你当小老师，用自己的话讲讲孔子三句话的意思。三句话是“学而时习之…”…",
  "pointMax": 10,
  "scoring": {
    "dims":  [ { "dim": "句子意思解释", "points": "第一句：复习+快乐", "score": 2, "note": "两个要点各1分" } ],
    "special": [ "若只背原文不用自己的话，表达项不得分，可酌情给 1-2 分" ],
    "answerRef": "参考要点文本（判分锚定，可空）"
  },
  "recite": { "refText": "子曰：学而时习之，不亦说乎？…君子乎？" }   // 仅背诵/朗读类
}
```

约定：
- **无选择题**：全部主观问答题（用户明确）。旧库选择题在迁移时转主观（去选项、题干口述化、按标准答案转评分要点）。
- 同 `(type, kind='question')` 可多条 = **例题池**（收集例题的落点）；出题时按池抽题，读取量与池大小无关。
- 抽题顺序/轮换策略见 §5 未决；首版可用「随机抽 1」或「必考标记 + 轮换」。

### 2.4 与旧 `assess_rubric` 的关系（兼容红线）

- `assess_rubric` 保留：`courses` 无块记录（未迁移课）→ 走**旧整文路径**（LLM 全文出题/判分），行为不回退；
- 已建块的课 → 只读块表；`assess_rubric` 可用生成器渲染出 markdown 供人审阅/导出（预览，非真源）。

## 3. 写入 / 读取链路

### 写入（DB 为真源）
- 建课/改课：工具（家长 agent）/ UI 结构化编辑器 以**整课事务替换**写入块（types→summary→questions）；
- 积累例题：追加某 `(course,type)` 的 question 行（不动其它块）；
- 工具保存时同步维护 `type_catalog`/`method_spec`（主题级）。

### 读取（考核）
1. 服务端 config：取课程 blocks（按课整取）+ 主题 `methodSpec`；
2. 按孩子：`exclude` 过滤 → 依 `require` 逐类型找题池；
3. 每类型抽 1 题；**该类型无题 → 跳过该类型**（用户已定，不做 LLM 临时命题）；
4. 题序：`speech_recite` 置该课最前（背诵检测真实性），其余按 require 顺序；
5. 组装题：`{qid, course, type, behavior, stem, pointMax, refText?, scoring?}` → 下发答题页。

### 判分
- 文字口述题：**逐题小 prompt** = 总则 + 该题 `{题干, 孩子ASR回答, scoring.dims/special/answerRef}` → 分/评语；可并行。
- 背诵/朗读：发音评测（refText），≥ `recitePass` 通过。

## 4. 存量迁移（未决，后置）

- 489 课 `assess_rubric` markdown 一次性迁移为块：
  1. 解析「一、考核知识点 / 二、题目（必考+可选题×3）」；
  2. 选择题 → 主观题（去选项 + 按标准答案生成评分要点）；
  3. 类型标注（规则 + LLM 辅助 + 人工抽检）。
- 标注方式（自动归类+抽检 / 只迁部分 / 全人工）用户明确**先不定**，等结构方案落地后再选。

## 5. 验收标准

- 珊珊（论语主题）：出 背诵 + 句意白话 + 道理 各 1 题，无字词/典故；闻闻：背诵 + 句意白话。
- 已结构化课程出题 **0 次 LLM 调用**（纯代码抽题），判分每题 prompt < 1KB 级（现 rubric 5KB+ 整课带）。
- 例题池加题不影响该课其它类型与单场读取量；背诵题 refText 来自块字段（无正则）。
- 未建块课程行为与今天一致（兼容红线）。

## 6. 未决清单（实施时逐项确认）

1. 例题池抽题策略：随机 / 最近未用轮换 / 「必考」标记优先。
2. `type_catalog` / `method_spec` / `course_assess_blocks` 三方可写工具与校验（写时警告：方法声明的类型在课程无题池 → 该类型本场会被跳过）。
3. 判分评语：LLM 按题评分时生成 vs 纯维度模板（影响判分是否仍需 LLM）。
4. 旧 `assess_method` 散文与 methodSpec 并存期的同步/展示。
5. `assess-guide.ts`（ISSUE-066）写作规范与本设计对齐改写（新写作入口 = 结构化块，不再是 rubric 三段 markdown）。
6. 家长端考核内容编辑器改结构化表单（目录选类型、题+评分行列编辑、例题追加）。

## 7. 关联

- ISSUE-067（本设计，待实施）；ISSUE-065（选课机制，已实施）；ISSUE-066（agent 写 rubric 能力，已实施，待对齐）。
- 数据真源：家长库 `server/data/parents/<parent>/parent.sqlite`（topics / course_assess_blocks）。

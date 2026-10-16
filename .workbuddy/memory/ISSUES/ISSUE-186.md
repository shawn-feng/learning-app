# ISSUE-186：「按本周错题本里的字词安排考核与学习计划」家长 agent 做不到——5 个坎的代码级核对与候选方案

- **类型**：需求缺口 + bug（工具面缺读写口径；1 处静默丢弃）
- **优先级**：**高**（家长最自然的诉求之一：这周错得最多的字，给我考一考、排一排）
- **状态**：📋 **已记录，待拍板**（本文件只做核对与方案；除注明外**未改代码**）
- **记录时间**：2026-10-16
- **标签**：`家长agent` `错题本` `mistake_book` `考核` `parent_exam_plan_create` `methodSpec` `知识点` `字词` `缺题`
- **关联**：ISSUE-114（错题本设计与三采集渠道）、ISSUE-135（掌握/缺口分析）、ISSUE-144 P4（家长侧专用只读报告工具）、ISSUE-103（`parent_upsert_course_content` 整课替换）、ISSUE-141/142（"没数据"与"没口径"的区分）

---

## 一、用户报告（原文）

> 在让家长 agent 按照本周错题库里的字词错题安排考核及学习计划时，agent 无法完成，原因如下：
>
> 1. **考核不能"按日期"建。** 建考核工具只能指定"考哪门课"，再用参数限定"考哪几个知识点"——没有"这一周"这个维度。所以"这一周的字词"必须先落成一份知识点清单，才能指定着考。
> 2. **「字词」课 89 个字词，只有 29 个有题。** 有题（能考）的 29 个：批评、随、含…风；没题（出不了题）的 60 个里有：毛糙、糙、调…晒。⚠️ 最要命：闻闻这周错得最多的两个字——**「验」（3 次，10-14）**、**「迫」（3 次，10-14）**——正好都躺在"没题"里。
> 3. **"这一周的字词"系统给不出逐条清单。** 错题本只有汇总数字：闻闻 生字 56 条未掌握（本周新增 37 条）；珊珊 生字 118 条（本周新增 11 条）。工具没有"按日期筛字词"的口径。
> 4. **有些字词根本不在「字词」课里。** 比如这周学的子罕篇／乡党篇的字词（恂恂、便便、谨），在各自那门课的字词考点下。
> 5. **补题属于"写库"，得先过家长的手。** 整课替换会重写这门课，必须先列"补哪几个字、每题问什么"给家长确认。

---

## 二、逐条核对（代码级，2026-10-16）

### 坎 1：考核确实没有"时间范围"维度 —— **成立**
`parent_exam_plan_create`（`server/src/agent/parent-plans.ts:749`）参数只有：`childName` / `scheduledAt`（**开考那一天**）/ `courses`（精确课程名数组）/ `name` / `note` / `retake` / `methodSpec{require,exclude,recitePass}`。
出题范围在**创建时即展开**成 `scope.courses = [{title, kps:[{name,count}]}]`（`buildPlanSpecEntries`，`server/src/assess-selection.ts:285`）——**只有"哪门课、哪些知识点、各几题"，没有任何日期/周维度**。
⇒ "这一周的字词"必须先变成一份**知识点清单**（这正是坎 3 给不出来的东西）。

### 坎 2：知识点存在但**没挂题** = 考不了 —— **成立，且比报告的更糟**
- `buildPlanSpecEntries` 先 `const withQ = content.items.filter(it => it.questions.length > 0)`（:301），后续 `methodSpec.require` 的匹配**只在 withQ 里做**（:343-358）。
- ⇒ 家长点名要考的「验」「迫」若**没挂题**：**被静默丢弃**——只要同一门课里还有别的必需知识点有题，考核就"创建成功"，而家长要考的那个字**根本没考**（工具返回里不会提）。若整批必需知识点都没题，才报「按考核方法过滤后没有可考知识点」。
- 家长 agent 是能看见"哪个知识点没挂题"的：`parent_library_course_content`（`parent-tools.ts:987`）对没题的 kp 会标「（未挂题）」——但要**逐课**调用，且得先知道是哪门课（见坎 4）。
- 现场数据（用户实测）：「字词」课 89 个知识点、其中 29 个有题；未掌握数最多的「验」「迫」都在没题的 60 个里。

### 坎 3：错题本**给不出"这一周"的逐条清单** —— **成立（纯读口径缺口）**
- 数据是有的：`mistake_book`（`server/src/db/kb.ts:17`）每行都有 `first_seen` / `last_seen` / `count` / `kind` / `content` / `detail` / `course_ref` / `knowledge_point_id` / `knowledge_point_name` / `question_id`。
- 但**读的口径**只有聚合：
  - 家长侧唯一相关工具是 `parent_child_mastery_report`（`parent-child-report-tools.ts:349`），错题段 `mistakeSection`（:431-455）**按 kind 聚合成一行**，只展开 `count` 最大的 **前 3 条**（带课程/知识点/最近日期）——用户看到的"56 条（本周新增 37 条）"就是它；
  - `listMistakes()`（`server/src/db/mistakes.ts:93`）只支持 `status` / `kind` / `limit`，**没有日期过滤**；
  - 孩子侧 `child_mistake_log(action=list)`（`child-db-tools.ts:104-116`）输出 `[id] kind：内容（次数）｜课程｜知识点`——**一个日期都没有**；
  - 家长侧**没有**任何直读错题本的工具（ISSUE-144 P6 已把通用 `parent_db_read` 整组撤掉，只留 3 个专用报告工具）。
- ⇒ 想拿"本周新增的 37 个字词是哪些、哪天错的"，目前只能翻逐字稿人工捞（`parent_read_child_conversation` 能做，但费时且未必捞全）。

### 坎 4：跨课知识点的定位能力缺失 —— **成立**
字词分散在不同课（子罕篇／乡党篇各自课内的「字词」考点，与独立「字词」课并存）。而家长侧工具：
- `parent_library_courses(topic)`（`parent-tools.ts:448`）**必须给 topic**，一次一个主题；
- `parent_library_course_content(topic,title)`（:987）**必须给课程名**；
- 没有任何"按知识点名/字词反查在哪门课"的搜索入口，也没有"列出全部含某知识点的课"。
⇒ agent 只能"猜主题 → 列课 → 逐课看考点"，89 个知识点 × N 门课的组合基本不可行（**没口径 ≠ 没数据**）。

### 坎 5：补题必须先经家长确认 —— **成立，且这是既定红线（不是 bug）**
`parent_upsert_course_content`（`parent-tools.ts:1060`）是**整课替换**：不看现状就写会覆盖家长手建的挂载；`parent-scene-course` 技能与 `parent-scene-shared` 都要求"任何写库动作之前先复述方案（要新建什么、覆盖哪一行、改成什么），确认后再执行"。
⇒ 正确姿势就是报告里说的：**先列"补哪几个字、每题问什么"给家长确认，再整课替换**。这条保持。

---

## 三、候选方案（待拍板）

### F1（读口径 · 建议优先）：家长侧只读工具 `parent_child_mistake_list`
`{ child, kind?, status?(缺省 open), days? / since|until, limit≤200 }` → **逐条**列出：
`content / kind / count / first_seen / last_seen / course_ref / knowledge_point_name / question_id（+有原题时附题库题干）`，末尾给"按 kind × 日期"的小结（哪天新增几条、反复出现的排前）。
- 底层给 `listMistakes()` 加 `since/until`（按 `first_seen` / `last_seen`）与 `limit` 上限复用；
- 顺手把 `child_mistake_log(action=list)` 输出补上「首次/最近」日期（孩子侧同口径，成本一行）。
- 收益：坎 3 消失；"本周新增 37 条"从**一个数字**变成**可执行的清单**。

### F2（定位口径 · 建议优先）：知识点/字词 反查
新增只读搜索（名字待定，如 `parent_library_find_kp`）：`{ keyword, topic? }` → 命中的 `主题 / 课程 / 知识点`（含该知识点是否挂了题、挂了几题）。
- 收益：坎 4 消失；同时给 F4 的"缺题清单"提供数据面（哪些字词没有题）。

### F3（考核形态）：跨课知识点清单怎么传
现状 `methodSpec.require` 是**按课**的 `{知识点名: 抽题数}`，一周字词散在多门课 ⇒ 必须逐课调用。
候选：① **不改工具**，技能里定死"先按课分组，再对每门课传 `require`"；② `parent_exam_plan_create` 增加 `kps: [{course, kp, count}]` 形态，服务端自己分组（工具更好用，但要动 schema + 出题展开）。
（坎 1 的"按日期建考核"**不建议**做成工具参数——考核的出题范围本就该是知识点清单；日期维度属于"从错题本筛出清单"这一步，由 F1 承担。）

### F4（缺口可见化）：必需知识点没题时**不许静默**
`buildPlanSpecEntries` 增加 `partial: [{title, kp}]`：`require` 里"存在但没挂题"的知识点**必须出现在返回里**——
候选 A：直接拒绝创建并列出"这些字没题，先补题或从本次范围里去掉"（与现有 `missing` 同风格）；
候选 B：放行但返回明确警告（"本次实际只考了 X，Y 因没题没考"）。
建议 **A**（家长点名的内容没考＝结果不可信，宁可让 agent 回头确认）。

### F5（学习计划侧）
学习计划按**课程名**排（`parent_study_plan_create` 的 `content` 是课程名数组，"复习："前缀＝复习）。字词是**知识点**不是课程 ⇒ 只能落成"对所属课程的复习 + 用考核覆盖具体字词"。候选：技能里把这条口径写死（本周字词 → ①所属课程的复习计划 ②针对这些知识点的考核），**不新增工具**。

### 建议实施顺序
**F1 + F2（读口径，零破坏）→ F4（防静默，小改）→ F3/F5（技能口径或 schema，按需）**；坎 5 维持现状（家长确认后再整课替换）。

---

## 四、实施方案（细化到工具 schema / 取数口径 / 落点 / 测试）

> 说明：家长**界面**其实已经有同款能力——「孩子详情 → 错题本」（`src/components/ChildMistakeBook.tsx`，走 `GET /api/v1/kb/:childId/mistakes`）就会逐条显示「首记 / 最近 / 出现次数 / 本周新增」。**缺的只是 agent 侧的读口径**（ISSUE-144 P6 撤掉通用 `parent_db_read` 后没补专用工具）。所以 F1 的本质是"把界面已有的那口径给 agent"。

### F1｜`parent_child_mistake_list`（新增，家长侧只读）

**参数（TypeBox，结构与语义最后都进 `parent-scene-progress` 技能）**

| 参数 | 类型 | 说明 |
|---|---|---|
| `child` | string? | 孩子姓名；名下唯一时可省（沿用 `resolveChild`，找不到报可选名字） |
| `kind` | string? | `wrong_question` / `unknown_word` / `weak_point`（缺省＝全部） |
| `status` | string? | `open`（缺省）/ `mastered` / `dismissed` / `all` |
| `days` | number? | 最近 N 天（**按 `last_seen`**；缺省 7，上限 90）——与 `since/until` 二选一 |
| `since` / `until` | string? | `YYYY-MM-DD`，含边界（按 `last_seen`） |
| `newOnly` | boolean? | `true`＝只看**本周新增**（`first_seen` 落在窗口内） |
| `unlinked` | boolean? | `true`＝只看**没有可考原题**的条目（配合 F4 的"补题清单"） |
| `limit` | number? | 缺省 60，上限 200（超出给"还有 N 条，收窄条件"提示） |

**取数**：`db/mistakes.ts::listMistakes()` 增 `since/until`（WHERE `last_seen >= ? AND last_seen <= ?`）与 `firstSince`（同一窗口作用于 `first_seen`）；
再 `attachQuestionStems()`（家长库读题干）补"有原题/无原题"；字段全出：`kind / content / detail / count / first_seen / last_seen / source / course_ref / knowledge_point_id / knowledge_point_name / question_id`。

**输出形态（示意）**

```
「闻闻」错题本（open · 最近 7 天 · 最近出现的排前；共 56 条，其中本周新增 37 条）：
- 生字「验」×3｜首记 10-14 / 最近 10-14｜课程：论语子罕篇｜知识点：字词(验)｜⚠ 无题可考
- 生字「迫」×3｜首记 10-14 / 最近 10-14｜…｜⚠ 无题可考
- 错题「不亦说乎的“说”读音」×2｜…｜有原题（题干：请说一说“不亦说乎”中“说”…）
小结：新增 37（生字 35 / 错题 2）；其中 12 条无题可考——补题后才能考：验、迫、…
```

**落点**
1. `server/src/agent/parent-child-report-tools.ts`：新增工具 + 加进 `PARENT_CHILD_REPORT_TOOL_NAMES`；
2. `server/src/db/mistakes.ts`：`listMistakes()` 加日期过滤（REST `GET /kb/:childId/mistakes` 可选透传 `since/until`，界面不强制改）；
3. `server/src/agent/skills/parent/progress.ts`：`tools` 清单加该工具 + 正文补一段口径（**别人格化念清单**：家长点名"这周错了哪些字"才逐条；"哪里薄弱"仍走 mastery 的聚合口径）；
4. `parent-registry.ts` 的 spread 自动带上（`createParentChildReportTools` 已展开），场景守卫按技能 `tools` 自动挂。
5. ⚠ `test/issue144-parent-skills.test.ts:603` 的工具块预算 `afterTotal < 17500` 需按新工具的"一句 + 指路"（约 +200 字符）上调并注明原因。

**孩子侧同步（3 行）**：`child-db-tools.ts:104-116` 的输出补「首记 X / 最近 Y」，并加 `days` 参数（复用同一 `listMistakes` 过滤）——孩子问"我这周错了哪些字"现在同样只有聚合。

**测试**：`test/issue186-parent-mistake-list.test.ts`——① 逐条 + 日期 + 课程/知识点字段齐；② `days/week` 窗口外的条目不出现、`newOnly` 按 `first_seen`；③ `unlinked=true` 只剩没题的条目；④ limit 截断提示；⑤ 名下多孩子不传 `child` → 报可选名字（不猜）。

### F2｜`parent_library_find_kp`（新增，家长库只读）

| 参数 | 类型 | 说明 |
|---|---|---|
| `keyword` | string | 字词/知识点名（必填，如「验」「恂恂」） |
| `topic` | string? | 限定主题（`topic_key` 或中文名） |
| `limit` | number? | 缺省 20，上限 50 |

**取数**：`knowledge_points JOIN courses JOIN topics`，先精确 `name = kw`、再无 `topic` 限制地 `name LIKE %kw%`；每条给
`主题 / 课程 / 知识点 / **是否挂题（挂了几题）** / 该课知识点总数（其中几个有题） / 该课已有题数`。
**fallback**（可选）：知识点名零命中 → 在 `question_bank.stem` 里 `LIKE %kw%` 找"哪些题考过这个字"，**明确标注"题干命中 ≠ 知识点"**，并在文末提示：要让它能考，走 `parent_upsert_course_content` 补"知识点 + 题"（写库前先复述确认）。

**落点**：`server/src/agent/parent-tools.ts`（挨着 `parent_library_course_content`）；声明进 **`parent-scene-progress` + `parent-scene-course`** 两个技能的 `tools`（多场景任一放行：前者用于"哪里薄弱/这字在哪"，后者用于"写考核内容前核对"）。

**测试**：`test/issue186-find-kp.test.ts`——命中多课按课程分组；带"未挂题"标记；`topic` 过滤生效；零命中给 fallback 提示而不是空手而归。

### F4｜`buildPlanSpecEntries` 必需知识点没题**不许静默**

**现状（`assess-selection.ts:301 / 343-358`）**：`withQ = items.filter(有题)`；`require` 只在 `withQ` 里匹配 ⇒ 点名的知识点若没题被**跳过**；只要还剩至少一个有题的 kp，函数就正常返回 ⇒ 调用方"创建成功"，而家长要考的字**没考且无任何提示**。

**建议改法 A（拒绝）**：`methodSpec.require` 命中的 kp **没有挂题** → 进 `missing`，理由写成
`要求的知识点「验」没有挂题，无法出题（先补题，或把它从本次范围里去掉）` ⇒ **7 处调用点**（`parent-plans.ts:823`、`plan-tools.ts:698`、`routes/exam.ts:237/811/884/1078`、`exam-retake.ts:170`）自动拒绝并给出可读原因。
**关键边界**：**只在显式 `require` 时报错**——默认的"整课展开"里有些知识点没题是正常现象（不该因此拦住整场考核）。
**备选 B（放行 + 警告）**：函数多返回 `partial: [{title, kp}]`，调用方在成功文案里追加"本次实际没考：验、迫（没题）"。
**测试**：`test/issue186-plan-spec-partial.test.ts`（有题+没题混合的 require → 按 A 抛/按 B 出 `partial`；纯默认展开不受影响）+ `issue115/121/135/150` 相关回归。

### F5｜学习计划侧的口径（技能层，零代码）

字词是**知识点**、不是课程；`parent_study_plan_create` 的 `content` 只能填**课程名**（`题`/`字词` 填不进去，会被 ISSUE-123 的存在性校验拒掉）。所以"给这周的字词排学习计划"只能落成：
① 用 F2 找到每个字所属的课 → 对这些课排 `复习：<课程名>`（`mode=review`）；
② 用 F3 的考核覆盖到**具体字词**（`methodSpec.require`）。
落地方式：把这段判断写进 `parent-scene-plan` 技能正文（一句话口径 + 一个例子），**不新增工具**。

### F3｜跨课知识点清单怎么传（二选一）

- **推荐 · 技能层（零 schema 风险）**：`parent-scene-plan` 定死"先按课分组，再对每门课传 `methodSpec.require`"（配 F2 定位），并把"一周字词可能横跨 字词课 / 各篇章课"写成明确提示。
- 备选 · 工具加形态：`parent_exam_plan_create` 增 `kps: [{course, kp, count}]`，服务端自行分组（对模型更省事，但要动 schema + 出题展开 + 返回文案 + 相关测试）。

---

## 五、验收口径（若实施）
1. 家长问"闻闻这周错了哪些字词、哪天错的" → 一次工具调用给出逐条清单（含日期与所属课/知识点），不再只有汇总数字；
2. 家长问"「验」在哪门课、有没有题" → 一次工具调用给出课程/知识点/是否挂题；
3. 家长要求"考这周错的字词" → 若其中某字没题，工具**明确说出**"X 没题、本次考不了"，而不是静默少考；
4. 补题流程仍是"先列清单复述 → 家长确认 → 整课替换"；
5. 全流程不需要家长手工翻逐字稿。

---

## 六、待拍板（决定后才能开工）

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| 1 | F1 默认时间窗与上限 | `days=7` / `limit=60`（本 issue 口径）还是别的 | 按本 issue（对齐界面"本周新增"） |
| 2 | F1 是否顺带修孩子侧 | 只加日期 / 加 `days` 参数 / 不动 | 加日期 + `days`（3 行，口径统一） |
| 3 | F2 是否带题库题干 fallback | 带 / 不带 | 带，但必须标注"题干命中 ≠ 知识点" |
| 4 | F4 形态 | A 直接拒绝（推荐）/ B 放行 + 警告 | **A**（点名的内容没考＝结果不可信） |
| 5 | F3 形态 | 技能层口径（推荐）/ 工具加 `kps[]` | 技能层先行 |
| 6 | 本轮范围 | F1+F2+F4 一起 / 只 F1 / 先只记录 | 建议 **F1+F2+F4**（F1 解坎 3、F2 解坎 4、F4 防"静默少考"） |

---

## 七、用户口径补充（2026-10-16 晚）与方案修订

### 7.0 补充一：F1 要支持更广的查询，不只是"本周"
用户原话：「F1 要支持更广的需求，我这次要找本周的错字，以后还会想知道**还有哪些字词孩子掌握的不好**，或者**错误的次数很多**。」
⇒ F1 从"本周错字清单"升格为**错题本通用查询口径**（"本周"只是其中一个窗口）：

| 参数 | 类型 | 说明 |
|---|---|---|
| `child` / `kind` / `status` | 同前 | `status` 语义＝掌握维度：`open`（缺省，"还没掌握"）/ `mastered` / `dismissed` / `all` |
| `days` / `since` / `until` | 同前 | 时间窗（按 `last_seen`）；`newOnly` 改为按 `first_seen` 只看新增 |
| **`order`** | string? | `last_seen`（缺省，最近错的排前）/ **`count`（错得最多的排前）** / `first_seen` |
| **`minCount`** | number? | 只看出现次数 ≥ N 的条目（"错误次数很多"） |
| `unlinked` | boolean? | 只看**没有可考原题**的（补题清单） |
| `limit` | number? | 缺省 60 / 上限 200 |

输出把 `×次数` 与「首记 / 最近」都摆在行首（"掌握得不好"＝`status=open` + `order=count`），并在小结里按 kind × 次数档（≥3 次 / 2 次 / 1 次）给分布——这样"哪些字掌握得不好、哪些错得多"一次调用就有答案。
⚠ 与 `parent_child_mastery_report` 的分工写进技能：**概览仍走 mastery（按 kind 聚合）**，家长点名要清单/排序/次数阈值时才用本工具。

### 7.1 补充二：F2 到底用在什么场景 → **并入 F1，不做独立工具**
用户问「F2 用在什么场景？」——核对后结论是：**在补充三的口径下，主流程不需要它**。
- 需要"这个字属于哪门课、有没有题"的唯一原因是：安排考核时要给 `parent_exam_plan_create` 传**课程名 + 知识点**。而这些信息**已经在孩子库 `mistake_book` 里**（`course_ref` + `knowledge_point_id/name`，由错题整理任务写入）——F1 直接把它们带出来即可；
- 剩下两种边角：① 条目**还没被整理过**（`knowledge_point_id=''`）；② 被整理成 `'skipped'`。这两种**正确处置是"等/触发整理"或让家长确认补题**，而不是另开工具去猜课程；
- 因此：**F2 取消**，"是否已有挂题"作为 F1 每条的备注（一次 join 家长库 `course_knowledge_questions` 即可，`attachQuestionStems` 同一趟就能算）；真出现"想在家长库里按名字查考点"的独立诉求时再二期立项。

### 7.2 补充三：F3/F5 定稿（按用户给的规则，技能层实现，不新增工具）
用户口径：「错题整理会把字词作为知识点**关联到相关课程**，就安排该知识点的课程为考核对象、该知识点为考核内容即可；**字词如果不在其他学习主题的课程里，就安排到学习主题「错题整理」里的「字词」课程**。目前家长有工具可以为某一个课程的特定知识点安排考核计划。」
⇒ 落实为 `parent-scene-plan` 的三步口径（零代码，工具已够用）：
1. **分组**：用 F1 拿到本周/待考条目 → 按 `(课程 course_ref, 知识点 knowledge_point_name)` 分组；
2. **建考核**：对每组调用一次 `parent_exam_plan_create`（`courses=[该课程]`、`methodSpec.require={该知识点: 1}`、`name` 取"XX 字词巩固"这类可区分的名字）；知识点所在课程为空/属于 `错题整理` → 用 **`错题整理` 主题下的 `字词` 课程**；
3. **学习计划（F5）**：同一批课程按 `复习：<课程名>` 排 `parent_study_plan_create`（字词是知识点不是课程，只能挂到所属课程的复习上）。
**顺带记一条现成机制（要写进技能，之前没人告诉过 agent）**：`错题整理/字词` 课程的**主题级 `method_spec.perChild[孩子].require` 已由整理任务自动维护**（= 该孩子 open 错题的知识点名，见 `mistake-sorting.ts:136-154`）⇒ 对这门课建考核**即使不传 `methodSpec`，也只会考这个孩子自己没掌握的字词**；一旦传了 `methodSpec.require`，则以显式清单为准（`buildPlanSpecEntries` 的 `planRequire` 优先）。

### 7.3 补充四【新 F0】：错题整理任务的字词链路——**排查结论：有出题这一步，但有 5 处缺陷**
用户问：「F4 字词一定要有题目，每天有错题整理定时任务，让这个定时任务整理错题是为字词出题，字词的题目就是给解释字词的意思，并造句，是口述题。**排查定时任务错题整理有没有做这一步**。」

**排查结论（`server/src/worker/mistake-sorting.ts` 通读）**：**做了**——「查词字词 → `错题整理/字词` 课的知识点（name=字词本身）+ 自动出一道考核题」就在设计里（文件头注释 + 第 337-355 行的"轮 3 出题" + `attachGeneratedQuestion`）。但有 5 处缺陷，与现场「89 个知识点只有 29 个有题」的现象吻合：

| # | 缺陷 | 代码 | 后果 |
|---|---|---|---|
| 1 | **题干口径不符**：prompt 写的是"读音或释义，简答题"，**没有"造句"** | `buildQuestionPrompt`（:205-211） | 出的题不是你要的"解释意思 + 造句" |
| 2 | **单轮只补 8 题、且只取"最新的 8 个"没题知识点**：`ORDER BY k.rowid DESC LIMIT 8` | `QUESTION_CAP=8`（:32）+ :252-259 / :338-345 | 60 个没题的词要跑 8 轮以上；**只要这 8 个里有对不上名的，就更老的词永远轮不到**（队头阻塞） |
| 3 | **匹配靠精确相等**：`pendingQ.find(k => k.name === q.word)` | :351 | 模型返回带拼音/括号/别名（如「论语（Lún Yǔ）」）即**静默丢弃**，且下一轮仍占那 8 个名额 |
| 4 | **出题结果无留痕**：返回值只报"整理 N 条"，没有"本轮出题 N/待出题 M"，也不落日志 | :371 | 与"60 个词一直没题"这类问题**在生产上不可观测** |
| 5 | **字词一律只进 `错题整理/字词`，从不尝试挂到真实课程的既有考点** | :319（words 循环固定用 `wordCourseUuid`） | 与补充三的预期不符，也是原坎 4 的成因。本地实例实证：「吟诵」同时存在 `reading/春风·数狮子` 与 `错题整理/字词`；「谨」在 `hanzigong/汉字宫第143课·生皮熟革` |
| 附 | 该任务是**opt-in**：本地这个家长根本没有 `mistake_sorting` 任务行（`scheduler_tasks` 只有 recording / auto_new_session / custom），`worker_state` / `task_runs` 里也没有它的运行记录 | — | 没建任务 = 永远不出题；现场"89 有 29 有题"很可能是"任务排得晚/中间停过"叠加缺陷 2/3 |
| 附 | 准入闸门偏松：本地「字词」课里混进了 `资料`、`面板`、`变冷` 这类非字词 | `buildStage1Prompt` 的准入规则 | 影响不大，但会污染考核范围 |

**F0 修复清单（建议）**
1. **改题干口径**：`buildQuestionPrompt` 改为"为每个字词出一道**口述题**：先说清它的意思，再用它造一个句子"；`answer` = 意思要点 + 示例句；`behavior` 保持 `generic`（＝口述主观题，客户端不需要选项）；`scoring` 改成"意思说对 + 句子通顺"。
2. **按 id 匹配 + 容忍格式**：把 kp `id` 一并交给模型（`[id=xx] 字词`）并要求回 `id`；同时保留"去空白/去括号/去拼音后名字相等"的兜底；对连续 N 轮失败的 kp **记失败计数并跳过**，避免永久占位。
3. **提高吞吐 + 消除队头阻塞**：`QUESTION_CAP` 从 8 提到 20~30（一次 LLM 调用可承受），并把 pending 选择改成"**优先 oldest / 或随机取样**"（至少不能永远是同 8 个）。
4. **留痕**：返回值与任务消息带上"本轮出题 N / 仍待出题 M"，失败逐条 `console.warn`；`task_runs.message` 里能直接看出缺口。
5. **课程归属**：字词先在**其他学习主题的课程**里按**知识点名精确匹配**找既有考点——命中则关联到它（是否顺便给该考点补题见下方待拍板）；未命中才落 `错题整理/字词`。
6. （可选）准入闸门收紧：单字/词/成语且**不是界面文案**才收，或把被 `skipped` 的词留在家长端可见（现状是静默丢弃）。

### 7.4 F4 定稿：字词必须有题，且"点名了就必须考"
用户口径：「F4 字词一定要有题目」⇒ F4 采用**方案 A（直接拒绝）**：`methodSpec.require` 里"存在但没挂题"的知识点一律进 `missing`，创建失败并附"先补题（走 F0 的整理任务或 `parent_upsert_course_content`）或把它从本次范围去掉"。这样"家长点名的字没考"不可能再静默发生；配合 F0，字词最终都会有题。

### 7.5 修订后的待拍板

| # | 决策点 | 选项 | 建议 |
|---|---|---|---|
| 1 | 任务修复范围（F0） | 只改题干口径+留痕 / 连同吞吐与匹配一起修 / 再加上"挂真实课程" | 全做（5 条里 2/3 是"没题"的直接成因） |
| 2 | 字词命中真实课程既有考点时 | ①只关联、不写题（题仍只落在 `字词` 课）/ ②关联并给该考点补一道题 | ②（否则"字词必须有题"仍不成立）但**要家长确认**是否允许任务改真实课程内容；①更保守 |
| 3 | F1 默认 `order` 与 `limit` | `last_seen` / 60 条 | 按此（要"错得最多"就 `order=count`） |
| 4 | F2 | 取消（并入 F1）/ 仍做独立查考点工具 | **取消** |
| 5 | F3/F5 | 技能口径（推荐）/ 工具加 `kps[]` | 技能口径，并把 `perChild` 自动收窄机制写进技能 |
| 6 | 本轮实施范围 | F0+F1+F4 一起 / 先 F0（让字词先有题）/ 先只记录 | **F0 + F1 + F4**：F0 造题、F1 给清单、F4 保证点名就考 |

---

## 八、实施记录（2026-10-16，用户拍板后落地；**未部署 201**）

### 8.0 用户最终口径（第四条补充，覆盖 §7.3 第 5 条）
> 「错题整理任务里，**把所有字词类的错误只在错题整理的字词课程里查找是否已经存在，不在就作为该课程的新知识点，不在别的学习主题里查找了。简单一点。考字词也只在这个课程里找知识点作为考的内容。** F0 全做。其他无异议。」

⇒ **不做**"字词挂到真实课程既有考点"（§7.3 第 5 条作废），字词的考点**只**在 `错题整理/字词`；考字词也只从这门课取知识点。代码原本就是"只进字词课"，本轮把它**写成明文口径**（注释 + 技能），并保留"名字相同即复用同一知识点"（`ensureKnowledgePoint` 唯一键幂等）。

### 8.1 F0｜错题整理任务字词链路（`server/src/worker/mistake-sorting.ts`）
| 修 | 内容 |
|---|---|
| ① 题干 | `buildQuestionPrompt` 改为**口述题**：说清意思 + **造句**（"题干里不要出现答案"）；`behavior` 仍 `generic`（=口述主观题，无需选项） |
| ② 匹配 | prompt 带 `[id=<kpId>]` 并要求**原样回填** → 按 id 匹配；另加 `normalizeWordName()`（剥括号及内容/空白/引号书名号）做名字兜底 |
| ③ 吞吐/阻塞 | `QUESTION_CAP` 8 → **24**；pending 选择改 `selectPendingQuestions()`：**老的优先**（`rowid ASC`）+ **连续失败 3 轮跳过**（`QFAIL_LIMIT`，计数落家长库 `meta` 的 `qfail:<course>:<kp>`，成功即清） |
| ④ 留痕 | `task_runs.message` 带「本轮出题 N 道，仍待出题 M 道（本轮未命中 K 个）」+ 跳过名单；失败逐条 `console.warn` |
| ⑤ 口径 | 字词**只在** `错题整理/字词` 课查/建（文件头注释写明"不去别的学习主题找考点"） |
| ⑥ 素材 | `ensureKnowledgePoint` 只在**已有释义为空**时补 `detail`（出题素材；绝不覆盖家长写的释义） |

### 8.2 F1｜错题本查询口径（`db/mistakes.ts` + 家长工具 + 技能）
- `listMistakes()` 新增 `since` / `until`（按 `last_seen`）、`firstSince`（按 `first_seen`）、`minCount`、`order`（`last_seen`/`count`/`first_seen`）。
- **新工具 `parent_child_mistake_list`**（`agent/parent-child-report-tools.ts`，注册进 `PARENT_CHILD_REPORT_TOOL_NAMES`）：
  `child` / `kind` / `status`（缺省 `open`）/ `days` / `since` / `until` / `newOnly` / `minCount` / `order` / `unlinked` / `limit`；
  输出**逐条**：`类型「内容」×次数｜首记 X / 最近 Y｜课程/知识点｜⚠ 还没题可考｜原题：…` + 小结（按 kind 计数、≥3 次几条、没题可考几条、截断提示）。"有没有题可考"＝join 家长库 `course_knowledge_questions`（或条目自带 `question_id`）。
- **F2 取消**（并入 F1）：归属与"有没有题"都由 F1 直接给出。
- 技能口径：`parent-scene-progress`（清单 vs 概览的分工、⚠ 条目怎么讲、补题两条路）与 `parent-scene-plan`（排考核要用它拿清单）都声明了该工具（多场景任一放行）。
- 孩子侧（`child-db-tools.ts`）：`child_mistake_log(action=list)` 输出补「首记/最近」，并加 `days` 参数。

### 8.3 F4｜点名没题 → 拒绝创建（`assess-selection.ts`）
`buildPlanSpecEntries` 里 `methodSpec.require` 命中的知识点**存在但没挂题** → 进 `missing`（理由含"还没有挂题…先补题或去掉"）⇒ 7 处调用点自动拒绝；**默认整课展开不受影响**（有些点没题是正常的）。

### 8.4 F3/F5｜技能层口径（`skills/parent/plan.ts`）
新增「**按错题/字词排考核**」三步：① `parent_child_mistake_list` 拿清单 → ② 按每条**自带**的 `course_ref` + `knowledge_point_name` 分组（字词只在 `错题整理/字词` 课，**别去别的主题猜课程**）→ ③ 每组一次 `parent_exam_plan_create`（`methodSpec.require={该知识点:1}`）+ 配套排 `复习：<课程名>`；⚠ 条目先跳过并如实说；并写明"该课已按孩子收窄考核范围（`perChild`），不传 `require` 也只考他自己的字词"。

### 8.5 测试与验证
- **新增 3 个测试文件 18 例**：`issue186-mistake-sorting-questions`（6：口述题 prompt/名字归一/老的优先+失败跳过/释义只补空）、`issue186-plan-spec-partial`（5：F4 拒绝矩阵）、`issue186-parent-mistake-list`（7：逐条+日期/时间窗/newOnly/order+minCount/unlinked/limit 提示/多孩子不猜）。
- **改动 4 处既有断言**：`mistake-sorting`（题干口径）、`issue142`（+1 例：日期与 days）、`issue144-parent-report-tools`（新工具场景归属）、`issue144-parent-skills`（两个预算）。
- **非假绿**：F4 断掉 `withQIds` 检查 → 3 例红；F0 的"造句"断言在旧 prompt 下红（已在改动中实测）。
- **预算**（按仓库惯例随工具面同步调，并在测试里注明）：工具块 17500 → **18000**（实测 17802）；`parent-scene-plan` 正文上限 6000 → **7200**（实测 6706，正文已压缩）。
- 回归：186 相关 104 例 + 考核/计划/worker 批 104 例全绿；`server tsc --noEmit` 无新增错误（仅既有 6 处类型债）；`server.cjs` 已重建（23.9mb，新标记已核实）。

### 8.6 上线后的预期与遗留
- 现场 60 个没题的字词：任务重跑后**每轮补 24 个（老的优先）**，2~3 轮内补齐；连续 3 轮失败的会在任务消息里**点名**（需人工补题）。
- 现场该家长**没有 `mistake_sorting` 任务行** → 字词要自动出题，需先在「定时任务」页创建该任务（opt-in，属产品既有口径）。
- 未做（按用户"简单一点"）：字词与真实课程考点的关联/去重（`reading/春风·数狮子::吟诵` 与 `错题整理/字词::吟诵` 这类重名会继续并存）；准入闸门收紧（`资料`/`面板` 这类仍可能进字词课）。
- **未部署 201、未提交**（按长期约定：部署前先问）。

---

## 九、部署与线上验证（2026-10-16 21:18，server 0.5.38）

- 提交 `0b922af`（三 issue 同批；27 文件 +1767/−110）→ push github + gitee → 部署 201：备份 bundle `server.cjs.bak-20261016-211843` + 数据 `deploy-0.5.38-20261016-211843`（22M）→ 换包重启。
- **部署校验**：version `0.5.38`、health `{ok:true,db:"ok"}`、journal error **0**；标记校验全 FOUND——
  `题库挂载反查达到分页硬上限`（184）/`是**前缀**且匹配到`+`行 id 已给全值`+`完整行 id`（185）/
  `字词出题未命中`+`还没有挂题，出不了题`+`口述题`+`造句`+`按错题/字词排考核`+`还没题可考`（186）+
  ASCII `BANK_CTX_SCAN_MAX/BANK_CTX_PAGE/ignoreGlobalCap/resolveRowById/parent_child_mistake_list/selectPendingQuestions/QFAIL_LIMIT/normalizeWordName/qfail:`；
  **超集 KEPT**：ISSUE-183（VOLUME_TOO_LOW/minVolumeNorm/dimensionMeanScore）、ISSUE-182（notifyCustomTaskFailure + 四类创建口径）。

### 9.1 线上实测结果
| 项 | 结果 |
|---|---|
| ISSUE-184 | `GET /assess/questions/list` → **10000 题，带挂载 9997 / 未挂载 3**（478ms）；剩 3 条是真实游离题 |
| ISSUE-185 | 两孩子最近 6 场考核 id 前 8 位**全为 `ep_17921`**（撞车 6/6）——现场问题复现；工具现在给全值 + 前缀歧义拒绝（bundle 标记已验） |
| ISSUE-186 F1 数据面 | 闻闻 open 生字 **61** 条（已挂知识点 55，本周新增 42）；珊珊 **148** 条（已挂 45，本周新增 12）——新工具逐条读的就是这张表 |
| ISSUE-186 F0 现状 | `错题整理/字词` 课 **100 个知识点 / 46 有题 / 54 没题**；`qfail` 计数 0；家长**已有** `mistake_sorting` 任务（「错题整理 21:00」，enabled） |

### 9.2 ✅ 已就地触发一次并验证 F0 端到端（用户确认后，2026-10-16 21:23）
- 时序问题：今日 21:00 的桶**已用旧包跑过**（`worker_state.last_run=2026-10-16T21:00`、`task_runs` 消息是旧格式），而部署在 21:18 ⇒ 正常要等明天 21:00。**用户拍板"现在触发"**。
- 做法（幂等、可回滚）：先备份 `data/backups/f0trigger-20261016-212320/`（75M：server.sqlite + 家长库 + 三个孩子库）→ `DELETE FROM worker_state WHERE task='mistake_sorting'`（2 → 0）→ `systemctl restart learning-server` → **startup catch-up**（`catchUp:"latest"`）按今天的 21:00 点重跑。
- **结果（两个孩子各一轮，都是新口径消息）**：
  | 孩子 | task_runs.message |
  |---|---|
  | 闻闻 | `整理 1 条（字词 1、错题 0）；本轮出题 24 道，仍待出题 30 道` |
  | 珊珊 | `整理 1 条（字词 1、错题 0）；本轮出题 24 道，仍待出题 7 道` |
- **字词课变化**：`100 知识点 / 46 有题 / 54 没题` → **`101 / 94 / 7`**（本轮共补 **48 道**；`qfail` 仍为 0）。
- **题目口径实测（新生成的题就是你要的样子）**：
  - 「验」：`「验」是什么意思？请用「验」说一句完整的话。` → 答案：`意思：检查、察看；也指效果得到证实。例句：医生先给我验了血，才开药。`
  - 「迫」：同上句式 → 答案：`意思：逼近、逼迫；也指急促、紧急。例句：天色已经很迫近了，我们赶紧回家。`
  - 其余抽样：`「曰」是什么意思？请用「曰」说一句话。`、`「皦」…`、`「薛」…`；`behavior=generic`（＝口述主观题，客户端不需要选项）。
  - **⚠ 用户原报告里卡住的「验」「迫」两个字现在都能考了**（这正是 §一 坎 2 的死结）。
- **剩余 7 个没题的知识点**：`翕、宰、祷、御，、认 rèn 4画、🌟 故事、形态 / 内行（形、行、型的区别）`——其中后 4 个是**非字词噪声**（带标点/拼音/书名号/斜杠），预计会被新逻辑按"连续 3 轮失败"跳过并在任务消息里点名（准入闸门偏松的遗留，见 §8.6）；明天的 21:00 轮次（cap 24）会再跑一次。
- **任务分配现状**：`mistake_sorting` 只分配给了闻闻、珊珊（家长名下第三个孩子「小试」未分配）⇒ 本轮触发只跑了这两个孩子；这也解释了"两轮 48 道"的算术（54 + 1 新词 − 48 = 7）。
- **回滚**：需要时用 `f0trigger-20261016-212320/` 覆盖 `server.sqlite` + `parents/<pid>/parent.sqlite` + 三个孩子库，再重启即可（新增题目本身也可在家长端「题库」逐条删除）。

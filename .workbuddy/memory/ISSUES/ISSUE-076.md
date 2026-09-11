# ISSUE-076｜学习计划的「完成」判定依赖 AI 手写 `courses.last_review`——复习不写就永远判不了完成

- **类型**：bug / 设计缺陷（判定信号不确定；且历史数据大面积缺日期）
- **优先级**：**高**（生产已实际发生：孩子复习完课程，家长端/孩子端 todolist 仍显示未完成；62% 已学课都不可能被打勾）
- **记录时间**：2026-09-11
- **状态**：**待修**（本次仅定位取证，未改动代码、未改数据）
- **现场**：201 生产 / 家长 `86a84278…` / 孩子珊珊 `1f050a7f…`

---

## 一、现象

珊珊 **2026-09-11** 的 `daily_entries`（block=学习）里有 4 条复习记录：

| daily 标题 | plan_id | 当日 todolist 中的状态 |
|---|---|---|
| 论语为政篇第六章（复习） | 空 | **不在 todolist**（当日无该课计划行） |
| 论语为政篇第七章（复习） | 空 | **不在 todolist** |
| 论语为政篇第八章（复习） | 空 | **不在 todolist** |
| 论语为政篇第三章（复习） | 空 | **在 todolist，status=pending（未完成）** |

09-11 当日 todolist（`GET /plans/today`，实调生产接口）共 **9 条**：

- `done`（2）：论语为政篇第二章、第九章
- `pending`（7）：第三章、第四章、第五章、第一章、第十章、第十一章、论语学而篇第十六章

## 二、根因（三层，逐层递进）

### 根因 1：todolist 的完成状态与 daily 记录是**两条互不相干的链路**

- **todolist** = `/plans/today` → 读三张计划表（`study_plans` / `life_plans` / `exam_plans`）中**窗口覆盖当天且 `active=1`** 的行，`status` 直接决定是否打勾（`server/src/routes/plans-rewards.ts:117-214`）。
- **完成判定** = worker `applySignals`（`server/src/worker/plan-domain.ts:186-219`）：学习域**只认 `courses.last_review`**（课程最近学习时间）落在 `[start_at, due_at]` 窗口内，**完全不读 `daily_entries`**。
- `daily_entries` 仅两处参与判定：① 学习域判定成功后**回写** `plan_id`（结果，不是依据）；② **生活域**用 `plan_id + plan_outcome='done'` 判定（只有生活域消费 daily）。

> 所以「daily 有学习记录」**天然不会**让学习计划打勾。这是设计如此（`ARCHITECTURE.md:87`、`DESIGN-plan-domain-rewrite-2026-09-10.md:383`）。

### 根因 2：`last_review = '-'` 的课**永远**判不了完成

判定代码 `plan-domain.ts:191-206`：

```ts
const courses = kb.prepare("SELECT topic, title, last_review AS learned_at FROM courses WHERE last_review != ''")...
const learnedAt = c?.learned_at ?? "";
if (!learnedAt) continue;
const d = dateOf(learnedAt);            // dateOf = ts.slice(0,10) → "-"
const inWindow = d >= dateOf(p.start_at) && d <= dateOf(p.due_at);   // "-" >= "2026-09-11" → false
```

`'-'` 的语义是「已标 ✅ 但**没有日期**」——`server/src/db/kb.ts:287` 与 `electron/lib/kb-sqlite.ts:150` 的视图都显式把 `('' , '-')` 视同 NULL。但 `plan-domain.ts:192` 的 `!= ''` 会把 `'-'` 当有效值捞出来，随后参与日期比较**恒为 false**。

**生产实测（珊珊库 courses，613 门已学）**：

| `last_review` 形态 | 门数 | 能否判 done |
|---|---|---|
| 合法日期 | 230 | ✅ |
| `'-'` | **380** | ❌ 永远不能 |
| 空串 | 3 | ❌ 永远不能 |
| **合计无日期** | **383（占已学 62.5%）** | — |

即：**63% 的已学课程，只要被排进学习计划，就永远不可能被打勾**——无论孩子学多少次。

### 根因 3：`last_review` 的写入**没有确定性路径**，全靠 LLM 自觉

全仓检索确认：**服务端与客户端都没有「完成一课时更新学习时间」的确定性代码**，只有 AI 工具的提示词约定：

- 孩子端系统提示（`electron/lib/pi-session.ts:108`）：「**完成一课后用 kb_update 更新该课程状态即可**」——只要求写**状态**，未强制写「最近复习/学习时间」；
- 录制任务提示（`electron/lib/recording-prompt.ts:64`）：「用 kb_update 更新对应课程状态（状态→✅），掌握度、复习次数、**首次学习**、最近复习…」——**且这段还引用着已删除的列**（`mastery`/`first_learned` 已于 2026-09-10 迁移中 DROP）。

于是「复习是否刷新 `last_review`」完全取决于模型当次是否记得多传一个字段：

- 今天**第二章 / 第九章**被更新为 `2026-09-11` → worker 判 `done` ✅
- 今天**第三 / 六 / 七 / 八章**复习后 `last_review` 仍是 `'-'`（三章）或 `2026-09-10`（六/七/八章）→ 判不了 ❌

**这与设计意图直接冲突**：`DESIGN-plan-domain-rewrite-2026-09-10.md:289` 明确要求「`last_review` 语义扩展为**最近学习时间（学或复习都更新）**」。

### 补充：为什么第六/七/八章「不在今天 todolist」

它们的计划行是 **09-10 的**（`status=done, active=1`），而 `done` 的计划**不参与 carry**（`expireAndCarry` 只复制 `pending` 行），今天也没有生成新计划行 → 它们今天既不在 todolist 里、也无从打勾。09-10 那天它们能判 done，是因为当天是「第一次学」（写了日期），而不是因为复习。

## 三、影响面

1. **家长端/孩子端「今日待办」**：复习类（尤其 carry 出来的）计划长期悬挂为未完成，孩子看着「学了却没打勾」（生产 daily 里已多次出现孩子的原话疑问：「为什么学习记录上一直没打勾」「为什么我这里这个记录上一直没打勾」——09-09、09-10 各有一条）。
2. **积分结算**：`reward_daily_stats` 的 `required_done` 直接来自计划判定 → 完成率被系统性低估，进而影响 `todoGateMinRate` 门槛与积分档位（生产 09-10 完成率 0.4545、09-11 0.2222）。
3. **掌握度/考核候选**：`/exam/candidates` 用 `last_review` 挑「该考的课」（`server/src/routes/exam.ts:434`），无日期的 383 门课会被排除在候选之外。
4. **历史数据**：383 门课缺日期，其中一部分可从 `daily_entries` 反推真实学习日期。

## 四、修复建议（需拍板，未实施）

**① 把「完成一课」变成确定性事件（根治）**
在确定性的落点上自动写 `last_review`，而不是靠 AI：
- 孩子端考核提交/标记完成时（客户端）自动 `kb.courses.updateFields { 状态:'✅', 最近复习: today }`；
- 或服务端在写入考核结果/学习记录时统一回写。
- 提示词同时收紧：明确「**复习完成也必须写最近复习日期**（语义=最近学习时间）」。

**② 判定侧兼容 `'-'` / 无日期（防御）**
`plan-domain.ts` 学习域把 `last_review IN ('', '-')` 视为「无日期」，改为**回退信号**：用当天 `daily_entries(block='学习', title LIKE '%课程名%')` 是否存在作为补充证据（与「生活域用 daily 证据」同构）。
> ⚠️ 这是语义扩展，需确认是否接受「daily 是否算学习完成证据」。

**③ 历史数据回填（一次性脚本）**
对 `status='✅' AND last_review IN ('','-')` 的 383 门课，按 `daily_entries` 中同名学习记录的**最近日期**回填 `last_review`；无 daily 记录者保持 `'-'`（不造日期）。

**④ 顺带修**：`electron/lib/recording-prompt.ts:64` 仍在要求写 `掌握度`/`首次学习`（列已删），应清理。

## 五、待确认项

1. 是否接受「daily 学习条目」作为学习完成的**补充证据**（影响判定语义与既有设计文档）？
2. 历史 383 门课是否回填（回填会影响 `/exam/candidates` 候选集与考核范围，需确认是否希望它们进入候选）？
3. `'-'` 的**来源**是否为旧客户端「标 ✅ 无日期」的写法？（建议保留语义、不再产生新的 `'-'`）
4. 复习是否也写 `review_count+1`（当前 6/7 章为 3，3 章为 0，说明复习次数同样未一致维护）。

## 六、取证命令（可直接重跑）

```bash
node .workbuddy/tmp/probe_todolist.js      # 09-10/09-11 todolist 两接口实调 + 旧 todo_items
node .workbuddy/tmp/probe_lastreview.js    # 升级前备份 vs 现库的 last_review 对照 + 全量形态分布
```

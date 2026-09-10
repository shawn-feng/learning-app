# 积分奖励机制设计（DESIGN-reward-points）

> 版本：2026-09-10 草案
> 适用：学习伙伴 APP 儿童端积分体系
> 设计原则：**不兜底、有扣分、必做优先、选做门控、逆水行舟（不进则退）**

---

## 一、总纲

1. **积分不是工资，是"坚持与进步"的可见化。** 不保证每次都给，必须满足阈值才发放；家长组未达标可扣分。
2. **两个积分来源**：①每天的 todolist 完成情况；②每天的考核得分。两者**各自独立结算**、各自分档。
3. **按制定人分两组**（2026-09-10 18:35 定案术语）：**「必须完成项」= 家长制定的计划**（孩子必须完成）；**「加分项」= 孩子自定的计划**（只加不扣）。两组**分开算**（完成率/得分率各自计算、各自分档）。
   - 库里仍用 `owner=parent|child` 存储，**"必须完成项/加分项"是面向用户的展示名**。
4. **分档按比例自由配置**（2026-09-10 18:05 定案）：家长端"积分奖罚设置"里按比例区间配置档位与每档积分变动；**档数不固定**（默认 4 档，可增删/改名/改区间/改分值）。
5. **门控按阈值配置**：只有**「必须完成项」达到阈值**，「加分项」才能加分——待办默认 **100%**、考核默认 **90%**（按阈值存，不依赖档位名，因档位可被改名）。
6. **「加分项」永远不扣分**（命中负分档按 0 处理）。
7. **扣分按"当天 missed 的比例"**（即完成率命中负分档），**不按 missed 条数**；每天独立结算，carry 复制来的新计划是 pending、不计 missed，故不会重复扣分。
8. **每一分变动都必须记录原因**（`points_ledger`：`reason_code` + 人类可读 `reason` + `rate` + 结构化 `meta_json` + 来源引用），流水是积分的唯一真源。
9. **兑换分两路**：APP 内兑换（虚拟权益） + 向家长提交兑换申请（现实权益，家长履约后扣积分）；兑换扣分同样写入流水（`reason_code='redeem'`）。
---

## 二、待办（Todo）积分规则（2026-09-10 18:00 定案：按制定人分组 + 门控）

### 2.1 分组口径
当天全部计划（学习/生活）按**制定人**分两组，**分开算完成率、分开分档**：
- **必须完成项**（`creator='parent'`）：家长制定的计划——孩子必须完成，未达标会扣分；
- **加分项**（`creator='child'`）：孩子自定的计划——只加不扣，且受门控约束（§2.3）。

**完成率按"归属日"算**（2026-09-10 18:25 定案，精确到跨天窗口）：
每个计划**只在一天进入统计**，归属日 = 它的最终结局日：
| 情况 | 归属日 | 计入 |
|---|---|---|
| **提前或按时完成**（含窗口内任一天完成） | **完成那天**（`date(done_at)`） | 那天：分母 +1、分子 +1；窗口内其它天**不统计** |
| **到期未完成（missed）** | **最后一天**（`date(due_at)`） | 那天：分母 +1、分子 +0；**前面几天不统计** |
| 仍在进行（`pending`，窗口未到期） | 无归属日 | 当天**不进分母**（等结局） |
| `cancelled` | — | 剔除，不进任何分母 |

- 口径：分母 = 该组「必做 + `count_in_rate=1` + 归属日 = 当天」的条数；分子 = 其中 `done` 的条数；
- 单日窗口（`start_at = due_at`）下两种情况的归属日都是当天 → 与旧行为一致；
- **carry 不造成重复扣分**：昨天 missed 属昨天结算；复制到当天的是**新的 `pending`**（不计 missed），今天仍未完成则今天判今天的 missed。
- ⚠️ 提醒：提前完成时当天分母可能很小（如仅 1 条 → 1/1 = 100% 命中"优秀"档）——这是"提前完成也给满档奖励"的预期行为；若希望设"最小分母门槛"，需另行配置（见 §七）。

### 2.2 分档：**按比例自由配置**（家长端"积分奖罚设置"区域）

**档数不固定**——默认 3 档，家长可增删档、改区间与分值（2026-09-10 18:05 定案）。配置形态是"比例区间 → 积分变动值"的列表：

| 默认档 | 完成率区间 | 名称（可改） | 积分变动 |
|---|---|---|---|
| 档1 | `[0, 60%)` | 不合格 | **-10**（仅"必须完成项"扣分；"加分项"强制 0） |
| 档2 | `[60%, 80%)` | 合格 | 0 |
| 档3 | `[80%, 100%)` | 良好 | **+10** |
| 档4 | `[100%, 100%]` | 优秀 | **+20**（**100% 是独立档**） |

- **100% 必须是独立档**（2026-09-10 18:25 定案）：区间为闭区间 `[1.0, 1.0]`，不与 `[80%,100%)` 合并——因为良好档是**左闭右开**，`100%` 落不进它。
- 配置存 `reward_configs.todo_tiers_json`：`[{ "min":0,"max":0.6,"label":"不合格","points":-10 }, {min:0.6,max:0.8,...}, {min:0.8,max:1.0,label:"良好",points:10}, {min:1.0,max:1.0,label:"优秀",points:20}]`；**区间须连续覆盖 [0,1]、互不重叠**（保存时校验）。
- **同一套档位配置供两组共用**；**「加分项」只取"加分档"**（`points > 0`），负分档按 0 处理（`child_no_deduct`）。

### 2.3 门控（孩子组加分的解锁条件）——**按阈值配置，不依赖档位名**

> **「必须完成项」完成率达到阈值（默认 100%），「加分项」才能加分。**

- ⚠️ 因档位可被家长改名/增删，**门控必须按阈值存**（`reward_configs.todo_gate_parent_min_rate`，默认 `1.0`），不能存"优秀"这种档位标签（改名即失效）。
- 必须完成项达标 → 加分项按其命中的**加分档**发分；
- 必须完成项未达阈值 → **加分项不加分**（达标了也不发，仅记录"未解锁"，不写流水）；
- **加分项永远不扣分**（命中负分档也按 0 处理）。

### 2.4 "未解锁"的含义与提示（**策略 A 定案**：2026-09-10 18:38）

**"未解锁"= 「加分项」达标了，但门控没开，所以没拿到分。** 具体情形：
- 加分项完成率命中**加分档**（如 100%、命中优秀 +20），但**「必须完成项」未达阈值**（待办需 100% / 考核需 90%）；
- 结果：**本次不加分**（只记录状态，不写流水）。

**策略 A（定案）：家长端 + 孩子端双向提示**，文案措辞如下：

| 端 | 文案（示例） | 要点 |
|---|---|---|
| **家长端** | "孩子今天的加分项完成率 100%（优秀档 +20），但**必须完成项**完成率 85%（未达 100% 门槛），本次孩子未加分。" | 明确指出是**必须完成项**卡住了，含建议动作（去完成计划） |
| **孩子端** | "本次未加分：**必须完成项**还没完成。" | **中性、不指名道姓**，避免"都怪爸妈"的指向；也不渲染委屈 |

**为什么这样设计**：
1. **透明**：孩子看到自己达标没加分、又没解释，会困惑甚至觉得不公；
2. **激励家长**：把"必须完成项没做完"变成可见的、有代价的事（卡住孩子的分），这正是门控设计的初衷。

数据侧不变：当日统计 `reward_daily_stats.gate_ok=0` 已记录该状态，提示只是把它显示出来。

## 三、考核积分规则（同样按制定人分组 + 门控）

### 3.1 分组与口径
按**考核计划的制定人**分组（必须完成项 / 加分项），完成率改为**当天考核的得分率**：
得分率 = **该组当天已完成场次的 Σ得分 / Σ满分**（多场次按分值加权合并，2026-09-10 18:25 定案）。
**当天没有已完成考核 → 当天不做考核结算**（不计数、不扣分）。

### 3.2 分档：同样**按比例自由配置**（默认 3 档，家长可改）

| 默认档 | 得分率区间 | 名称（可改） | 积分变动 |
|---|---|---|---|
| 档1 | `[0, 80%)` | 不合格 | **-15**（仅"必须完成项"扣分；"加分项"强制 0） |
| 档2 | `[80%, 90%)` | 合格 | 0 |
| 档3 | `[90%, 100%)` | 良好 | **+10** |
| 档4 | `[100%, 100%]` | 优秀 | **+20**（**100% 独立档**） |

- 存 `reward_configs.exam_tiers_json`，规则同 2.2（连续覆盖 [0,1]、互不重叠、可增删档）；**阈值与待办各一套**（待办 60/80/100，考核 80/90/100），互不影响。

### 3.3 门控（⚠️ 阈值与待办不同，务必注意）

> **「必须完成项」得分率达到阈值（默认 90%），「加分项」才能加分。** 存 `reward_configs.exam_gate_parent_min_score`（默认 `0.9`）。

- 家长组 ≥ `good` → 孩子组按加分档（`good`/`excellent`）发分；
- 家长组未达 `good` → 孩子组不加分（仅记录未解锁）；
- **孩子组永远不扣分**。

### 3.4 两条门控阈值对照（易错点）
| 来源 | 「必须完成项」解锁阈值 | 备注 |
|---|---|---|
| 待办 todolist | **100%** | 要求更高 |
| 考核 exam | **90%** | 要求较低 |

### 3.6 术语对照（同一概念的三套叫法，实现时勿混）
| 概念 | 面向用户（展示名） | 库里存储 | 说明 |
|---|---|---|---|
| 家长制定的计划/考核 | **必须完成项** | `owner='parent'` / 计划表 `creator='parent'` | 孩子必须完成；未达负分档会扣分 |
| 孩子自定的计划/考核 | **加分项** | `owner='child'` / `creator='child'` | 只加不扣；加分受门控约束 |
| 单条计划的性质 | 必做 / 选做 | `task_type='required'\|'optional'` | ⚠️ **与组名不同层级**：`required` 是"这一条算不算完成率分母"，"必须完成项"是"这组整体是家长定的" |


### 3.5 补充：选做项与"必做/选做"的关系（沿用早前规则）
- 加分只由**必做项**完成率分档决定；**选做项**在必做达标后按件加分（`points`），并入当日流水（`reason_code=optional`）；
- `task_type='optional'` 的条目不计入完成率分母。

## 四、积分兑换

### 4.1 APP 内兑换（虚拟权益，即时扣减）
兑换物示例（存于 `RedemptionItem` 目录，`kind = inapp`）：
- 看一集相关动画视频：30 分 / 次
- 玩一次网页小游戏：50 分 / 次
- 解锁头像框 / 皮肤：200 分
- 额外休息时长（如 +15 分钟）：按档定价

流程：孩子端选择 → 扣减积分 → 解锁/发放权益（如开放视频或游戏入口）。

### 4.2 向家长兑换（现实权益，申请制）
兑换物示例（`kind = parent`，仅定义描述与分值，实物由家长提供）：
- 100 分：决定今晚看哪部动画片
- 300 分：周末去公园 / 多 30 分钟游戏时间
- 500 分：一件心仪小玩具

流程：
1. 孩子端提交 `RedemptionRequest`（选物品或自定义描述 + 分值）。
2. 推送至**家长账号**待办。
3. 家长履约完成后在家长端标记 `fulfilled`。
4. 系统扣减对应积分（扣减发生在履约完成时，避免"未兑现先扣"）。

> 安全：兑换比例与物品目录由家长后台配置；孩子端只读可兑换列表。

---

## 五、数据模型（建议，2026-09-10 18:00 修订）

> **库归属**：全部在**孩子库**（与计划表/`daily_entries`/`courses` 同库，积分输入都在孩子库）。
> **原则**：`points_ledger` 是唯一真源（**每一分变动都有一条带原因的流水**）；余额由流水推导；所有写入幂等（防 stat 重跑重复发分）。

```sql
-- ① 积分规则配置（每孩子一套，家长可改数值）
CREATE TABLE IF NOT EXISTS reward_configs (
  child_id     TEXT PRIMARY KEY,
  -- 按比例自由分档（18:05 定案）：数组元素 {min,max,label,points}，min/max 为 0~1 小数，区间连续覆盖 [0,1]、互不重叠
  -- 默认 4 档、分值定案（18:42）：不合格 −10/−15、合格 0、良好 +10、优秀 +20；100% 为独立档
  -- 待办：[{min:0,max:0.6,-10},{0.6,0.8,0},{0.8,1.0,+10},{1.0,1.0,+20}]
  -- 考核：[{min:0,max:0.8,-15},{0.8,0.9,0},{0.9,1.0,+10},{1.0,1.0,+20}]
  todo_tiers_json TEXT NOT NULL DEFAULT '[]',  -- 待办：60 / 80 / 100
  exam_tiers_json TEXT NOT NULL DEFAULT '[]',  -- 考核：80 / 90 / 100
  -- 门控：孩子组加分需家长组达到的**阈值**（不能存档位名——家长可改名/增删档，18:05 修正）
  todo_gate_parent_min_rate REAL NOT NULL DEFAULT 1.0,  -- 待办：家长组完成率须 ≥100%
  exam_gate_parent_min_score REAL NOT NULL DEFAULT 0.9, -- 考核：家长组得分率须 ≥90%
  child_no_deduct  INTEGER NOT NULL DEFAULT 1,  -- 1=孩子组永不扣分（命中负分档按 0 处理）
  optional_points  INTEGER NOT NULL DEFAULT 5,  -- 选做项单件加分
  updated      TEXT NOT NULL DEFAULT ''
);

-- ② 每日结算统计（按 来源 × 制定人 分组；设计稿 §2 的 plan_daily_stats 并入此表）
CREATE TABLE IF NOT EXISTS reward_daily_stats (
  child_id     TEXT NOT NULL,
  date         TEXT NOT NULL,
  source       TEXT NOT NULL,          -- todo | exam
  owner        TEXT NOT NULL,          -- parent | child（制定人分组）
  required_total INTEGER NOT NULL DEFAULT 0,   -- 分母（必做且非 cancelled）
  required_done  INTEGER NOT NULL DEFAULT 0,
  optional_done  INTEGER NOT NULL DEFAULT 0,
  missed_count   INTEGER NOT NULL DEFAULT 0,
  cancelled_count INTEGER NOT NULL DEFAULT 0,
  rate         REAL NOT NULL DEFAULT 0,        -- todo=完成率 / exam=得分率
  tier         TEXT NOT NULL DEFAULT '',       -- fail | pass | good | excellent
  gate_ok      INTEGER,                        -- 仅 owner=child：家长组是否达门控（1/0，NULL=不适用）
  points_awarded INTEGER NOT NULL DEFAULT 0,   -- 本次结算发出的分（可负=扣分；gate 未开且达标时=0）
  settled_at   TEXT NOT NULL DEFAULT '',
  updated      TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (child_id, date, source, owner)
);

-- ③ 积分流水（唯一真源；每一分变动都记录原因）
CREATE TABLE IF NOT EXISTS points_ledger (
  id           TEXT PRIMARY KEY,
  child_id     TEXT NOT NULL,
  ts           TEXT NOT NULL,                 -- 发生时间（精确到秒）
  biz_date     TEXT NOT NULL,                 -- 归属日期（按天结算）
  type         TEXT NOT NULL,                 -- earn | deduct | redeem | adjust
  amount       INTEGER NOT NULL,              -- 整数分（earn>0、deduct 记正数由 type 表达方向、redeem 记正数）
  balance_after INTEGER NOT NULL,             -- 变动后余额快照（便于校验与展示）
  -- reason_code 为**来源级**枚举（档位可自由增删，故不把档位编码进 code）
  reason_code  TEXT NOT NULL,                 -- todo_award|todo_deduct|exam_award|exam_deduct|optional|redeem|adjust
  reason       TEXT NOT NULL,                 -- 人类可读原因，含命中档位与比例（如"家长组计划完成率 100%，命中[80%,100%]档 +20"）
  rate         REAL,                          -- 触发本次变动的比例（todo=完成率 / exam=得分率；手工调整为 NULL）
  meta_json    TEXT NOT NULL DEFAULT '',      -- 结构化快照 {tier:{min,max,label}, owner, counts:{total,done,missed}}
  source_table TEXT NOT NULL DEFAULT '',      -- reward_daily_stats | redemption_requests | manual
  source_id    TEXT NOT NULL DEFAULT '',      -- 关联行的标识（如 `date|source|owner`）
  operator     TEXT NOT NULL DEFAULT 'system',-- system | parent
  created_at   TEXT NOT NULL
);
-- 幂等：同一来源同一类型只记一次（stat 重跑不重复发分；不把 reason_code 放进唯一键——档位可自定义）
CREATE UNIQUE INDEX IF NOT EXISTS ux_ledger_once
  ON points_ledger(child_id, biz_date, type, source_table, source_id);
CREATE INDEX IF NOT EXISTS idx_ledger_child_date ON points_ledger(child_id, biz_date);

-- ④ 余额（可选缓存；真源仍是流水）
CREATE TABLE IF NOT EXISTS points_balance (
  child_id TEXT PRIMARY KEY,
  balance  INTEGER NOT NULL DEFAULT 0,
  updated  TEXT NOT NULL DEFAULT ''
);

-- ⑤ 兑换目录 / ⑥ 兑换申请（沿用既有定案；兑换扣分同样写流水 reason_code='redeem'）
-- 兑换目录：**本期先只建表**（18:25 定案）——不给默认定价/种子数据，由家长端自行编辑
CREATE TABLE IF NOT EXISTS redemption_items (
  id TEXT PRIMARY KEY, child_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, cost INTEGER NOT NULL, -- 家长定价
  kind TEXT NOT NULL DEFAULT 'inapp',        -- inapp | video | game | skin（虚拟权益）| parent（现实权益）
  payload_json TEXT NOT NULL DEFAULT '{}',   -- 虚拟权益：入口参数（视频/游戏/皮肤）；parent：描述
  enabled INTEGER NOT NULL DEFAULT 1,
  updated TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS redemption_requests (
  id TEXT PRIMARY KEY, child_id TEXT NOT NULL,
  item_id TEXT NOT NULL DEFAULT '', custom_desc TEXT NOT NULL DEFAULT '',
  cost INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', -- pending | fulfilled | rejected
  parent_id TEXT NOT NULL DEFAULT '', fulfilled_at TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
```

## 六、结算流程（每日，stat tick 内）

```
对每个孩子、每天 D（**只结算当天**）：
  0) 分母（两组各自）= 该组中「必做 + count_in_rate=1 + **归属日 = 当天** + 非 cancelled」的计划数；
     归属日规则（18:25 定案）：done → date(done_at)（完成那天计入分子+分母）；
                             missed → date(due_at)（只在最后一天计入分母，前面不计）；
                             pending → 无归属日，不进分母。
     → 完成率 = done / 分母；跨天窗口在完成日或到期日**各只结算一次**。
  1) 必须完成项 todo（owner=parent）：完成率 → 命中 reward_configs.todo_tiers_json 的档 → 写 stats(source=todo,owner=parent)
       档 points<0 → ledger(type=deduct, reason_code=todo_deduct, rate=完成率, reason="家长组计划完成率 45%，命中[0,60%)档 −10")
       档 points>0 → ledger(type=earn,  reason_code=todo_award, ...)
       档 points=0 → 无变动、不写流水
  2) 加分项 todo（owner=child）：完成率 → 命中加分档 且 **必须完成项完成率 ≥ todo_gate_parent_min_rate(1.0)** → ledger(earn, todo_award)
       门控未开 → gate_ok=0、不加分（不写流水，仅统计可见，并按 §2.4 双向提示）；命中负分档 → 按 0（加分项不扣分）
  3) 必须完成项 exam：**当天有已完成考核才结算**（无考核不结算、不扣）；得分率=Σ得分/Σ满分 → 同 1)（exam 阈值）
  4) 加分项 exam：仅当 **必须完成项得分率 ≥ exam_gate_parent_min_score(0.9)** 才加分；加分项不扣分
  5) 选做项：必做达标后按件加分（reason_code=optional）
  6) 幂等：ledger 唯一索引 + stats.settled_at；重跑只补未结算部分
  7) 余额刷新：points_balance = SUM(earn − deduct − redeem)
```

## 七、决策记录（**全部已定案**，2026-09-10 18:42 收口）

> 本节为决策流水（含定案时间），速查清单见 §九。

1. ~~家长组扣分口径~~ → **定案：按当天 missed 的"比例"扣分（完成率命中负分档），不按条数**；每天独立结算、carry 新计划是 pending 不计 missed。"不设上限"=负分档按天累积不封顶。
2. ~~当天分母口径~~ → **定案（18:25）：按"归属日"**——done 计入完成那天、missed 只计入最后一天（due_at）、pending 不进分母（§2.1）。
3. ~~默认档位~~ → **定案（18:25）：100% 独立档**。待办 4 档 `[0,60%) 不合格 / [60%,80%) 合格 / [80%,100%) 良好 +10 / [100%,100%] 优秀 +20`；考核 4 档 `[0,80%) 不合格 / [80%,90%) 合格 / [90%,100%) 良好 +10 / [100%,100%] 优秀 +20`。
4. ~~不合格档扣分值~~ → **定案（18:42）：待办 `-10`、考核 `-15`**（仅"必须完成项"触发，家长端可改）。
5. ~~一天多次考核~~ → **定案（18:25）：按 Σ得分/Σ满分 加权合并**。
6. ~~兑换目录定价~~ → **定案（18:25）：本期只建表、不给种子定价，家长端自行编辑**。
7. ~~最小分母门槛~~ → **定案（18:42）：不设门槛**——提前完成时即使当天分母仅 1 条，`1/1=100%` 照常命中"优秀 +20"。
8. ~~"未解锁"是否提示~~ → **定案（18:38）：策略 A**（家长端 + 孩子端双向提示），文案见 §2.4；家长组统一称**「必须完成项」**、孩子组称**「加分项」**。

## 八、落地建议（下一步）

1. `reward_configs` 种子数据（默认阈值/分值/门控档位），家长端可改；
2. 在计划表/`daily_entries` 已知结构上实现 §六 结算（挂 stat tick 末尾，`worker_state` 加 `reward_settle` 游标，沿用 `todo_stat` 的 last_key 幂等模式）；
3. 孩子端积分页（余额 + 明细流水的 reason 展示）、家长端兑换目录配置 + 审批列表 + 未解锁提示；
4. 与计划域重构（`DESIGN-plan-domain-rewrite-2026-09-10.md`）同批实施：积分结算依赖三张计划表与 `creator` 分组。

---

## 九、决策汇总（表结构冻结版，2026-09-10 18:42）

> 实现时按此清单逐条核对；每一条都有上文出处。

| # | 决策 | 值/规则 |
|---|---|---|
| 1 | 分组 | 按制定人两组：**必须完成项**（`creator/owner=parent`）/ **加分项**（`child`）；库里存 parent/child，展示名可换 |
| 2 | 两个来源 | 每天 ①todolist 完成率 ②考核得分率；各自独立结算、阈值各一套 |
| 3 | 分档 | 按比例自由配置（家长端"积分奖罚设置"）；**默认 4 档**、区间左闭右开、**100% 为独立闭区间档** |
| 4 | 默认分值 | 待办 `[0,60%)-10 / [60,80%)0 / [80,100%)+10 / [100%,100%]+20`；考核 `[0,80%)-15 / [80,90%)0 / [90%,100%)+10 / [100%,100%]+20` |
| 5 | 门控（加分项才加分） | 待办：必须完成项 ≥**100%**；考核：必须完成项 ≥**90%**（按**阈值**存，不存档位名） |
| 6 | 加分项不扣分 | 命中负分档按 0 处理（`child_no_deduct=1`） |
| 7 | 扣分口径 | 按当天 missed 的**比例**（完成率命中负分档），**不按条数**；负分档按天累积、**不封顶** |
| 8 | 归属日（跨天窗口） | done → 完成那天（分母+1 分子+1）；missed → 只计入最后一天 due_at（分母+1 分子+0）；pending 不进分母 |
| 9 | **不设最小分母门槛** | 提前完成时 `1/1=100%` 照常发满档 |
| 10 | 一天多次考核 | 按 `Σ得分/Σ满分` 加权合并 |
| 11 | 每分必记原因 | `points_ledger`：`reason_code`(来源级) + `reason`(人读) + `rate` + `meta_json` + `source_table/source_id` + `operator` |
| 12 | 幂等 | 唯一索引 `(child_id, biz_date, type, source_table, source_id)`（**不含 reason_code**，因档位可自定义）；stats 用 `settled_at` |
| 13 | 余额 | 真源 = 流水；`points_balance` 仅缓存，可用 `SUM(earn−deduct−redeem)` 校验 |
| 14 | 未解锁提示 | **策略 A 双向提示**；家长端点明"必须完成项未达门槛"，孩子端中性措辞 |
| 15 | 兑换 | 本期**只建表**、无种子定价，家长端编辑；兑换扣分写流水 `reason_code='redeem'` |
| 16 | 库归属 | 积分域全部在**孩子库**（与计划表/daily/courses 同库）；家长审批走服务端接口读写孩子 kb |
| 17 | 结算时机 | stat tick 末尾，`worker_state` 加 `reward_settle` 游标，沿用 `todo_stat.last_key` 幂等模式 |

**实现红线**：
- 门控**必须按阈值**判定（档位名可被家长改，用名字会失效）；
- 负分档对"加分项"强制 0（孩子不扣分）；
- 归属日规则是分母口径的唯一依据（不是"当天到期"）；
- 未解锁**不写流水**（只写 stats 的 `gate_ok=0`），避免污染积分真源。

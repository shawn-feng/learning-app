# ISSUE-140 · H1「提醒我…」的对话出口（工具 + 记录口径）

- **类型**：需求 / **回归修复**（原能力在 agent 上移时丢失）
- **描述**：孩子说「提醒我明天带跳绳」这条场景**必须有对话出口**——需要一个**记录提醒的工具**，并把「**怎么记录**（时间怎么说、落到哪些字段、什么时候该反问）」写成明确口径，同时补进①基底提示词的 [域 H] 一节。
- **影响范围**：① 孩子 agent 工具面（**新增 3 个工具**，主会话 + 课程会话装配）；② ①基底提示词新增 [域 H] 节；③ 不改服务端接口与库结构（**链路早已完整**）。
- **排查/修改入口**：`server/src/agent/session-registry.ts`（`computeChildToolNames` 装配）｜新增工具文件（建议 `server/src/agent/reminder-tools.ts`，复用 `server/src/db/task-runs.ts` 的 `createReminderTask` / `listChildReminders`）｜`server/src/agent/prompt.ts`（提示词）。
- **优先级**：中-高（**界面文案已经在承诺这件事**，不修就是"AI 装听不懂 + 家长以为孩子能建"）
- **记录时间**：2026-09-23
- **关联**：`ISSUE-047`（孩子端自建定时提醒的原始需求与实现）；`ISSUE-136`（[域 H] H1 提示词规格）；`docs/孩子使用场景梳理-2026-09-23.md`（§4 域 H / §7 / §8）

---

## 一、结论先说：**这是回归，不是新需求**

| 事实 | 证据 |
|---|---|
| **界面在承诺** | `src/components/MyRemindersModal.tsx:132-136` 原话：**「你让 AI 伙伴帮你设的定时提醒」「想新增提醒，直接对 AI 伙伴说，例如"每天 9 点提醒我读英语"」**——**弹框内没有任何新建入口**，创建通道**只有对话** |
| **后端在等** | `POST /api/v1/scheduler/reminders`（`server/src/routes/scheduler.ts:277`）注释原文：**「ISSUE-047：孩子端 agent 自建定时提醒（语音 + 频率）……owner 默认 child（agent 创建）」** |
| **工具没了** | `computeChildToolNames`（`session-registry.ts`）**没有任何提醒工具**；旧工具 `schedule_task`（ISSUE-047 落在客户端 `electron/lib/custom-tools.ts` + `pi-session.ts`）**全仓已无命中** → agent 上移时**未迁移** |

⇒ 现在是「**界面说有、后端支持、模型不会**」的三方不一致。修的是**一致性**，不是加功能。

---

## 二、现状核实（能复用的部分）

**后端：完整可用，不用动**

| 层 | 位置 | 说明 |
|---|---|---|
| 创建 | `POST /api/v1/scheduler/reminders`（`routes/scheduler.ts:277`） | 必填 `childId` / `name` / `text` / **`time`(HH:mm)**；`frequency ∈ once｜daily｜weekly｜interval`（缺省 daily）；`weekly` 需 `weekday`、`interval` 需 `intervalMinutes`、**`once` 需 `fireAt`(ISO)**；`voice` 默认 true；`owner` 默认 **child** |
| 到期拉取 | `GET /api/v1/scheduler/reminders`（同文件） | 客户端**每分钟轮询** → 返回"到期且未播报"的提醒并**就地标记已触发**（幂等） |
| 列举 | `GET /api/v1/scheduler/reminders/list` | 该孩子全部提醒（含已停用/过期） |
| 库层 | `server/src/db/task-runs.ts` | `createReminderTask`(336) / `listChildReminders`(372) / `isReminderDue`(428) / `takeDueReminders`(461)；`interval` 的 `last_fired_at` 从创建时刻起算 |
| 表 | `scheduler_tasks(type='reminder')` + `scheduler_task_assignments` | 列：`reminder_text` / `frequency` / `weekday` / `interval_minutes` / `voice` / `fire_at` / `last_fired_at` / `expired` / `owner`（`db.ts:149-156`） |
| 到点表现 | 客户端 | **语音播报 + 横幅**（`Learn.tsx` 的 `reminderSpeaking` 链路），横幅点击关闭、不自动消失 |

**已有工具（但不能直接给孩子）**：`create_reminders`（`worker/custom-task-tools.ts:20`，在 `CUSTOM_TASK_TOOL_NAMES` 里）——它是给**家长自定义定时任务的执行会话**用的：**批量数组**、`owner='parent'`、带 `source_task` 滚动替换与精确去重。**语义与孩子侧不同**（孩子是"对我说的一件小事"，家长任务是"批量生成播报窗口"），**不建议直接复用**。

**界面**：`MyRemindersModal.tsx`（侧栏 🔔）——**只列 + 可取消**（`reminderList` / `reminderCancel`），**无新建**。列表字段够用（`name/text/time/frequency/weekday/intervalMinutes/voice/fireAt/enabled/expired`）。

---

## 三、方案：新增 3 个小工具（孩子侧专用）

装配进 `computeChildToolNames` 的**主会话 + 课程会话**（**场景会话不加**——场景课是全托管，不该被打断；与 fs/计划工具同口径）。

| 工具 | 参数 | 行为 |
|---|---|---|
| **`child_reminder_create`** | `text`✅｜`time`✅(HH:mm)｜`frequency`(once/daily/weekly/interval，缺省 daily)｜`fireAt`(once 用，ISO)｜`weekday`｜`intervalMinutes`｜`name`｜`voice`(默认 true) | **单条**创建（**不收数组**）；落 `owner='child'`；返回"下次什么时候响"的人话 |
| **`child_reminder_list`** | 无（可选 `include_inactive`） | 列出**自己的**未停用/未过期提醒，按下次触发排序，每条给**人话时间**（"明天 7:00""每天 9:00""每 30 分钟"） |
| **`child_reminder_cancel`** | `id` 或 `match`(内容片段) | 取消（孩子说"不用提醒我了"）；只允许取消 **owner='child'** 的 |

**为什么不用一个工具带 `action`**：本仓计划域已是"每动作一个工具"的惯例（`child_study_plan_create/list/update`）；且**取消是危险动作**，独立命名让模型更难误调。

**服务端注入 `parentId`/`childId`**：模型**无法指定**给谁建——天然只作用于当前孩子。

---

## 四、**如何记录**（本 issue 的重点：时间怎么说 → 落到哪个字段）

> 这是 H1 真正容易做错的地方：**"提醒我明天带跳绳"里没有时刻**，而库层 `time` 是**必填**。规则必须写死在工具描述 + 提示词里。

**第 0 步：先取时间。** 调 `get_date`（返回 `YYYY-MM-DD HH:mm`，`parent-registry.ts:79`）拿到"今天几号、现在几点"，**再算相对时间**。**不许凭印象推算日期**。

**第 1 步：时刻必须有；没有就问。**

- 孩子没说几点 → **先反问一句**："明天几点提醒你？"
- 孩子给模糊词（"早上""晚上"）→ 给**一个建议时刻**并**复述确认**："明天早上 7:30 提醒你带跳绳，行吗？"
- **绝不自己编一个时刻**——编了就是"孩子以为说清楚了、结果七点被吵醒"。

**第 2 步：日期 → 频率/字段映射表（写进工具描述）**

| 孩子的说法 | `frequency` | 关键字段 | 备注 |
|---|---|---|---|
| "现在起 30 分钟后提醒我" | **`once`** | `fireAt = now + 30min`、`time` 取该时刻的 HH:mm | ⚠ **不是 interval**（见下） |
| "今天下午 4 点提醒我" | `once` | **必须显式给 `fireAt`**（不能靠缺省） | 缺省是"明天该时刻"，会错 |
| "明天 7 点提醒我" | `once` | `fireAt` 可省（缺省=明天该时刻），**显式给更稳** | |
| "后天 / 下周三 / 3 月 5 日" | `once` | **必须显式给 `fireAt`** | 靠 `get_date` 算 |
| "每天 9 点提醒我" | `daily` | `time="09:00"` | |
| "每周六上午 10 点" | `weekly` | `weekday`(0=周日..6=周六) + `time` | |
| "每隔 30 分钟提醒我喝水" | `interval` | `intervalMinutes=30` | **循环提醒，会一直重复** |

**第 3 步：⚠ 语义坑——`interval` 是"每隔 N 分钟一直提醒"，不是"过 N 分钟后提醒一次"。**
这两句孩子都会说，含义完全不同，**模型最容易混**：

- 「**半小时后**提醒我喝水」→ `once` + `fireAt = now + 30min`（响一次）
- 「**每隔半小时**提醒我喝水」→ `interval` + `intervalMinutes = 30`（一直响）
- 反例后果：孩子说"半小时后"，结果每 30 分钟响一次、响一整天。

**第 4 步：一次说多件事 = 建多条。** "明天带跳绳和美术袋"是**一条**（同一时刻同一场景）；"明天 7 点带跳绳、晚上 8 点练琴"是**两条**——**循环调用工具**，不要塞进一条 `text`。

**第 5 步：建完必须回执 + 给出路。**
"好，明天 7:00 提醒你带跳绳——到点我会喊你。想看或取消，点左边 🔔 我的提醒。"

---

## 五、边界与上限

| # | 边界 | 理由 |
|---|---|---|
| 1 | **不许口头答应**（"好的我记着了"）**但不落库** | 孩子会白等；模型必须真的调工具，失败就如实说 |
| 2 | **建失败要如实说**：缺时刻（工具报错）→ 回去问；**重复**（同 `text`+`time`+`frequency` 已存在）→ 说"这条已经有了，不用重复建" | 库层已精确去重，工具要把结果**转成人话**，不能谎报成功 |
| 3 | **数量上限**：同一孩子**未过期提醒建议 ≤ 20 条**（工具内校验并如实拒绝），提示"先去 🔔 我的提醒 清理一下" | 防止孩子一句话刷出几十条播报 |
| 4 | **不能建给别人** | `parentId/childId` 由服务端注入 |
| 5 | **家长可见**：`owner='child'` 的提醒在**家长端任务管理页只读可见、可关闭/删除**（沿用 ISSUE-047 定案，**不经审核**） | 避免"孩子被 agent 误建一堆任务" |
| 6 | **不把"学习计划"改成提醒** | 计划有自己的链路（B4/B5）；提醒只装"带东西/喝水/练琴"这类**小事** |
| 7 | **只在孩子在设备上时播报**（客户端轮询 + 语音），离线不补播 | 现有语义，明确写清以免模型承诺"我一定会提醒你" |

---

## 六、待拍板

1. **取消能力要不要一起给**（`child_reminder_cancel`）？界面已能取消，但"不用提醒我了"是自然语言，**建议给**。
2. **上限取多少**（建议 20 条未过期）？
3. 到点提示**要不要能进一步对话**（提醒播完说"我带了"→ 标记完成）？**本 issue 不做**，只记一笔。
4. 「半小时后」这类**相对时间**是否需要**跨"现在几点了"校准**（比如孩子 23:50 说"半小时后"→ 落在次日 00:20，属正常）——**建议照实建**，不额外拦。

---

## 七、验收

- **可建**：重开会话 → 说「提醒我明天带跳绳」→ agent **先反问几点** → 落库一条 `once`（`fireAt` = 明天该时刻）+ **回执含"去哪取消"**；
- **可辨**：「半小时后提醒我喝水」落 **once**；「每隔半小时提醒我喝水」落 **interval**（**两条并存互不覆盖**）；
- **可查可撤**：说「我有哪些提醒」→ 列出人话时间；说「不用提醒我了」→ 取消成功；**🔔 我的提醒**里能看见并手动取消；
- **到点**：到时刻客户端**语音播报 + 横幅**；
- **失败如实**：重复建同一条 → 返回"已经有了"，**不重复建**；超过上限 → 如实拒绝并给清理指引；
- **不多不少**：只给孩子自己建（家长任务页可见），**场景会话里没有这三个工具**。

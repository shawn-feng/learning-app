# ISSUE-185：计划行 id 只给前 8 位 → agent 拿不到唯一 id（考核撤不掉、还可能撤错行）

- **类型**：bug（工具输出截断 + 定位"取第一条"的静默选择）
- **优先级**：**高**（家长/孩子 agent 的"取消/改期"类操作在真实数据上直接不可用，且有改错行的风险）
- **状态**：✅ **已修复（2026-10-16，本地代码 + 回归测试；服务端需重新构建部署）**
- **记录时间**：2026-10-16
- **标签**：`家长agent` `孩子agent` `计划域` `exam_plans` `study_plans` `life_plans` `plan_recurrences` `工具输出` `resolveRowById`
- **关联**：ISSUE-085（考核取消能力首次落地）、ISSUE-121（同日多场考核靠名字区分）、ISSUE-149（跨日期计划）

---

## 一、症状（家长 agent 原话）

> 「旧的那一场我撤不掉，得请您在界面上手动撤一下，原因如实说明：**考核列表只给我行 id 的前 8 位，而今天珊珊（还有闻闻）所有考核的前 8 位全都一样（ep_17921）**——也就是这一场的唯一行号我拿不到。」

---

## 二、根因（两件事叠在一起）

### 2.1 id 本身：同日多场考核的前缀天然相同
`exam_plans` 自定义考核 id 的生成式（`parent-plans.ts` / `routes/exam.ts`）：

```js
const id = `ep_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

时间戳在**前**、随机段在**后** ⇒ 同一天（更准确说同一毫秒量级）创建的场次，**前 8 位恒为 `ep_17921…` 形式**。学习/生活计划（`sp_` / `lp_`）同款。

### 2.2 工具层：列表截断 + 定位取第一条
- **列表**：`parent_exam_plan_list` 等工具输出 `r.id.slice(0, 8)`，并在结语里写「行 id 取前 8 位」——**主动鼓励传前缀**；
- **定位**：`_cancel` / `_update` 一律 `rows.find(r => r.id === want || r.id.startsWith(want))` ⇒ 前缀命中多行时**静默取第一条**：轻则"撤不掉/撤错行"，重则撤了家长没点名的另一场。

---

## 三、修复

### 3.1 统一口径：列表给**完整 id**，定位走 `resolveRowById`
新增 `server/src/util/row-id.ts`：

```ts
resolveRowById(rows, wantId, what)   // 精确匹配优先；
                                     // 只有传前缀时才 startsWith，且多命中 → 报错并列出完整候选
```

**绝不猜**：歧义时错误信息直接把候选的完整 id 列出来，agent 一步就能重试。

### 3.2 落地清单

| 位置 | 改动 |
|---|---|
| `parent_exam_plan_list` | 输出完整 `id`；结语改为"行 id 已给全值，同日多场前缀相同，别只传前几位" |
| `parent_study_plan_list` / `parent_life_plan_list` / `parent_recurrence_list` | 同上（输出完整 id） |
| `parent_exam_plan_cancel` / `parent_study_plan_update` / `parent_life_plan_update` / `parent_recurrence_update` | 改走 `resolveRowById`；参数说明改为"用 `_list` 返回的完整 id" |
| `child_exam_plan_list` / `child_study_plan_list` / `child_life_plan_list`（`plan-tools.ts`） | 同样输出完整 id（孩子也要能撤自己的自请考核） |
| `child_exam_plan_update` / `child_study_plan_update` / `child_life_plan_update` | 改走 `resolveRowById` |
| `parent-scene-plan` 技能正文 | "可传前 8 位"口径作废 → "原样用列表回的完整值"（保留"前 8 位"字样作为**作废说明**，防旧习惯回流） |

> 与 `parent_child_exam_report` 对齐：那个工具本来就输出 `id=<完整值>`，同一份数据两处口径不一致本身就是 bug。

---

## 四、验证

`test/issue185-plan-row-ids.test.ts`（5 例，全部用真实工具 `execute`）：

1. 考核列表输出完整 id（同日同前缀两场都能区分），且不再出现「取前 8 位」；
2. **只传公共前缀 → 抛歧义错误、列出两条完整候选，且一行都没被取消**；
3. 传完整 id → 精确取消目标行，另一行仍 `pending`；
4. 学习计划同款：列表给全值、`parent_study_plan_update` 前缀撞多行被拒、完整 id 照常用；
5. 孩子侧同款：`child_exam_plan_list` 给全值、`child_exam_plan_update` 传 `ep_17921` 被拒且两条自请考核都还在。

**非假绿**：把列表改回 `slice(0, 8)`、定位改回"取第一条"，5 例全红。

相邻回归：`issue121` 4 例、`issue144-parent-skills` 45 例（含工具块预算）、`issue132` 7 例、`issue184` 2 例全绿；`server tsc --noEmit` 无新增错误。

---

## 五、部署
- **纯服务端**（工具输出 + 定位；客户端零改动）→ 重建 `server.cjs` 部署即可。
- 存量数据无需迁移：id 形态不变，只是**给全**。

## 六、遗留（可选，未做）
- **id 生成式**：把随机段挪到前面（如 `ep_<rand6>_<ts>`）可让"前 8 位"天然可区分——本轮没改（会成为第三种 id 形态，且已有外部按 id 存取的历史数据）；工具层给全值后不构成阻塞。
- 其他"给 uuid 前 8 位"的提示性输出（如 `parent_upsert_course` 的撞名警告）**不是**定位参数，保持原样。

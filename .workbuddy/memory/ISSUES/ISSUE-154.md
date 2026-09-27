# ISSUE-154：家长问单主题进度时两个工具口径不一致（510 vs 315）+ parent_library_topics 无主题过滤且每行带方法全文

- **类型**：bug / 工具口径（家长 agent 数据洞察）
- **优先级**：中（家长高频问题「孩子学得怎么样」的答数直接对不上）
- **记录时间**：2026-09-27（用户实测反馈，随 ISSUE-135 P5 验证发现）
- **状态**：✅ **已修复（0.5.16，本地已部署验证；未上 201）**

## 现象（用户原话要点）

1. 家长 agent 对话里问「论语的学习进度统计」，**两个工具给出的进度不一致**：agent 报「已完成 510 课（家长库进度视图；掌握报告另一口径统计到 315 课有学习记录）」。
2. 「我已经说了是论语的学习情况，为什么还要用 parent_library_topics 查出其他主题的情况？」

## 根因（实测到字段级）

1. **跨孩子合计口径**：`parent_library_topics` 的进度来自 `familyProgress()`——它遍历**名下全部孩子**的孩子库，把各孩子的 `topic_progress.learned` **相加**：论语 510 = 珊珊 315 + 闻闻 195（小明 0）。而 `parent_child_mastery_report` 按孩子读（珊珊 315/512）。家长问单个孩子时两个数必然对不上；agent 只能把两个数都报出来和稀泥。
2. **无 topic 参数**：该工具 `parameters: Type.Object({})`——家长点名主题也只能全量拉回 11 个主题。
3. **每行附带主题教学方法全文**（`｜方法：${r.method}`）：进度清单里塞进场景英语/论语的整段教学法，纯 token 炸弹（agent 本次并不需要方法）。

孩子库内部本身自洽：珊珊 topic_progress=315/512、status='✅' 315 门、last_review 非空 315 门、第一个非✅课=下一课（颜渊篇第十三章）——问题只在工具层。

## 修复（0.5.16）

| # | 改动 | 落点 |
|---|---|---|
| 1 | **`familyProgress()` 按孩子分列**：`byTopicKey` 改为 `主题 → [{child, learned, total}]`，不再跨孩子相加 | `agent/parent-tools.ts` |
| 2 | **`parent_library_topics` 加 `topic`（目录名或中文名，经 resolveTopicKey 归一）与 `child`（孩子姓名）两个可选参数**；输出格式：多孩子 `- 论语（lunyu）：珊珊 315/512 · 闻闻 195/512 · 小明 0/512`，单孩子 `已学 315/512`；**去掉 `｜方法：全文`**（方法走 `parent_content(type=method)`） | 同上 |
| 3 | **`parent_library_courses` 加 `child` 参数**：传了按该孩子孩子库口径输出（✅已完成/进行中），不传保持名下合计并在描述注明口径 | 同上 |
| 4 | **技能指引**：progress 表格行/参数速查、course 参数速查同步新参数与分列口径；写明「家长点名主题问进度直接 `parent_child_mastery_report(topic)`（topic 收中文名/拼音），不必先调本工具」 | `agent/skills/parent/progress.ts` + `course.ts` |

## 验证

- 新增 `test/parent-library-topics.test.ts`（5 例）：①分列不含合计数 12/10 ②不含方法全文 ③topic 按 key/中文名命中、不存在报错 ④child 过滤、不存在报错列候选 ⑤coursesTool 带/不带 child 两口径。
- 关联回归：issue144-parent-skills 45 例（工具块 16853/17000）+ scene-override 8 + issue133 16 + issue134 19 全绿；server tsc 0 新增错。
- 真实数据端到端（本地 0.5.16）：无参数按孩子分列、topic=论语（中文名）→ `闻闻 195/512 · 珊珊 315/512 · 小明 0/512`、child=珊珊 只出她的数——与 mastery_report 同口径。

## 遗留

- **未上 201**（随下个 server 版本与客户端包一起部署）。
- `topic_progress` 在客户端（electron）维护，珊珊 315 与「已学 547/1304」的看板同源一致；若日后出现客户端聚合与课程行不一致，另开 issue。

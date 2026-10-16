# ISSUE-184：家长题库「所有题目都没挂载知识点」——挂载反查被**单页上限**截断（ISSUE-148 的第二层同源截断）

- **类型**：bug（读取路径截断 → UI 显示严重失真；**数据本身完好**）
- **优先级**：**高**（家长打开题库第一眼就是"全都没挂载"，直接怀疑数据丢了）
- **状态**：✅ **已修复（2026-10-16，本地代码 + 回归测试；服务端需重新构建部署）**
- **记录时间**：2026-10-16
- **标签**：`题库` `QuestionBankPanel` `bank_question_contexts` `buildPathQuery` `注册表路径` `rowLimit` `分页`
- **关联**：ISSUE-148（同一函数、同一症状、**第一层**截断：全局 `READ_MAX_LIMIT=200`）、ISSUE-074/132（题库列表 `BANK_LIST_LIMIT`，另一个 LIMIT）

---

## 一、症状（用户原话）

> 「家长界面的题库里，所有的题目都显示没有挂载知识点。排查一下问题。」

现场：家长端「题库」列表里，**从第一屏开始**每道题都带黄色「未挂载」标记，点开详情也是「未挂载（不归属任何课程/知识点）」。

---

## 二、排查结论

### 2.1 数据没丢——直连库挂载齐全

以现场家长库 `data/parents/86a84278-…/parent.sqlite`（珊珊/闻闻）实测：

| 表 | 行数 |
|---|---|
| `question_bank`（题库） | 12824 |
| `course_knowledge_questions`（挂载桥） | **12913**（`MAX(rowid)=13280`，含历史删除空洞） |
| `knowledge_points` | 11218 |

→ 挂载关系**在库里**，是读取路径丢的。

### 2.2 根因：路径注册表的 `rowLimit`（5000）被当成"全量"用了

`server/src/db/assess-content.ts` 的 `listAllBankQuestions()`（家长题库列表 + 每道题的 `contexts`）此前这样取挂载：

```js
const { sql, params } = buildPathQuery(registeredPath("bank_question_contexts"), {
  orderBy: "course_knowledge_questions.rowid",
  limit: 5000,          // ← 只查一页
  ignoreGlobalCap: true // ISSUE-148 修的：放开全局 READ_MAX_LIMIT=200
});
```

三层叠加成灾：

1. `buildPathQuery` 的 `limit = min(req.limit, path.rowLimit, cap)`，即**单次最多 5000 行**；没有 `offset`，没有翻页 ⇒ 只读**最早插入的 5000 条挂载**；
2. 排序是 `course_knowledge_questions.rowid ASC` ⇒ 被截掉的是**后插入的挂载**；
3. 题库列表是 `question_bank ORDER BY rowid DESC LIMIT 10000` ⇒ 列表**最前面**恰好是**最新**的题，而它们的挂载正好在被截掉的那一批里。

⇒ 用户看到的第一屏（乃至列表大部分）全是「未挂载」。**ISSUE-148 只治了第一层**（全局护栏 200），路径自身的 5000 上限当时没暴露（那时现场库挂载 3720 行 < 5000）；库长到 12913 行后就复发了。

### 2.3 现场量化（同一库、同一函数口径）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 列表返回题数（最新 10000） | 10000 | 10000 |
| **其中带 contexts 的题** | **2086** | **9999** |
| 挂载反查读到的行 | 5000（截断） | 12913（全量，3 页） |
| 题库本身已挂载的题（去重） | 12823 | 12823 |

> 剩 1 道题无挂载是**真实的游离题**（题干「背诵本章原文…」，无 `courseId`，按设计不挂课），与 ISSUE-148 §四 记的是同一条。

---

## 三、修复

**`server/src/db/assess-content.ts`**

- 新增两个常量：
  - `BANK_CTX_PAGE = 5000`——挂载反查**单页**行数（与路径 `rowLimit` 同量级）；
  - `BANK_CTX_SCAN_MAX = 200000`——分页总行数硬上限（防病态大库打满内存；触顶时 `console.warn` 留痕，绝不静默）。
- `listAllBankQuestions()` 的 `ctx` 段改为 **按 `course_knowledge_questions.rowid` 稳定翻页**拉全量：
  每页 `limit=page, offset=i*page, ignoreGlobalCap=true`，取回行数 < 一页即停。
  这样"全量"由**循环**保证，不再依赖某个魔数够大。

---

## 四、验证

### 4.1 回归测试（新增）
`test/issue184-question-bank-mounts.test.ts`（2 例）：造 `BANK_CTX_PAGE + 200` 条挂载，
断言 ① 每道题都能拿到 contexts；② 列表首屏（＝最后插入的题）带挂载与课程/知识点 uuid。
**非假绿**：把翻页临时改回"单次查询"，两例全红（`只有 5000/5200 道题带挂载`）。

### 4.2 真实库探针
对现场库用修复后的分页口径查询：`12823` 个挂载 question id 全部读到、最新 10000 题中 `9999` 题带挂载（修复前 2086）。

### 4.3 相邻回归
`issue132-question-bank` 7 例、`issue121-exam-name` 4 例、`issue144-parent-skills` 45 例、`issue185` 5 例全绿；`server tsc --noEmit` 无新增错误（仅既有 6 处类型债）。

---

## 五、影响面与部署

- **纯服务端读取逻辑**：客户端（Electron / Web 面板）零改动，重新构建部署 `server.cjs` 后刷新即生效。
- 大库性能：挂载 12913 行 → 3 次分页查询，实测毫秒级；`BANK_CTX_SCAN_MAX` 之上的库会在日志里留下警告（届时再考虑"按题 id 批量反查"替代全表拉取）。

## 六、遗留（不阻塞）
- 题库列表本身有 `BANK_LIST_LIMIT=10000` 上限（ISSUE-074 口径）；挂载反查成本随后者走，两者需要一起看。
- 反查目前是"拉全部挂载再按题 id 建 map"，若某家长库挂载量级上十万，建议改为**按列表里的题 id 分批 `IN` 查询**（注册表路径需支持多值过滤）。

## 七、部署与线上验证（2026-10-16 21:18，server 0.5.38）
- 提交 `0b922af`（含 ISSUE-185/186 同批）→ 已 push github + gitee；部署 201（备份 `server.cjs.bak-20261016-211843` + 数据 `deploy-0.5.38-20261016-211843` 22M）→ version `0.5.38`、health ok、journal error 0。
- **线上实测（自签家长 JWT 直连 127.0.0.1:8788）**：`GET /api/v1/assess/questions/list` → 返回 **10000 题，带挂载 9997、未挂载 3**（耗时 478ms）。
  - 对照：修复前该家长库（挂载 12913 行 / max rowid 13280）只读得到最早 5000 条挂载 ⇒ 列表首屏（最新题）整片"未挂载"；ISSUE-148 当时的线上数字是 `MOUNTED=3495 / UNMOUNTED=403`（那是 3498 条挂载、未触及 5000 上限时）。
  - 剩 3 条未挂载＝真实游离题（无 `courseId`），与 ISSUE-148 §四 同类。

# [ISSUE-148] UI 题库题目「全部未挂载知识点」——`READ_MAX_LIMIT=200` 误伤内部全量反查

- **类型**：bug（读取路径截断，UI 显示错误；数据本身未丢失）
- **优先级**：**高**（表现为"论语题目之前挂在的、现在全没了"，是用户最先报告的症状）
- **状态**：✅ **已修复 + 已部署 201（0.5.10 之上的 hotfix，2026-09-24 18:02）**；本地 8788 服务已用修复版重启
- **记录时间**：2026-09-24
- **标签**：`db-channel` `buildPathQuery` `READ_MAX_LIMIT` `题库挂载` `F10-b` `通用实体API` `UI显示`
- **关联**：ISSUE-074 / ISSUE-132（`BANK_LIST_LIMIT=10000` 被 F10-b 改回 2000，是**另一个** LIMIT，已修）、ISSUE-144（通用数据通道整组退场，但 `buildPathQuery`/`registeredPath` 机制被保留为内部 SQL 构造层）

---

## 一、症状（用户原话）

> 「为什么现在本地环境里的题库的题目都没有挂在知识点？这不对，论语的题目之前是挂在了的。」

表现为：家长端题库面板（`QuestionBankPanel.tsx`）里几乎所有题都显示「未挂载」，包括后插入的《论语》各章题目。

---

## 二、排查结论（根因）

### 2.1 数据没丢，是读路径被截断
- 直连库查 `course_knowledge_questions`：本地 86a84278 库 **3720 行全挂**（论语题全在）。
- 但打接口 `GET /api/v1/assess/questions/list` 却只返回 `已挂=200 未挂=3521`。
- ⇒ 数据完好，是**运行中的读取路径把上下文截断到了约 200 行**。

### 2.2 根因：`buildPathQuery` 里的 `READ_MAX_LIMIT=200`
- 09-18 通用实体 API 重构（F10-b）新增了 `buildPathQuery` + 注册表 `registeredPath`，把 JOIN 收编进注册表（含 `bank_question_contexts` 路径）。
- 该机制**顺手继承了给 agent 随手读设的全局安全上限** `READ_MAX_LIMIT = 200`（`server/src/agent/db-channel.ts`）。
- 旧代码第 765 行：
  ```js
  const limit = Math.max(1, Math.min(Number(req.limit) || 20, path.rowLimit, READ_MAX_LIMIT));
  ```
  把题库挂载反查（`req.limit=5000`、`path.rowLimit=5000`）压成 `min(5000,5000,200)=200`。
- 挂载行按 `course_knowledge_questions.rowid`（插入顺序）排序，**后插入的《论语》题几乎全落在这 200 行之外** → `contexts` 全空 → 前端渲染成「未挂载」。
- 注：`readPath`（agent 随手读的**原语**）里的 `READ_MAX_LIMIT` 是它**该在的位置**，本轮修复**未动**它。

### 2.3 为什么和 ISSUE-074/132 不是一回事
- ISSUE-074/132 修的是 `BANK_LIST_LIMIT`（题库**列表**条数，在 `assess-content.ts`，值 10000，曾被 F10-b 改回 2000）。
- 本 issue 修的是 `READ_MAX_LIMIT`（在 `db-channel.ts`，值 200，**agent 随手读护栏**误套到内部全量反查）。
- 两个 LIMIT 位置、语义、修复点都不同，互不覆盖。

---

## 三、修复（2 个源文件）

1. **`server/src/agent/db-channel.ts`**
   - `PathReadRequest` 接口新增 `ignoreGlobalCap?: boolean;`（注释：内部全量读取如题库反查用，跳过全局 READ_MAX_LIMIT，仅受路径自身 rowLimit 约束）。
   - `buildPathQuery` 改为：
     ```js
     const cap = req.ignoreGlobalCap ? Number.MAX_SAFE_INTEGER : READ_MAX_LIMIT;
     const limit = Math.max(1, Math.min(Number(req.limit) || 20, path.rowLimit, cap));
     ```

2. **`server/src/db/assess-content.ts`**
   - `listAllBankQuestions` 内 `buildPathQuery(registeredPath("bank_question_contexts"), { …, ignoreGlobalCap: true })`（仅这一处内部全量读放开）。

---

## 四、验证（同一台本地 8788，家长库 86a84278）

| 指标 | 修复前（旧 bundle） | 修复后（重建并重启） |
|---|---|---|
| 总题数 | 3721 | 3721 |
| 已挂知识点 | **200** | **3720** |
| 未挂 | **3521** | **1** |
| 论语题 已挂/未挂 | 4 / 105 | **109 / 0** |

唯一剩 1 条「未挂载」=`f20bb531…`（题干「背诵本章原文…」），**无 `courseId`**，属游离题、按设计无法挂知识点，是数据本身情况，非 bug。

---

## 五、201 服务器现状与处理

### 5.1 201 有两件独立的事
1. **相同的 200 截断 bug**：201 当时跑的 0.5.10（15:53 部署）**未含本次修复** → UI 同样误判。
2. **403 道真实未挂题（数据缺口）**：与本地不同，201 的 86a84278 库从未跑过 `restore-question-bank.mjs` 补挂，故 `question_bank=3898`、`course_knowledge_questions=3498`、**真实未挂载=403（10.3%）**。这批是《论语》各章"背诵本章原文/当小老师讲解某句"等章节综合题，`created_at` 全是 2026-09-11 06:40:52，明显批量导入漏挂。

### 5.2 旧 `course_category_questions` 表
201 上该退役旧表**还在但 0 行**（空壳残留，无害），不是 403 的成因。

### 5.3 用户决策：只部署代码修复（不补 403 数据）
- 本地重建含修复的 `dist/server.cjs`（18:00，含 `ignoreGlobalCap`），scp 到 201。
- `sudo bash /tmp/deploy201.sh`：停服 → 备份（`server.cjs.bak-20260924-180155` + 数据 `deploy-fixREADMAX-20260924-180155`）→ 换包 → 起服。
- **验证**（自签 JWT 直连 127.0.0.1:8788）：`TOTAL_RETURNED=3898`（完整，不再截到 200）、`MOUNTED=3495`、`UNMOUNTED=403`（真实状态）、journal `ERR_COUNT=0`、active。

### 5.4 403 题不能直接照搬本地挂载（关键坑）
本想从本地 86a84278（几乎 100% 挂了）抽挂载关系补到 201，实测发现：
- 375/403 未挂题在本地既存在又有正确挂载，但那些挂载引用的 `course_id`/`knowledge_point_id` 与 201 的 `courses`/`knowledge_points` **UUID 完全不同** → 直接插入会 **375/375 全悬空引用**。
- ⇒ 补挂必须按**稳定键（课程标题/章节）做 ID 映射**后再插，且插入前校验 0 悬空引用。此步**未做**，留待后续（需用户拍板范围）。

---

## 六、落盘改动（git 工作树）
- 修改 2 文件：`server/src/agent/db-channel.ts`、`server/src/db/assess-content.ts`。
- 当前**未提交/未推送**（用户此前约定：未经同意不部署到 201 已破例，但未提提交）。
- 本机 Electron 桌面端要看效果需 `npm run dist:win` 重打（bundle 不直接含源码修复）。
- 201 bundle 版本号仍是 `0.5.10`（仅修 bug，未改版本常量），功能已生效。

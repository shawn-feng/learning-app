# ISSUE-104：考核计划 scope.courses 格式变更未跟上下游 —— 家长端「自定义考核」白屏 + 家长 agent 看不到课程细节

- **类型**：bug（回归，一个根因两个症状）
- **优先级**：高（生产白屏；家长端页面不可用）
- **记录时间**：2026-09-15
- **状态**：✅ 已解决并已上线（2026-09-15，代码已改 + 构建通过 + 回归/冒烟用例通过；**服务端 0.4.3 已于 13:33 部署到 201**，老客户端连上即不再白屏）

## 现象（用户报告）
1. 客户端连 **201 服务端**时，家长界面 → 考核管理 → **自定义考核**页签**白屏**；客户端连**本地 dev 服务端**却正常。
2. 家长 agent 查询考核计划时，**拿不到考核的课程信息及相关细节**。

## 根因（一个）
`exam_plans.scope_json.courses` 的**形状在 2026-09-14 变了**，但两个消费方没跟上：

| 时间 | 形状 | 出处 |
|---|---|---|
| 旧 | `["课程名", ...]` | 家长端 UI 早期自建排期（`POST /exam/schedules` 传 `{topics, courses: string[], note}`） |
| 新（2026-09-14 定案） | `[{title, kps:[{name,count}]}, ...]` | 「**计划生成时即完整约定出题参数**」（`assess-selection.ts` 的 `buildPlanSpecEntries`；agent 工具与 REST 创建都走它） |

服务端**出题链路**两种格式都认（`routes/exam.ts` 的 `isNewFormat` 判断 + 懒迁移展开），所以考核本身没坏；坏的是**展示/汇报两处**：

### 症状 1：白屏（客户端）
`src/components/ExamAdminPanel.tsx` 把 `scope.courses` 的数组项**直接当 React 子节点渲染**：
```tsx
const courses = Array.isArray(sc.courses) ? sc.courses : [];
...
{courses.map((c, i) => (<div key={c}>{i + 1}. {c}</div>))}   // ← c 现在是对象
```
React 抛 `Objects are not valid as a React child (found: object with keys {title, kps})` → 无错误边界 → **整棵渲染树卸载 → 白屏**。
另有 `key={c}`（对象做 key）同源。

**为什么本地 dev 正常**：201 上的自定义考核是**新格式**（agent 建的，`[{title,kps}]`）；本地 dev 没有自定义考核数据 → 走 `groups.length === 0` 的空态分支，根本不渲染 courses。

### 症状 2：agent 看不到课程（服务端）
`server/src/agent/parent-plans.ts` 的 `parent_exam_plan_list`：
```ts
const sc = JSON.parse(r.scope_json || "{}");
courses = Array.isArray(sc.courses) ? sc.courses.map((x) => String(x)).join("、") : "";
```
`String({title:"论语学而篇第八章",kps:[...]})` → **`"[object Object]"`**：课程名、每课考哪些知识点、各几题全部丢失；`scope.note` / `scope.methodSpec`（只考/不考/背诵通过线）也从未展示。

## 现场证据（201，只读探测）
```
GET /exam/schedules/1f050a7f-…  → 200
{"generated":0,"schedules":[{…,"title":"自定义考核",
  "scope":{"courses":[{"title":"论语学而篇第八章",
            "kps":[{"name":"字词","count":1},{"name":"道理","count":1},{"name":"句意白话","count":1}]}],
  "note":"论语考核：学而篇第八章"},"pending":true}]}
```
孩子库 `exam_plans` 真实行（珊珊）：3 条 cancelled + 1 条 pending，**全部**是 `scope_json={"courses":[{"title":…,"kps":[…]}],"note":…}` 新格式；闻闻 0 条。
（`exam_plan_courses` 两孩子均 0 行——没有已判分的场次，故本轮不涉及逐题明细。）

## 修复（两侧都改，互为保险）

### 服务端
1. **`server/src/assess-selection.ts` 新增归一化函数**（出题约定的真源文件，两格式都认、非法项丢弃、不抛错）：
   - `parsePlanCourses(raw): PlanCourseSpec[]` —— `["课程名"]` 与 `[{title,kps}]` 统一成 `{title, kps}`；
   - `formatPlanCourses(specs): string` —— `课程A（背诵×1、句意白话×2）；课程B`。
2. **`parent_exam_plan_list` 改为多行结构化输出**：每行计划带「考核内容：课程（知识点×题数）」「主题」「考核方法：只考…/不考…/背诵通过线…」「说明」；固定档（kind=fixed）明确提示「课程由本周期必学课程在开考时确定，不固化在计划里」，避免被当成数据缺失。工具描述同步说明。
3. **`GET /exam/schedules/:childId` 响应兼容化**：`scope.courses` 归一成**课程名数组**（老客户端安全），出题约定另放 `scope.courseSpecs`（`[{title,kps}]`，供新客户端展示细节）。这是把 09-14 「响应形状与旧排期列表保持一致、渲染层零改动」的原意补回来。

### 客户端
4. **新增 `src/lib/plan-scope.ts`**：`normalizePlanCourses` / `normalizePlanTopics` / `formatCourseSpec`（渲染前必须过它）。
5. **新增 `src/components/PlanCourseList.tsx`**：把「要考核的课程」抽成独立组件（渲染前归一化），`ExamAdminPanel` 改用它；优先读 `scope.courseSpecs`，回退 `scope.courses`；课程行显示「课程名（知识点×题数）」。
6. **新增 `test/plan-scope.test.ts`（9 条用例）**：两格式渲染、脏数据不崩、空态、以及**机理对照**——把同一个对象数组直接当子节点渲染确实会抛错（证明这类数据必然白屏，回归会被抓）。

## 为什么两侧都改
- 只改客户端：线上老客户端（0.1.15 等）仍白屏，要等客户端发版才修好。
- 只改服务端：客户端仍是"只要后端给对象就崩"的脆弱写法，下次形状再变照旧白屏。
- 两侧都改后：**服务端一部署，所有现存客户端立刻不再白屏**；客户端更新后还能多显示「每课考哪些知识点各几题」。

## 验证
- `server`：`tsc --noEmit` 0 错；`node scripts/build.mjs` 成功（v0.4.2，`courseSpecs`/`parsePlanCourses` 已在产物中）。
- 客户端：`npm run build`（electron-vite）通过；`out/renderer/assets/index-CRvtav-H.js` 含新逻辑。
- 单测：`npx vitest run test/plan-scope.test.ts` **9/9 通过**。
- 全量单测 257 条中 17 条既有失败（`Cannot find module '/electron/lib/assessment'` 等本环境路径解析问题），与本改动无关（无一条测试引用本次触碰的文件）。
- 注：仓库根 `npx tsc --noEmit`（TS 7.0.2）报 `Cannot find global type 'Object'` 等 lib 缺失错误，属**本环境既有问题**，非本次改动引入。

## 部署（2026-09-15 13:33，用户明确同意后执行）
- 版本 0.4.2 → **0.4.3** → 部署 201：停机约 2 秒；`version`=0.4.3、health ok、`ERR_COUNT=0`；包内 `grep -o` 命中 `courseSpecs`×4 / `parsePlanCourses`×3。
- 备份：bundle `server.cjs.bak-20260915-1333`；数据 `data/backups/deploy-0.4.3-20260915-1333/`（36M）。回滚见 `DEPLOY-201-server-0.4.1-迁移方案-2026-09-15.md` §11。
- **接口级验证（真实数据）**：`GET /exam/schedules/:childId` 返回 `scope.courses = ["论语学而篇第八章"]`（字符串数组 ✅）+ `scope.courseSpecs = [{title,kps:[字词×1,道理×1,句意白话×1]}]`（✅）→ **老客户端连 0.4.3 即不再白屏**。
- **agent 侧冒烟**（临时孩子库三种 scope 形态）**11/11 PASS**：新格式输出 `论语学而篇第八章（字词×1、道理×2）；论语为政篇第一章（背诵×1）`、旧格式正常、固定档明示「按本周期必学课程自动确定」、考核方法/说明/主题/已完成分数齐全、**输出无 `[object Object]`**。

## 待办 / 后续
- 客户端如需见到「每课知识点×题数」明细，需重新构建并发布客户端（0.1.16）——本地代码已就绪（`src/lib/plan-scope.ts` + `src/components/PlanCourseList.tsx`），构建已通过。
- 逐题得分明细（`exam_plan_courses` / `exam_attempts`）目前家长 agent 仍不可读——本轮未涉及（201 上该表 0 行），若需要可在 `parent_exam_plan_list` 之外再加 detail 工具。

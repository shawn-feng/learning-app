# [ISSUE-092] 自定义考核的「本次方法覆盖」用户不可达（读取侧已实现，缺排期级写入入口）

- **类型**：功能缺口（与说明书 §3.5.1 不符）
- **优先级**：P1
- **状态**：✅ 已解决（2026-09-14，`parent_exam_plan_create` 增加可选 `methodSpec`（require/exclude/recitePass），写入 `exam_schedules.scope` 由 `GET /exam/config` 传给 `attachStructuredQuestions` 生效）
- **记录时间**：2026-09-13
- **标签**：`考核` `methodSpec` `assess-selection` `parent_exam_plan_create`

---

## 一、说明书要求

`学习伙伴-用户使用说明书.md` §3.5.1「排考核」：

- 「**自定义档**：通过家长 AI 对话指定**精确课程名**，并**可在本次覆盖考核方法**（如「本次只考背诵」「本次不考选择题」），优先级最高。」
- 「对每门课，可进一步**选定要考核的「知识点」**——只考指定的知识点，不考整门课」；「可指定本次考核方法（题型构成、背诵通过线等）」。

## 二、代码现状：读取侧已实现，写入侧缺失

**已实现（读取/生效链路）**
- `server/src/assess-selection.ts` 导出 `attachStructuredQuestions(db, childId, courses, override)`，其中 `override: MethodOverride = { require?: {知识点uuid或名:题数}, exclude?: [名], recitePass?: number }`；
- `resolveOverride()` 把 require/exclude 按**该课知识点（uuid 或名称）**解析成知识点 id；`require` 非空→只考命中项、`exclude`→过滤；`recitePass` 覆盖背诵通过线（默认 90）；解析全失败则视为未覆盖、回退主题级方法；
- 优先级：**排期级 override > 主题级 `topics.method_spec`（`perChild[childId] ?? default`）**；
- 调用点：`routes/exam.ts` 的 `GET /exam/config/:childId`，自定义档时读 `scope.methodSpec` 传入（`structuredCourses(scopeCourses, scope.methodSpec)`）；
- **主题级**方法可由家长端写入：`POST /api/v1/assess/method-spec` → `saveMethodSpec` → `topics.method_spec`（结构 `{ perChild: { <childId>: { require, exclude, rules:{recitePass} } }, default }`）。

**缺失（写入入口）**
- 家长 agent 工具 `parent_exam_plan_create` 的 `scope` 只写 `{ topics: [], courses: [...], note }` —— **无 `methodSpec` 参数** → 家长说"这次只考背诵"时 AI 无法表达，只能整体按主题级方法考。
- REST `POST /api/v1/exam/schedules` 虽把 body 的 `scope` **原样写入**（因此理论上可带 `methodSpec`），但**没有任何 UI/agent 调用方**（客户端排期走 agent 对话）。

→ 结论：**能力（抽题覆盖）已具备且被验证可用，但用户路径不通**——产品承诺"本次覆盖方法/只考指定知识点"当前不可达。

## 三、影响范围

- **家长**：无法为某一次考核单独指定"只考背诵 / 不考选择题 / 只考某几个知识点 / 提高背诵通过线"；只能改主题级方法（影响该主题所有后续考核）。
- **孩子**：考什么完全由主题级方法决定；临时性要求（如"今晚只考背诵"）落不了地。
- **文档一致性**：技术实现文档 §6.1 已如实标注（读取侧实现 / 写入侧缺失），§17 #4 同步。

## 四、修复方向（待实施）

1. **最小改动：给 `parent_exam_plan_create` 加可选参数 `methodSpec`**，透传进 `scope`：
   - `require`（知识点名/ uuid → 题数）、`exclude`（知识点名数组）、`recitePass`（背诵通过线）；
   - prompt 里补一句使用说明（"家长说'本次只考背诵'时用 exclude/require 表达；不确定知识点名先查"）。
2. **可选：家长端排期面板支持编辑 `scope.methodSpec`**（复用 `GET /assess/topics/:topic/knowledge-points` 列知识点供选择）。
3. **验证要点**：排列一次带 `methodSpec.exclude=['选择题相关知识点']` 的考核 → `GET /exam/config/:childId` 返回的 `courses[].questions` 不含被排除知识点、`recitePass` 生效；不传 `methodSpec` 时回退主题级方法（回归）。
4. **顺带**：`scope.methodSpec` 的键建议统一用**知识点名**（家长/agent 可读），uuid 作为兼容（`resolveOverride` 两者都支持）。

## 五、关联

- 说明书 §3.5.1（自定义档 + 本次覆盖方法 + 选定知识点）。
- 技术实现文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §6.1（prompt 与结构化直出）、§6.4（`parent_exam_plan_create` / `GET /exam/config` / `/assess/method-spec` 行）、§17 #4。
- `ISSUE-067`（考核内容结构化 / method_spec 知识点制）、`ISSUE-054`（选课 LLM 两段式废弃）、`ISSUE-091`（孩子自建计划，同为"能力/数据就绪但用户路径缺失"）。
- 代码真源：`server/src/assess-selection.ts`、`server/src/routes/exam.ts`（config 下发 / `/assess/method-spec`）、`server/src/agent/parent-plans.ts`（`parent_exam_plan_create`）、`server/src/db/assess-content.ts`（`getMethodSpec`/`saveMethodSpec`）。

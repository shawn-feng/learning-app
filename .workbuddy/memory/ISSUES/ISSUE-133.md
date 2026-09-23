# ISSUE-133：数据通道工具参数被「整串 JSON 序列化」导致校验硬失败

- **类型**：bug（工具契约 / 与模型交互层）
- **优先级**：高（`parent_db_write` 的 update/insert 主路径整条不可用，且报错文案对模型无自愈价值）
- **记录时间**：2026-09-22
- **状态**：✅ 已修复（Windows 本地：tsc 0 错、测试 14/14 + 相邻回归 75/75、bundle 已含修复）；**未部署 201**

## 1. 用户现场

```
Validation failed for tool "parent_db_write":
- rows: must be array
- rows: must be object
- rows: must match a schema in anyOf
Received arguments:
{ "child": "珊珊", "table": "study_plans", "op": "update",
  "rows": "[{\"status\":\"done\",\"result\":\"done\"}]",
  "where": { "id": "ba4180ab" } }
```

调用方（模型）本意是传数组 `[{"status":"done","result":"done"}]`，但**到达工具的实参里 `rows` 是字符串**
（`Received arguments` 里能直接看到引号包裹）；三条报错对应 schema 的 `anyOf: [array, object]` 全不匹配。

## 2. 根因（两层，均已实证）

### ① 模型侧：anyOf 联合参数被整体序列化成字符串

`rows` 的 schema 是 `Type.Union([Type.Array(Record), Type.Record])` → `anyOf` 两个分支。
模型对「数组也可以、对象也可以」的属性偶发做 JSON 序列化（现场即此）。

补充证据：**不是运行时序列化**。`@earendil-works/pi-ai/dist/api/openai-completions.js` 里
`block.arguments = parseStreamingJson(block.partialArgs)`（Anthropic 侧直接给已解析对象）——整个
arguments 只 parse 一次，**没有任何代码路径把嵌套数组再 stringify**。

### ② SDK 侧：校验只做标量转换，不做 string→结构 解析

`@earendil-works/pi-ai/dist/utils/validation.js` 的 `validateToolArguments`：
`Value.Convert(schema, args)` → `Compile(schema).Check(args)`。TypeBox 的 `Value.Convert` 只处理
`"20"→20`、`"true"→true` 这类**标量**转换，字符串永远变不回对象/数组 → `Check` 失败 →
**校验发生在 `execute` 之前**，工具根本没跑，模型只收到一句 schema 报错，无法自愈重试。

本地复现（typebox 1.3.12）：

| 传入 `rows` | `Value.Convert` 后 | Check |
|---|---|---|
| `[{...}]`（真数组） | 数组 | ✅ |
| `{...}`（真对象） | 对象 | ✅ |
| `"[{...}]"`（字符串） | **仍是字符串** | ❌ 三条报错与现场一致 |
| `where: '{"id":"x"}'` | **仍是字符串** | ❌ `where: must be object` |

> `where` / `columns` 同源：`where` 报 `must be object`，`columns`（数组）同理。

## 3. 修复（与 ISSUE-122 同思路：纯 schema 修复不够，执行器兜底才是治本）

### ① schema 层放行 string 分支 —— `server/src/agent/tool-shapes.ts`（新增）

`WriteRowsParam` / `JsonObjectParam` / `JsonStringArrayParam`：在 anyOf 里追加 `Type.String()`，
描述统一加「请**直接传结构**，不要传 JSON 序列化后的字符串」。

### ② 执行器层统一 parse —— `server/src/agent/db-channel.ts`

新增 `parseJsonArg(raw, label)`（字符串 → `JSON.parse`，失败回可读中文原因）、
`coerceObjectArg(raw, label)`、`coerceColumnsArg(raw)`，并接入：

- `normalizeWriteRows`（insert/update 的 rows；tier2Write 共用）
- `executeWrite`（where / rows / 审计里的 where）
- `executeRead`（where / columns）
- `buildPathQuery`（路径读的 where / columns，任何调用方都受益；失败抛出→`executePathRead` catch 成可读文案）
- `tier2Write` / `tier2Read`（Tier 2 灵活实体）

类型同步放宽：`WriteRequest.rows/where`、`ReadRequest.columns/where`、`PathReadRequest.columns/where`、
`Tier2WriteRequest.rows/where` 改 `unknown`（归一职责收在执行器内）。

### ③ 工具层接线

- `parent-tools.ts`：`parent_db_read` 的 columns/where、`parent_db_write` 的 rows/where 换用新构造器；
  `execute` 形参类型加 `| string`；重嵌入取主键那段改用 `parseJsonArg`（否则字符串形态取不到主键、**静默跳过重嵌入**）。
- `child-db-tools.ts`：`child_db_read` / `child_db_write` 同款。

## 4. 验证

- **新回归** `test/issue133-json-string-args.test.ts`（14 用例，全绿）：用**真实工具对象**
  （`createDataAgentTools`）+ SDK 同款校验步骤（`Value.Convert` + `Compile.Check`）复刻报错链路，
  再真跑写库。覆盖：用户原始调用（字符串 rows → 计划被改成 done/done）、rows+where 双字符串化、
  字符串化 insert 行数组、非法 JSON 字符串（校验过 + 执行器回可读原因 + 数据未变）、
  真数组/真对象零回归（ISSUE-122 兼容保持）、列校验不失守、读侧 where+columns 字符串化、
  空结果自愈、Tier 2 三操作、孩子侧读规格。
- **相邻回归**：`db-channel` / `db-channel-child` / `data-channel-v2` / `issue122` / `issue128` 共 61 用例全绿。
- **类型/构建**：`server` `tsc --noEmit` 0 错；`scripts/build.mjs` 成功，`dist/server.cjs` 已含新符号
  （`coerceObjectArg` / `parseJsonArg` / `WriteRowsParam` …；中文文案在 bundle 中为 `\uXXXX` 转义，与既有字符串一致）。

## 5. 第二轮证据：**模型确定性差异**，不是框架（2026-09-23）

### 5.1 生产 201 的现场（决定性）

拉 201 `/opt/learning-server/data/agent-sessions/<parentId>/parent/` 最近的 12 个会话（只读）逐行核对：

| 会话（起始时间） | 模型 | `parent_db_write` 的 `rows` 形态 | 校验失败报错次数 |
|---|---|---|---|
| 09-20 07:11 / 09-21 00:59 | **deepseek-v4-flash-0731** | **对象 14 次 + 数组 6 次，字符串 0** | 0 |
| 09-21 09:56 | **mimo-v2.5** | **字符串 6，对象 0，数组 0** | 7 |
| **09-22 07:53（本次故障会话）** | **mimo-v2.5** | **字符串 20，对象 0，数组 0** | **22** |

**全 12 个会话里，被写成 JSON 字符串的参数只有 `parent_db_write.rows` 一个，26 次全部来自 `mimo-v2.5`；**
同一工具、同一 schema，`deepseek-v4-flash-0731` 的 20 次调用（对象/数组混用）**零字符串化**。
⇒ 这是**模型对 `anyOf` 联合参数的确定性行为差异**，不是框架有 bug。

### 5.2 故障会话的因果链（`2026-09-22T07-53-57-…jsonl`）

```
行 4  用户：记录一下作业，珊珊今天的作业：数学…语文…
行 5  模型 → parent_list_children ✓
行 7  模型 → parent_db_write[daily_entries/insert] rows=string("{\"date\":…}")   ← 本会话首次调用即字符串
行 8  ← Validation failed：rows: must be array / must be object / must match a schema in anyOf
行 9  模型 → 重试 rows=string("[{…}]")     ← 改传数组，但**仍带引号**
行 13 模型 → 重试 rows=string("[{…}]")
行 15 模型 → 重试 rows=string("{…}")       ← 又改回对象，还是带引号
行 17 模型 → 重试 rows=string("[{…}]")
行 19 放弃，转去问用户
…    后续 study_plans 改类同：where={"id":"ba4180ab"} 一直是**对象** ✓，rows 始终是**字符串** ✗
```

- **第 7 行就已经是字符串**（此前无任何校验失败）⇒ 不是被报错"教坏"的，是模型原生形态；
- 模型在对象/数组之间**来回切换了 5 次**（它读懂了描述「行数组（单行也可传对象）」并试图两种都试），
  但**每次都被引号包着**——这正是用户看到「对象格式也变成了字符串」的真相：它**想**传对象，
  却永远写成字符串；模型看不到自己的原始 token，所以它「我传的是对象」的自述不可信；
- 失败报文会把（字符串形态的）实参**原样回显**进上下文，模型无从脱出 → 同一会话连败 22 次。

### 5.3 全量形状分布（本机 20 会话 + 201 12 会话）

| 参数形状 | 例子 | 字符串化 |
|---|---|---|
| **`anyOf` 联合** | `parent_db_write.rows` | **mimo 26/26（100%）**；deepseek 0/20 |
| 数组套对象，深且长 | `parent_upsert_course_content.items` | 12/69（17%，mimo） |
| 扁平 map | `parent_db_read.where` / `parent_db_write.where` | 0（两模型皆 0） |
| 标量数组 | `parent_exam_plan_create.courses` | 0/37 |
| 标量 | `topic` / `title` | 0 |

⇒ 精确结论：**`mimo-v2.5` 无法表达 `anyOf`——凡是联合类型属性一律退化成 JSON 字符串；深层长嵌套数组约 17%；扁平/标量不受影响。**
`deepseek-v4-flash-0731` 对同一 schema 无此问题。（该家长 `app_settings.defaultModel` 现为
`mimo-tokenplan/mimo-v2.5`，09-21 09:56 之前的会话用的是 `deepseek-v4-flash-0731`。）

### 5.4 链路复核（继续排除框架）

`api/openai-completions.js:1099` 把 `tool.parameters` **原样透传** provider；工具参数只经
`parseStreamingJson(partialArgs)` 解析一次，`utils/json-parse.js` 是忠实解析器（`JSON.parse` →
字符串字面量修复 → `partial-json` 兜底），**无任何嵌套 stringify 路径**；`utils/typebox-helpers.js`
只是 enum 辅助，不改 anyOf。

### 5.5 因此把同一修复扩到实测被打穿 17% 的 `parent_upsert_course_content.items`

- `tool-shapes.ts` 新增 `JsonArrayParam(item, desc)`（任意元素类型的数组 + string 分支）；
- `db-channel.ts` 新增 `coerceArrayArg(raw, label)`（parse 回数组，非法回可读原因）；
- `parent-upsert_course_content`：schema 换 `JsonArrayParam`，执行器开头 `coerceArrayArg` 取代原
  `Array.isArray(params.items) ? ... : []`（后者对字符串会得到空数组，报出误导性的「items 不能为空」）。
- 回归用例扩到 17 条（新增：items 字符串化 → 校验过 + 知识点/题/挂载真落库；真数组零回归；非法 JSON → 可读原因）。

## 6. 未覆盖（同源潜在风险，见技术实现文档 §17 #19）

`parent_plan_create` / `child_plan_create` 的 `courses`、`parent_sync_courses_to_child` 的 `titles`、
考核计划 `require`/`exclude`、`define_namespace` 的 `fields`、计划 `days` 等**仍是裸数组/Record 参数**：
一旦被字符串化仍会在校验层硬失败（按实测分布，扁平/短参数暂未出现，风险低于 `items`/`rows`）。
**候选治本方案（ISSUE-134 提案，未实施）**：自建 `defineTool` 包装器（14 个工具文件改 import），
对任意 TypeBox schema 递归加 string 分支 + 在 execute 入口递归 `JSON.parse` 回结构
（只对 schema 期望 array/object 的位置生效，字符串字段不受影响）——一处覆盖全部工具与未来新工具。

## 7. 部署状态与临时绕过

**已部署 201（server 0.5.5，2026-09-23 09:05）**——与 ISSUE-134 同一 bundle 上线（该版本同时带上
ISSUE-132 题库接口与 ISSUE-129 漏入 git 的两个文件）。部署细节与验证口径见 `ISSUE-134.md` §9。
回滚：`cp -a /opt/learning-server/server.cjs.bak-20260923-0905 /opt/learning-server/server.cjs && systemctl restart learning-server`。

> 诊断手法已沉淀进技能 `pi-local-server-agent-diagnose` §8（含「用 jsonl 量化模型参数形状」与
> 「按模型分组对比」的探针配方）。


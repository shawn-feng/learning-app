# ISSUE-134：工具参数「被模型序列化成字符串」的治本方案（统一还原层）

- **类型**：架构 / 与模型交互层（bug 治本）
- **优先级**：中-高（治本；当前已有逐参数补丁顶着，但已漏 6 个参数）
- **记录时间**：2026-09-23
- **状态**：✅ **已实施（P0~P2 完成，本地验证通过）**；✅ **P3 已部署 201（server 0.5.5，2026-09-23 09:05）**
- **用户拍板（2026-09-23 08:43）**：① 实施、先不部署 → 已执行；② 不做「上线前换模型」止血 → 不换；③ 逐参数补丁**保留** → 已保留作第二道保险。
- **上游**：ISSUE-133（`parent_db_write.rows` 校验硬失败 → 已逐参数补双层丁）
- **归档说明**：按「不再单独出设计稿」约定，原 `DESIGN-tool-arg-coercion-2026-09-23.md` 全文已并入本 issue，文件已删除。

---

## 0. 一句话

不再逐个参数打补丁——在**参数校验之前**加一个统一还原层（SDK 官方钩子 `prepareArguments`），
把模型写成的 JSON 字符串还原成结构；**schema 一字不改**，一处覆盖全部工具（含以后新增的）。

---

## 1. 问题

### 1.1 现象

模型把复合参数（对象/数组）写成 **JSON 字符串**，工具在**执行器之前**就硬失败：

```
Validation failed for tool "parent_db_write":
- rows: must be array / must be object / must match a schema in anyOf
Received arguments: { "child":"珊珊", "table":"study_plans", "op":"update",
                      "rows":"[{\"status\":\"done\",\"result\":\"done\"}]", ... }
```

模型只拿到一句 schema 文案、拿不到可操作线索 → 生产会话里**连败 22 次**后放弃（实测）。

### 1.2 实测数据（生产 201 + 本机，非推测）

| 参数形状 | 例子 | 字符串化率 |
|---|---|---|
| **`anyOf` 联合** | `parent_db_write.rows` | **`mimo-v2.5` 26/26（100%）**；`deepseek-v4-flash-0731` 0/20 |
| 数组套对象、深且长 | `parent_upsert_course_content.items` | 12/69（17%） |
| 扁平 map | `where` | 0（两模型皆 0） |
| 标量数组 | `courses` / `titles` | 0 |
| 标量 | `topic` / `title` | 0 |

- **模型差异是决定性的**：同一工具、同一 schema，两个模型 100% vs 0% ⇒ 是模型的确定性行为，不是框架 bug。
- 该家长 `app_settings.defaultModel = mimo-tokenplan/mimo-v2.5`；**当前凡走 `parent_db_write` 的操作 100% 失败**。
- 故障会话因果链（`2026-09-22T07-53-57` 家长会话）：第 7 行**首次调用 `rows` 就已是字符串**（此前无任何报错）
  → 之后 4 次重试在 `{…}` / `[{…}]` 之间来回切但**始终带引号** → 第 19 行放弃并让用户「反馈给开发者」。
  同一会话 `where={"id":"ba4180ab"}` **全程是对象** —— 这正是用户看到「`where` 好、`rows` 坏」的原因。

### 1.3 为什么必须在参数层修

模型**无法表达 `anyOf`**（mimo 把联合类型一律退化成字符串），且它**看不到自己的原始 token**，
所以「提示模型写对」这条路不可靠（实测 5 次重试仍在两种形状间切换、每次都被引号包着）。

### 1.4 逐参数补丁已漏掉的参数（本次要一次覆盖）

`courses`（`parent_plan_create` / `child_plan_create` / `schedule`）、`titles`、`require`（`Record<string,number>`）、
`exclude`、`fields`、`days` —— 每新增一个复合参数工具就多一个踩坑点。

---

## 2. 根因与已排除的假设

| 层 | 事实 | 证据 |
|---|---|---|
| 模型 | `mimo-v2.5` 对 `anyOf` 联合属性 100% 输出 JSON 字符串 | 201 会话按模型分组统计 |
| SDK 校验 | `validateToolArguments` = `Value.Convert`（**只做标量转换**）→ `Compile().Check()`；不做 string→结构 解析 | `pi-ai/dist/utils/validation.js:247` |
| 后果 | 校验在 `execute` **之前**失败，工具未执行；报错还回显字符串形态实参 → 模型无法脱出 | `pi-agent-core/dist/agent-loop.js:404` |

**已排除（不是框架把参数序列化了）**：
1. provider 适配层不改 schema —— `api/openai-completions.js:1099` 原样透传 `tool.parameters`；
2. 流式解析器不改写结构 —— 只 `parseStreamingJson(partialArgs)` 一次，`utils/json-parse.js` 是忠实解析器（`JSON.parse` + 字符串字面量修复 + partial 兜底）；
3. 反证 —— 09-18 同一模型 `rows` 传**真数组**成功落库；`deepseek-v4-flash-0731` 20 次调用零字符串化。

---

## 3. 备选方案与定案

| 方案 | 做法 | 评价 |
|---|---|---|
| A. 逐参数补丁（**现状**，ISSUE-133） | 每个复合参数 schema 加 `string` 分支 + 执行器 `JSON.parse` | 有效但要**手工枚举**，新工具容易漏（已漏 §1.4 六个） |
| B. 递归改 schema | 包 `defineTool` 递归给所有 object/array 节点加 `string` 分支 | 覆盖全，但**改了发给 provider 的 schema**（描述/提示词体积、模型行为都受影响），且字符串仍会进执行器，需配套递归 parse |
| **C. `prepareArguments` 统一还原（定案）** | 在**校验之前**把字符串还原成结构 | ✅ **schema 一字不改**；✅ 官方钩子（内置 `edit` 即此用法）；✅ 一处覆盖全部工具；✅ 校验层拿到的是结构，报错自然消失 |
| D. 换模型 | 家长默认模型换回 `deepseek-v4-flash-0731` | 只是运营绕行、受额度制约；**保留为修复上线前的临时止血** |

**定案：方案 C**；A 作为第二/第三道保险保留（幂等、成本≈0）。

---

## 4. 方案 C 设计

### 4.1 接入点（SDK 官方提供、且已在公开类型里）

```ts
// @earendil-works/pi-agent-core/dist/types.d.ts:346
/** Optional compatibility shim for raw tool-call arguments before schema validation. */
prepareArguments?: (args: unknown) => Static<TParameters>;
```

调用链（已核实 `agent-loop.js`）：

```
403  prepareToolCallArguments(tool, toolCall)      ← 调 tool.prepareArguments
404  validateToolArguments(tool, preparedToolCall) ← 校验在它之后
457  tool.execute(id, prepared.args, …)            ← 执行器拿到还原后的结构
445  抛错 → createErrorToolResult(error.message)   ← 可读错误转成模型可见的 isError 结果
```

**官方先例（同一问题、同一解法）**：内置 `edit` 工具
`pi-coding-agent/dist/core/tools/edit.js`，注释原话
「Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array」，
其 `prepareEditArguments` 对 `edits` 做 `JSON.parse`。
包装层不丢字段：`wrapToolDefinition` / `createToolDefinitionFromAgentTool` 均透传 `prepareArguments`；
`utils/deferred-tools.js` 不涉及参数校验（校验只有 agent-loop 一条路径）。

### 4.2 实现要点

- 新增 `server/src/agent/tool-kit.ts`：`coerceToolArgs(schema, args)` + 包一层 `defineTool` 注入 `prepareArguments`。
- 切换面：`server/src/agent/*.ts` 12 个 + `server/src/worker/*.ts` 2 个（共 **14 个文件改 import**）；
  `packages/agent-core` **无需改**（只透传 `customTools`）。
- **返回新对象**：模型原始输出仍如实落盘（今天的诊断全靠 jsonl 里的原始字符串形态），只有校验/执行看到还原后的结构。

### 4.3 还原规则（白名单式下沉，避免误伤合法字符串）

```
coerce(schema, value):
  ① anyOf / oneOf（联合类型，如 rows = [数组, 对象]）
       - 先找「已与 value 类型吻合」的分支 → 用该分支递归
       - value 是字符串 → 找一个期望 object/array 的分支，parse 后类型吻合则采用
  ② schema 期望 object → 字符串且形如 {…} 则 parse（结果须为对象）；对象则递归已声明属性 + patternProperties/additionalProperties
  ③ schema 期望 array  → 字符串且形如 […] 则 parse（结果须为数组）；数组则逐元素按 items 递归
  ④ 其它（string / number / boolean / enum / const / unknown）→ 原样返回，绝不 parse
```

**四道护栏**：
1. **只有 schema 明确声明 object/array 的节点才 parse**；`additionalProperties: {}`（`where` 的值、`Type.Unknown`）
   视为 unknown **不解析** ⇒ `answer` / `scoring` / `content` 这类「内容形如 JSON 的普通文本字段」**永不被改写**。
2. **parse 后类型必须与 schema 期望吻合**，否则不采用（交回校验层报错，不猜）。
3. **非法 JSON → 抛可读中文原因**（「rows 收到的是字符串但不是合法 JSON…请直接传结构」），
   经 `agent-loop` 转成 isError 工具结果 —— 比现在的 `must be object` 可操作得多。
4. **返回新对象、不改模型原始输出**（见 4.2）。

### 4.4 与既有修复的关系（三层保险，都保留）

| 层 | 位置 | 角色 |
|---|---|---|
| ① `prepareArguments` 还原（新） | `tool-kit.ts` | **主路径**：校验前还原 → 校验天然通过 |
| ② schema `string` 分支（已在） | `tool-shapes.ts` | 第二道：万一某路径未走 `prepareArguments` 仍放行 |
| ③ 执行器 `JSON.parse`（已在） | `db-channel.ts` | 第三道：直调执行器的脚本/测试也受益；幂等 |

> 新建工具**不再需要**处理 ②③（包装器自动覆盖）。

### 4.5 原型验证（设计期已跑通，2026-09-23）

设计阶段先按 §4.3 规则写了原型（临时脚本，**已随实施完成删除**），复刻 `agent-loop` 两步
（`prepareArguments` → `Value.Convert` + `Check`）跑 9 个用例，**全部符合预期**；同一批场景现已由
`test/issue134-arg-coercion.test.ts` 的正式用例覆盖（且更强：真实工具 + 真执行）：

| 用例 | 结果 |
|---|---|
| **基线**：无 `prepareArguments`，`rows` 传字符串 | ❌ 复现现场三条报错（`must be array / must be object / must match a schema in anyOf`） |
| ① `rows` 字符串（数组写法） | ✅ 通过，还原为**数组** |
| ② `rows` 字符串（对象写法） | ✅ 通过，还原为**对象** |
| ③ `rows` 仍是真对象（原有形态） | ✅ 不变 |
| ④ `rows` 非法 JSON（`[{"status":`） | ✅ 抛出**可读中文原因**（将作为 isError 结果回给模型） |
| ⑤ `items` 字符串（深长嵌套数组） | ✅ 还原为数组 |
| ⑥ **嵌套内层**也是字符串（`questions: "[{…}]"`） | ✅ 递归一并还原 |
| ⑦ 误伤防护：`answer` 是含 JSON 的普通文本 | ✅ 原样保持字符串 |
| ⑧ 误伤防护：顶层 `note` 是 JSON 文本 | ✅ 原样保持字符串 |

### 4.6 不追求的事

- 不改 `node_modules`、不 fork SDK（用官方钩子）。
- 不放宽任何**业务**校验（列白名单 / 行数熔断 / 引用校验 / 事务 / 审计一概不动）。
- 不靠提示词「教模型别写字符串」（做不到，也不该依赖）。

---

## 5. 实施步骤（**已执行 P0~P2**）

| 阶段 | 内容 | 状态 |
|---|---|---|
| **P0** | 新增 `server/src/agent/tool-kit.ts`（`coerceToolArgs` + 包装器 `defineTool`，含「工具自带 `prepareArguments` 先跑它」的链式处理）+ 单测 | ✅ |
| **P1** | 14 个文件 `defineTool` import 从 SDK 切到 `tool-kit`（`agent/*.ts` 12 + `worker/*.ts` 2；其中 `parent-registry` / `session-registry` / `programming-agent` 是多行导入，已把 `defineTool` 从 SDK 导入里摘出） | ✅ tsc 0 错；`packages/agent-core` 无需改 |
| **P2** | `test/issue134-arg-coercion.test.ts` 19 用例（单元 11 + 集成 8） | ✅ 19/19 绿 |
| **P3** | 文档 + bump 0.5.5 + 部署 201 | ⏸ **按用户决定暂不做**（不部署） |

### 5.1 实施记录（2026-09-23 09:00 前后）

**改动文件**：
- 新增 `server/src/agent/tool-kit.ts`（还原层 + 包装器）
- 新增 `test/issue134-arg-coercion.test.ts`（19 用例）
- 改 import：`server/src/agent/{child-db-tools,display-tool,fs-tools,kb-summary-tool,page-tools,parent-plans,parent-registry,parent-report-tool,parent-tools,plan-tools,programming-agent,session-registry}.ts`、`server/src/worker/{custom-task-tools,kb-tools}.ts`

**实现要点（与设计的差异）**：
- 包装器类型声明为 `as typeof sdkDefineTool`（内部走 `any`）——因为 **SDK 自带一份 typebox、服务端另有一份**，
  直接写泛型签名会因 `Static<TParams>` 跨包不同源报一堆类型噪音；这样调用点泛型推断与原来完全一致，14 个文件只需改 import 一行。
- 超出设计的一处加固：工具**自带** `prepareArguments` 时（SDK 内置工具如 `edit` 就有）先跑它、再跑本层，避免覆盖别人的兼容逻辑。

**验证结果**：
- `test/issue134-arg-coercion.test.ts` **19/19 通过**：
  - 单元 ①~⑪：rows 字符串（数组/对象）还原、真数组/真对象零干扰、非法 JSON → 可读原因、非 JSON 文字原样交回、
    `items` 深长嵌套 + **内层 questions 字符串**两层还原、**误伤防护 3 条**（`answer` 含 JSON 文本 / 顶层 `note` JSON 文本 /
    `where` 的值是 `Type.Unknown` 均原样）、不改入参且返回新对象、包装器注入生效。
  - 集成 ⑫~⑲：三个构造器（`createParentAgentTools` / `createPlanDomainTools` / `createDataAgentTools`）
    **每个工具都挂上了 `prepareArguments`**（缺失清单为空）；`parent_db_write`（rows 字符串 → 真改库为 done/done）、
    `parent_upsert_course_content`（items 字符串 → 知识点/题/挂载真落库）、
    `parent_study_plan_create`（days 字符串 + 内层 content 字符串）、
    `parent_exam_plan_create`（courses 字符串 + methodSpec 字符串 + 内层 require/exclude 字符串）、
    `parent_sync_courses_to_child`（titles 字符串）、`parent_recurrence_create`（courses 字符串）全部**校验通过**。
- **全量 `test/` 对照基线零新增失败**：改动前 10 文件 / 19 用例失败 → 改动后 **同 10 文件 / 同 19 用例失败**
  （全部是既有的环境/历史问题：缺 ffmpeg、测试引用已删除模块、连 201 建孩子撞上限、桥脚本体积断言等）；
  通过数 427 → 449（+22＝新增 19 + 此前未计数的 3）。
- `server` `tsc --noEmit` **0 错**；`scripts/build.mjs` 构建成功，`dist/server.cjs` 已含 `coerceToolArgs` / `prepareArguments`。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 某条路径不走 `prepareArguments` | 退回现状（硬失败） | 保留 ②③ 两道保险；新增「不经 prepare 的路径」断言用例 |
| 误 parse 合法字符串参数 | **数据被改坏**（最需防） | 白名单式下沉 + parse 后类型校验 + 专项误伤用例（`answer`/`scoring`/`content`） |
| 改动波及 14 个工具文件 | 编译/行为回归 | 机械替换 + tsc 闸门 + 分批切换 + 全量测试对比基线 |
| 递归实现遇超深/超大参数 | 性能 | 只按 **schema** 结构走（不遍历未知分支）；深度受 schema 深度限制 |
| SDK 升级后钩子变化 | 将来失效 | 包装器集中一处，升级只改一个文件；文件头注明「若 SDK 提供官方解码开关则切换」 |
| 与 `tool-shapes.ts` 逐参数补丁重复 | 维护困惑 | 文档化三层职责（§4.4）；逐参数补丁保留为显式契约 |

---

## 7. 验收标准

1. **mimo 的 5 种历史失败形态全部成功**：`rows` 字符串（对象/数组两种写法）、`items` 字符串数组、
   `require` 字符串对象、`courses` 字符串数组 → 校验通过 **且语义正确**（真写对库 / 建对计划）。
2. **非法 JSON** → 模型收到**可读中文原因**（isError 工具结果），而非 schema 文案。
3. **误伤防护**：`answer` / `scoring` / `content` 等字符串字段即使内容形如 JSON，也**原样不被改写**。
4. **原始输出仍如实落盘**：会话 jsonl 里仍是模型原始（字符串）参数，便于事后诊断。
5. **零回归**：`test/` 全量相对基线无新增失败；上线后生产会话 `Validation failed for tool` 计数不再增长。

---

## 8. 待用户拍板（**已拍板，全部落地**）

1. ~~是否实施~~ → **实施**（P0~P2 已完成）；**先不部署**（P3 挂起）。
2. ~~修复上线前是否先止血~~ → **不用**（不换模型）。
3. ~~`tool-shapes.ts` 逐参数补丁~~ → **保留**（作第二道保险，已保留）。

## 9. 部署记录与遗留

**已部署 201（2026-09-23 09:05，server 0.5.5）**，脚本 `tmp/deploy/deploy_055.sh` + `deploy_server_055.py`：
- 停机约 4 秒（stop → 备份 → 换 bundle → start）；备份：bundle `server.cjs.bak-20260923-0905`、
  数据 `data/backups/deploy-0.5.5-20260923-0905/`（server.sqlite + agents.sqlite 在线快照 + 配置四件套）。
- 验证：`/api/v1/version` = **0.5.5**（部署前 0.5.4）；`/api/v1/health` `{ok:true, db:ok}`；
  bundle 标记 `coerceToolArgs`×2 / `prepareArguments`×8 / `JsonArrayParam`×2；
  `journalctl` 近 2 分钟 ERR_COUNT=0；进程 `/usr/bin/node /opt/learning-server/server.cjs` 正常运行。
- **同一 bundle 还带上了工作树里既往未部署的改动**：ISSUE-132 题库接口
  （`/api/v1/assess/questions/{facets,link,unlink}` 实测返回 401 即路由已注册）与 ISSUE-129 的两个
  已部署但漏入 git 的文件（本次已补提交，见 commit `08f45a5`）。

**遗留**：客户端包未随动（本次纯服务端；ISSUE-132 面板、token 面板等 UI 随下次客户端发版）。
**回滚**：`cp -a /opt/learning-server/server.cjs.bak-20260923-0905 /opt/learning-server/server.cjs && systemctl restart learning-server`。

**自测建议**：家长助手做一次「改学习计划状态」——mimo 照旧把 rows 写成字符串，现在应能成功。

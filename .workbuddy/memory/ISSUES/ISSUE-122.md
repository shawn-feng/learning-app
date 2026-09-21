# ISSUE-122：parent_db_write 的 update 永远报「列 0 未登记」——✅ 已修复（2026-09-21，rows 形状归一 + 执行器双向兼容 + 报错自愈）

- **类型**：bug（db-channel 写通道 update 分支；家长侧与孩子侧 child_db_write 同构风险）
- **现象（家长 agent 实测）**：调 `parent_db_write` 更新 courses 表的 title（改课程名，uuid 不变、关联全不掉的最干净改法），多种写法（单列对象、多列对象、数组包对象、列名/值对、含主键整行、sort_order 定位）**全部被拒且报同一错误**：
  「列 0 未登记，不能写。courses 可写列：topic、title、sort_order、material、send_material、tags、lesson_method、html_path、teaching_copy、assess_rubric」
  ——而所传列明明在它自己列出的白名单里。改课程名这一场景经由 db 通道**完全不可用**（ISSUE-105 立项要解决的「新场景加工具」痛点，工具存在但坏了）。
- **根因（已核实代码，schema 与执行器自相矛盾）**：
  - **工具 schema 强制 rows 是数组**：`parent-tools.ts:1234-1238` `rows: Type.Array(Type.Record(Type.String(), Type.Unknown()))`，description 写「insert=行数组；update=要写入的列值对象（{列: 新值}）」——**类型约束是数组，说明文字却要求 update 传对象**，LLM 只能顺应数组（想传对象也被 Type.Array 拦），于是每次都传 `rows: [{...}]`。
  - **update 执行器期望对象**：`db-channel.ts:507` `const sets = Object.entries(req.rows ?? {})`——对数组做 `Object.entries` 得到 `[["0", {…}]]`，列名变成下标 **"0"** → 白名单查不到 → 「列 0 未登记」——**错误消息里的「0」就是数组下标**，铁证。
  - **类型声明同样矛盾**：`WriteRequest.rows?: Array<Record<string, unknown>>`（`db-channel.ts:370`，类型是数组）+ 注释「insert=行数组；update=列值对象」——update 从 类型层面就走不通。
- **修复方向（建议 1+2+3 组合）**：
  1. **schema 改型（治本）**：`rows` 改 `Type.Union([Type.Array(Type.Record(...)), Type.Record(...)])`，或更彻底——**拆成两个参数**：insert 用 `rows`（行数组）、update 用 `values`（`Type.Record` 列值对象），语义零歧义，description 同步；
  2. **执行器双向兼容（兜底，立即可用）**：update 分支遇 `Array.isArray(req.rows)` 时取 `req.rows[0]` 作为列值对象（多元素报「update 一次只改一行，多行请按 where 逐条」）；insert 分支遇对象视为单行数组；
  3. **报错文案自愈**：命中「列 N 未登记」且 N 为纯数字时，附加「rows 被按数组解析；update 的 rows 应为 {列:值} 对象（或升级后直接兼容）」。
- **回归**：insert 路径行为不变；孩子侧 `child_db_write`（child-db-tools.ts，同构 rows 参数）同批核查；tier2Write（ns: 灵活实体，走同一 rows 形状）一并兼容；audit/confirm/行数熔断逻辑不受影响。
- **优先级**：高（db 通道的 update 语义整体不可用——家长改课程名/改题干备注等高频场景全被挡；修复极小）
- **记录时间**：2026-09-21


---

## ✅ 解决记录（2026-09-21，按建议 1+2+3 组合落地）

- **② 执行器双向兼容（治本承载）**：`db-channel.ts` 新增 `normalizeWriteRows(op, rows)`——
  insert：数组原样、对象视为单行；update：对象原样、**数组取首元素**、多元素拒绝（「update 一次只改一行，多行请按 where 逐条」）。
  `executeWrite` 的 insert/update 分支与 `tier2.ts` 的 `tier2Write`（同构 bug：`:543` 同款 Object.entries）全部改走归一。
- **① schema 改型**：`parent_db_write`（parent-tools.ts）/ `child_db_write`（child-db-tools.ts）的 rows 改 `Type.Union([行数组, 列值对象])`，description 写明两形状（insert=行数组/单行对象；update=列值对象，兼容单元素数组）——LLM 传哪种都能走通。
- **③ 报错自愈**：新增 `digitColHint(col)`——「列 N 未登记」且 N 为纯数字时附「rows 被按数组下标解析成列名——update 的 rows 应为 {列: 值} 对象」；`executeWrite`/`tier2Write` 的未登记列报错均挂上。
- **连带修正**：parent-tools 重嵌入路径（ISSUE-111）对 insert rows 现在可能是单行对象——统一包成数组再取主键标脏（原写法对对象 for-of 会直接抛错）。
- **回归**：insert 行数组主路径不变；`WriteRequest.rows`/`Tier2WriteRequest.rows` 类型放宽为数组|对象；audit/confirm/行数熔断/引用校验/敏感列复述全不动；`child_db_write` 与 Tier 2 ns 写一并兼容。
- **验证**：新增 `test/issue122-db-write.test.ts` 8 用例（update 数组/对象/多元素拒绝/数字下标自愈提示、insert 数组+对象、tier2 数组+对象+多元素拒绝），连同 material-rewrite/issue121/kb-domain-split 共 24 测试全过；server tsc 零错误。
- **部署状态**：**未上 201**——当日 0.5.0b 部署在先，本修复在其后；下次发版随包带上。

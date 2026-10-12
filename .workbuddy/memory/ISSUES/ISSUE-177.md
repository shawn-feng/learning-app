# ISSUE-177：家长文件管理根目录重复条目（materials/uploads 各出现两次）+「删除没反应」体感——P2 归并后虚拟别名未塌缩 + 删除确认双弹窗

- **类型**：bug（UI 缺陷 + 前端交互缺陷）
- **优先级**：高（家长文件管理是 ISSUE-131 网盘的门面；重复条目直接让用户误判「有两份拷贝」）
- **记录时间**：2026-10-10
- **来源**：家长文件管理根目录截图（珊珊家长）：「课程资料库 materials」和裸「materials」并存、「上传原始件 uploads」和裸「uploads」并存（红框标注）；家长工作区里删文件「没有反应」。
- **关联**：ISSUE-131（P2 物理归并的遗留缺陷，131 遗留 P3 清单未含此项）、ISSUE-124/125（uploads 区语义）

## 根因一：根目录重复条目——P2 归并后 P1 虚拟别名没有塌缩（201 实测复现）

**API 层即重复**（2026-10-10 在 201 以探针 JWT 调 `/api/v1/fs/list?path=""`，实测输出）：

```
materials  label=课程资料库      ← fs.ts:405 手工前置的虚拟区条目
uploads    label=上传原始件      ← fs.ts:406 同上
09406c05-… label=闻闻 的工作区
1f050a7f-… label=珊珊 的工作区
5fc5857f-… label=小试 的工作区
materials  label=-              ← 物理列表再列一遍（同一个目录！）
parent     label=家长工作区
scratch    label=-
uploads    label=-              ← 同上（同一个目录！）
```

**成因链**：
1. P1 时代（fs.ts 文件头注释设计）：家长虚拟根 = `materials/`（物理 `materials/<pid>`）+ `uploads/`（物理 `files/<pid>`）+ `workspaces/<pid>/…`，三棵**互不相交**的树，所以根列表手工前置两个虚拟区条目（`server/src/routes/fs.ts:404-407`）再追加物理子项（`fs.ts:417` `listPhysicalDir(zoneRoot(ctx,"workspace"))`）是正确的。
2. P2 物理归并（ISSUE-131，2026-09-22）把区挪进了工作区：`materialsRoot = workspaces/<pid>/materials`（`server/src/db/materials.ts:47-49`）、`uploadsRoot = workspaces/<pid>/uploads`（`fs.ts:102`）。
3. 于是「手工前置的虚拟条目」和「workspaces/<pid> 的物理子项」**必然同名同 path 各出现一次**。fs.ts:10 自己写着「P2 物理归并后……虚拟映射在此单点塌缩成单根」——**塌缩只做了 resolveEntry/materialsRoot，fsList 的根列表没做**。

**连带问题**：
- 两个条目 `path` 完全相同（都是 `"materials"`/`"uploads"`），而列表行 React key 用 `key={e.path}`（`src/components/FilesPanel.tsx:656`）→ **重复 key**，reconciliation 未定义行为；
- 用户点哪个都进同一个目录，但看上去像「两份拷贝」，诱使用户去删「多余的那份」→ 见根因三；
- `guardReservedName`（fs.ts:186-190）只挡「新建」同名项，挡不住物理列表的既有同名。

## 根因二（排除项）：家长工作区内的删除本身是好的——201 实测通过

- 探针：sudo 在 `workspaces/<pid>/parent/` 落一个 `__probe_delete_me.txt` → POST `/api/v1/fs/delete {"path":"parent/__probe_delete_me.txt"}` → **`{"ok":true}` 200，磁盘确认已删**。
- 两端 IPC 桥都不会静默 reject：electron `fs:delete`（`electron/lib/ipc-handlers.ts:1759-1773`）与 web shim（`web/src/shim/domains/fs.ts:118`）失败均返回 `{success:false,error}`；FilesPanel 有 error 红条渲染（`FilesPanel.tsx:569`）。**真正失败的删除会显示红字，不会「无反应」。**

## 根因三：「删除没反应」的体感来源（两条，均可复现/可证）

**a. 用户删的是重复条目本身 → 400 被拒，条目纹丝不动。**
「materials」/「uploads」在根视图是保留区根，`guardZoneRoot`（fs.ts:179-183）抛 `400 保留区目录不能删除`（201 实测两条均 400）。红条在列表上方的工具区（`FilesPanel.tsx:569`），离点删除的行很远，用户注意不到 → 体感「点了删除没反应」。截图红框恰好框着这四条，即用户当时正在尝试删重复项。

**b. materials 区带引用的删除：确认弹窗弹两次，第二次取消则什么都不删。**
`FilesPanel.tsx:311-319` `handleDelete`：客户端预检 `confirmRefsIfNeeded`（fs/refs + 弹窗）→ 用户点「仍然执行」后，发出的请求 **仍带 `confirm:false`**（`:313` 用的是初始参数 `confirm`，没有把用户的确认传下去）→ 服务端 `guardMaterialsRefs` 再拦 → `needsConfirm`（HTTP 200 短路）→ `handleNeedsConfirm` **再弹一次**确认框。用户明明已经确认过一次；第二次弹窗若点「取消」，整条链路静默结束、无任何提示 → 「点了删除没反应」。`handleRename`/`handleMoveTo` 同款（`:291-309` / `:326-334`）。
旁证：201 journal 2026-10-10 18:38:13 全天唯一一次删除序列 = `fs/refs → fs/delete(200, 43ms) → fs/list`；路由对 `needsConfirm` 也返回 200（fs.ts:921-923），日志无法区分 ok/needsConfirm，但与 b 路径形态吻合。

## 方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0) | 消除重复：家长根列表不再手工前置 materials/uploads 虚拟条目，改为在物理列表上**按 path 合并、补 label**（materials→课程资料库、uploads→上传原始件）；或前置条目保留但 byName 去重（label 优先） | `server/src/routes/fs.ts:402-423`（fsList 家长根分支） | P2 后两区就在 workspaces/<pid>/ 内，物理列表即唯一来源；fs.ts:10 的「塌缩」注释兑现。孩子 scope 无虚拟根，不受影响 |
| F2 (P0) | 删除/改名/移动：客户端确认弹窗通过后**把 `confirm:true` 传进首次请求**，去掉第二次弹窗；服务端 needsConfirm 兜底保留（双保险但常态单弹窗） | `src/components/FilesPanel.tsx:311-319`（handleDelete 等 3 处） | 弹一次、点一次「仍然执行」就删；取消就取消，不静默 |
| F3 (P1) | React key 去重：`key={`${e.path}-${i}`}` 或 F1 后重复自然消失、留一条测试断言（根列表 path 不得重复） | `FilesPanel.tsx:656` + `test/issue131-fs-drive.test.ts` | 防回归 |
| F4 (P1) | 保留区条目的删除按钮处理：对根视图的 materials/uploads 隐藏「删除」（沿用 uploads 条目「原始件」只读徽标的模式 `FilesPanel.tsx:739-744`），或 400 文案改「系统区不能删除」并**把错误红条滚动到可见/挂在行内** | `FilesPanel.tsx` + `fs.ts:179-183` | 让「不能删」在点击处可见，而不是远处红条 |
| F5 (P2, 可选) | 截图里 outputs/ 已不在（当前根无 outputs），历史孤儿目录不影响本 issue；P3 旧目录退役策略仍走 ISSUE-131 遗留清单 | — | 不扩scope |

## 验证建议

- 201 部署后 `fs/list ""` 根列表 materials/uploads 各出现**一次**且带 label；
- 根视图点重复条目（修复后唯一条目）的删除 → 行内可见「系统区不能删除」类提示（或按钮直接不出现）；
- materials 区删除被引用文件：只弹**一次**确认，确认后删除成功；取消则不动、无二次弹窗；
- 家长工作区/孩子工作区内删文件：立即消失（现状已好，防回归）；
- `test/issue131-fs-drive.test.ts` 增补「根列表无重复 path」断言。

## ✅ 已实施（2026-10-10，F1~F4 全做，F5 不扩 scope 未动）

**F1（P0）服务端去重**（`server/src/routes/fs.ts` fsList 家长根分支）：不再手工前置虚拟条目——先列 `workspaces/<pid>` 物理子项（孩子工作区/家长工作区 label 逻辑不变），再对 `materials`/`uploads` **按 name 合并就地补 label**（课程资料库/上传原始件）；物理缺失才前置兜底（未归并的极端形态）。根列表每条 path 唯一，fs.ts 头部「P2 后虚拟映射单点塌缩」注释在本分支兑现。

**F2（P0）删除/改名/移动单弹窗**（`src/components/FilesPanel.tsx` 三处 handler）：`confirmRefsIfNeeded` 的返回值语义本就是「本次操作的等效 confirm」（confirm 已带→跳过预检；无引用→true；有引用弹窗→用户点「仍然执行」true/取消 false）——改为 `const confirmed = await confirmRefsIfNeeded(...)` 并把 `confirmed` 传进首次请求，用户确认过就不再触发服务端 needsConfirm 二次弹窗；`handleNeedsConfirm` 兜底保留（双保险，常态单弹窗）。取消就取消，不再静默。

**F3（P1）**：行 key 改 `` key={`${e.path}-${i}`} ``（防任何来源重复 path 的 reconciliation 风险）；`test/issue131-fs-drive.test.ts` 根列表用例增补断言——`Set(names).size === names.length` 且 materials/uploads 各恰好 1 条（**17/17 全绿**）。

**F4（P1）**：家长根视图的保留区条目（`zoneRootEntry`：cwd 为根 + dir + path 为 materials/uploads）**不渲染**删除/重命名/移动按钮，行内给「系统区」徽标（对齐 uploads「原始件」只读徽标模式）；服务端 guardZoneRoot 400 保留作兜底。

**验证**：issue131 17/17（含新断言）、三端构建过、web typecheck 基线持平。**待部署 201**（随下次服务端发版；客户端 FilesPanel 改动随下个客户端包）——部署后按「验证建议」清单过一遍（根列表唯一/删除单弹窗/家长工作区删除即时）。

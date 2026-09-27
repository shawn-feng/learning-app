# ISSUE-159：孩子重进会话左侧资料仍清空（ISSUE-113 回归）——Web shim 的 piStartChild 把 materials 硬编码为 `[]`，服务端/桌面端链路都通、唯独 Web 端丢资料

- **类型**：bug / 回归（ISSUE-113 修复的遗留缺口；Web 端专属）
- **现象**：201 生产（0.5.17）孩子（网页端）重进会话，对话历史回来了、左侧学习资料列表空——「会话在、资料没了」复现。
- **排查（2026-09-27 只读探针，逐环节）**：
  - ✅ **服务端正常**：`display_contents` 登记有数据（珊珊 11 行 / 闻闻 1 行，最新 ts=09-27 11:12）——登记、/reset 清空、`GET /agent/:childId/open` 返回 `{messages, materials}`（201 bundle 534150 `return { messages, materials }` 实锤）全部在位；
  - ❌ **Web shim 丢资料**：`web/src/shim/domains/agents.ts:445` `piStartChild` 调 `openChildSession(childId)`——该函数（:145）**只返回 `mapHistoryMessages(...)`，把服务端响应里的 `materials` 字段丢弃**；shim 里 ：455 明写 `return { success:true, history, materials: [], materialsLimit: ... }` + 注释「materials 返回空（与 ipc 一致）」——**注释过时**（Electron 侧 ISSUE-113 实施时已改为回传真实 materials，Web shim 没跟着改）；
  - ❌ **Electron 桌面端同病**：`electron/lib/server-agent-client.ts:566` `openChildSession` 同样只返回 history（丢 materials），而 `ipc-handlers.ts:1318` 却读 `open.materials` → **桌面端 pi:start_child 实际回传的也是 undefined**（Learn.tsx:430 `Array.isArray(undefined)` → 不回填）——`201 上 201 bundle 的桌面包旧版本（web/dist piStartChild 还带 `course:${i}` 会话参数）与本地 HEAD 均有此缺口。
  - 旁证：201 日志 `/agent/:childId/open` 23 次 200（服务端在正常返回）+ 2 次 400（客户端偶发发了 `course:xxx` 旧会话参数被 rejectLegacySession 拒——会话收敛遗留，顺带修）。
- **修复（两处，极小）**：
  1. **Web shim**（`web/src/shim/domains/agents.ts`）：`openChildSession` 改返回 `{messages, materials}`（服务端 shape 对齐）；`piStartChild` 回传 `materials: r.materials ?? []`；顺带删掉 `course:${i}` 旧会话参数（会话收敛后只剩 main，发它只会吃 400）；
  2. **Electron 桌面端**（`server-agent-client.ts`）：`openChildSession` 同改返回 `{messages, materials}`（经 mapHistoryMessages 保留原 shape），`ipc-handlers.ts:1318` `open.materials` 即刻生效。
- **回归**：桌面端与 Web 端重进资料回填一致；`/reset`、跨天新会话仍清空（displays.ts clearDisplayLog 语义不变）；Learn.tsx 回填/自动展开/保鲜刷新（refreshStaleMaterials）不受影响；`test/displays.test.ts` 4 例 + 新增「openChildSession 返回 materials」断言。
- **优先级**：高（ISSUE-113 的核心用户价值在主力使用端 Web 上不成立；改动极小）
- **记录时间**：2026-09-27

---

## 实施记录（2026-09-27）

- **Electron**（server-agent-client.ts）：`openChildSession` 返回类型改 `Promise<HistoryMessage[]>` → **`Promise<OpenChildSession>`（{messages, materials} 双字段）**——messages 仍走 mapHistoryMessages，materials 数组原样透传（服务端 /open 的 display_contents 登记行 shape：id/format/title/time/filePath/content；未回或非数组兜底 `[]`）。`ipc-handlers.ts` 的 `pi:start_child` 消费点 `open.messages`/`open.materials` 即刻生效，无需改动。
- **Web shim**（domains/agents.ts）：`openChildSession` 同改返回 `{history, materials}`；`piStartChild` 改回传 `materials: open.materials`（不再硬编码 `[]`），删除过时注释「materials 返回空（与 ipc 一致）」。HEAD 的 openChildSession 请求体本就是 `{}`（无 session 参数），201 老 bundle 的 `course:${i}` 参数是部署物遗留、源码里没有，无需改。
- **回归**：`test/server-agent-client.test.ts` 加 2 用例（双字段返回+shape / 服务端未回 materials 兜底空数组+请求固定 main 会话，mock serverFetch/auth-manager），26/26 过；`test/displays.test.ts` 4/4 过；根 tsc 无新增错误（基线 4×TS2318+1×TS2552 不变）；双端 `npm run build` 过；web-shim 覆盖过。
- **生效条件**：纯客户端改动（Electron 主进程 + web shim），服务端零改动；随下个客户端包发布，Web 端发 web/dist 即生效。

# ISSUE-102 家长 agent 缺少「读取孩子全部会话内容」的工具

> 记录时间：2026-09-15
> 优先级：🟡 待处理
> 类型：功能缺口（家长 agent 工具集）+ **隐私边界变更**

## 用户反馈
家长 agent 需要一个工具，能够读取孩子的所有会话内容（raw 对话逐字稿），目前没有。

## 现状（已核查，非猜测）

### 1. 家长 agent 当前工具集（server/src/agent/parent-tools.ts）
见 `createParentAgentTools`（L44-392）与 `PARENT_AGENT_TOOL_NAMES`（L394-412）。现有工具仅覆盖：
- 资料治理：`parent_list_materials` / `read` / `move` / `put` / `delete` / `read_image`
- 家长库：`parent_library_topics` / `courses` / `upsert_topic` / `upsert_course`
- 计划域（来自 parent-plans.ts）：`parent_list_children` / `parent_study_plan_*` / `parent_exam_plan_*` / `parent_life_plan_*`
- 编程：`parent_build_material`

**没有任何工具能读取孩子对话内容**。计划类工具给的是「摘要/排期」，不是逐字稿。

### 2. 但「读取孩子会话」的底层链路**已经存在且已验证**
服务端早已为「家长端·对话回顾」页建好读链路，只是没暴露给家长 agent：
- `server/src/db/sessions.ts`：
  - `indexAgentSessionsIntoDb(db, dataDir, parentId, childId)`（L139）：把 `agent-sessions/<parentId>/<childId>-<slot>/*.jsonl` 增量同步进 `session_messages` 表（按 `session_files` 游标幂等）。
  - `querySessionMessages(db, childId, date)`（L74）：按日期取完整逐字稿（剔除 thinking，附工具调用）。
  - `listSessionDates(db, childId)`（L62）：有消息的日期列表。
  - `readServerDailyConversation(dataDir, parentId, childId, date)`（L106）：直接扫 jsonl 返回当天全文（worker recording 与 summarize_conversation 共用）。
- `server/src/routes/sessions.ts`：家长 JWT 鉴权 + `assertChildOwned(db, parentId, childId)`（L36，childId 必须归属该 parent）的 GET 端点 `/sessions/:childId/dates` 与 `/sessions/:childId?date=`，供客户端回顾页用。
- 落盘真源：`server/src/db/sessions.ts` L102 明确——孩子对话全部由服务端 agent 落盘于 `agent-sessions/<parentId>/<childId>-<slot>/`，`session_messages` 是其索引。

→ **结论：本 issue 不是「从零造读取能力」，而是「把已有且经回顾页验证的读取链路，封装成一个家长 agent 工具」**。技术风险低。

### 3. ⚠️ 隐私边界变更（必须显式记录）
原设计基线（`memory/MEMORY.md` 与 DESIGN-server-agent-migration）：**「家长 agent 只读取孩子数据 summary、不触碰原始对话」**——这是一条隐私红线。
本需求**直接扩张**了该红线：家长 agent 现在要读 raw 逐字稿。

- 合法性：用户本人即家长，对孩子对话有知情权，扩张合理；且读链路已含 `assertChildOwned` 归属校验，只能读自己孩子的会话，与回顾页同口径。
- 但需在实现与文档中明确这一点，并保留**只读**约束（不提供任何写/改孩子会话的动作），避免越界。

## 修复方向（建议，未改代码）

### F1（核心，推荐先做）
在 `server/src/agent/parent-tools.ts` 新增工具 `parent_read_child_conversation`：
- 参数：`child`（孩子姓名或 id，经 `parent_list_children` 同名查询 `children WHERE parent_id=?` 解析为 childId）、`date`（可选，默认今天；支持 `all` 或 `YYYY-MM-DD`；避免一次性灌爆上下文）。
- 实现：`indexAgentSessionsIntoDb(db, dataDir, parentId, childId)` 先增量同步 → `querySessionMessages(db, childId, date)` 取逐字稿（或 `date=all` 时遍历 `listSessionDates` 合并，加总量上限如 50 条/天或最近 N 天）。
- 返回：格式化逐字稿（`孩子: … / 饺子: …`，附工具调用名）。
- 注册：加入 `createParentAgentTools` 返回数组 + `PARENT_AGENT_TOOL_NAMES`。

### F2（配套）
- `buildServerParentPrompt`（parent-registry.ts L87）增补该工具说明，并把「只读孩子会话、不改」写入工作原则；同时把原「不触碰原始对话」的红线描述更新为「可经授权工具读取原始对话（只读）」。
- 文档基线同步：本 issue 落地后，更新 `memory/MEMORY.md` 与 `技术实现文档-功能实现与数据流转` 中关于家长 agent 隐私边界的描述，撤销旧「不触碰原始对话」措辞。

### 安全/成本注意
- 默认按天读取 + 总量上限，防止「读全部历史」撑爆家长 agent 上下文与 token（孩子会话可能已累积数月）。
- 严格只读：工具执行体不得调用任何写会话/改会话的接口。
- 保留 `assertChildOwned` 同口径的归属校验（直接用 `db.prepare("SELECT 1 FROM children WHERE id=? AND parent_id=?")`）。

## 改动文件（预计）
- `server/src/agent/parent-tools.ts`（新增工具 + 注册）
- `server/src/agent/parent-registry.ts`（prompt 说明 + 边界措辞）
- `memory/MEMORY.md` 与 `技术实现文档-功能实现与数据流转-2026-09-13.md`（隐私边界基线更新，落地后做）

## 关联
- 复用：`db/sessions.ts` 的 `indexAgentSessionsIntoDb` / `querySessionMessages` / `listSessionDates`（与回顾页同源）
- 对比：ISSUE-100 的每日新建会话 → 会话按天分文件后，本工具按天读取天然对齐
- 隐私：原「家长 agent 只读 summary」红线被本需求授权扩张，需在文档显式更新

## 状态

✅ 已实施（2026-09-15）：

- **F1**：`server/src/agent/parent-tools.ts` 新增 `parent_read_child_conversation`（只读）——`resolveConvoChild`（姓名精确匹配 + 归属校验，找不到列出可选名）、`indexAgentSessionsIntoDb` 增量索引 → `querySessionMessages` 取逐字稿；`date` 支持缺省今天 / `YYYY-MM-DD` / `all`+`days`（默认 3 天、上限 7）；输出 `孩子名：…` / `AI 伙伴名（profile_json.aiName，缺省饺子）：…`，assistant 附工具调用名；单条 600 字符、总量 16000 字符截断；无记录时列出有记录的日期。已加入 `createParentAgentTools` return 数组 + `PARENT_AGENT_TOOL_NAMES`。
- **F2**：`parent-registry.ts` 的 `buildServerParentPrompt` 新增「孩子的对话记录（只读，家长已授权）」段（适用场景 / 归属边界 / 只读 / 汇报概括不复述）；`技术实现文档-功能实现与数据流转` §4.1 同步记录工具与**隐私边界变更**（原「不触碰原始对话」→「可经只读工具读取」）。
- **验证**：server `tsc --noEmit` + esbuild 构建通过；真实本地数据冒烟 5 例全过——今天（15 条）、all/3 天（三日期合并）、指定日期（2026-09-13，166 条，按上限截断）、不存在孩子（列出「闻闻、珊珊、小明」）、非法 date（提示合法格式）。
- 未部署 201（用户约定）；本地 dev server 已重启加载新工具。

### 后续改进（同日晚，用户要求「两个都做」）
1. **家长会话「重置」改为真正的新会话**（`parent-registry.ts`）：新增 `resetMarks` + `createCoreSession({ shouldAutoNewSession: () => resetMarks.has(key) })`；`resetParentSession` 释放实例后置标记（旧 jsonl 保留为归档，不再被 continueRecent 选中）。起因：现场诊断发现「工具已注册但模型仍答没有」= 模型被同会话历史里的旧否认锚住，而旧的 reset 只 dispose 实例、历史仍续接，等于没法清上下文。
2. **`parent_read_child_conversation` 的 date 支持口语表述**：`normalizeDateParam` 接受 今天/今日/today（=今天）、昨天/昨日/yesterday、前天；非法值报错文案同步更新。
3. **验证**：server typecheck + build 通过；离线冒烟 date 别名 5 例全过（昨天→2026-09-14/173 条、前天→2026-09-13/166 条、今天→2026-09-15/15 条、yesterday 同昨天、乱写→友好报错）；重置语义端到端验证 = 重置后 parent-content 会话首次追问**目录新增一个 jsonl**（`2026-09-14T23-28-59-471Z_…`），且模型在干净上下文里正确回答「能读取孩子对话」。文档 §8.2 已记录重置语义修正。

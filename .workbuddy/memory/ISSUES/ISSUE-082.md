# [ISSUE-082] 家长 agent「parent-content」会话：注释声称专用提示词，实际与 parent 共用同一 prompt

- **类型**：架构 / 实现偏差（意图与代码不符，非功能性 bug）
- **优先级**：待定（后续讨论如何处理）
- **状态**：已记录，待讨论
- **记录时间**：2026-09-13
- **标签**：`parent-agent` `prompt` `ISSUE-026` `解耦偏差`

---

## 一、问题现象

`src/components/TopicEditor.tsx:39` 的初始化注释写道：

> ISSUE-026：本页使用「教学内容生成专用会话」（**专门提示词，与通用家长助手解耦**）

即设计意图是：`parent-content` 会话应持有**区别于通用家长助手（`parent`）的专门提示词**，二者在提示词层面解耦。

但核查 `server/src/agent/parent-registry.ts` 的会话创建逻辑，`parent` 与 `parent-content` 两个 kind **调用的是同一个 prompt 构造函数的同一份输出**，没有任何按 kind 分流的逻辑：

- `buildServerParentPrompt`（:87-124）**不带 `kind` 参数**，只接收 `{ parentId, workspace, today }`；
- `ensureEntry`（:126-183）在创建会话时统一调用 `buildServerParentPrompt({ parentId, workspace, today: localDate() })`（:159），与 `kind` 无关；
- 两个 kind 的工具集也完全相同（`fsTools + parentTools + planDomainTools + getDate`，:152-157）。

结论：**「专门提示词」在代码中并不存在**。

## 二、真实的解耦边界（实际发生了什么）

两者**仅在以下三个层面隔离**，提示词层面未解耦：

| 维度 | `parent` | `parent-content` | 是否真隔离 |
|---|---|---|---|
| 会话 key | `<parentId>:parent` | `<parentId>:parent-content` | ✅ |
| 持久落盘目录 | `agentSessionsDir(parentId, "parent")` | `agentSessionsDir(parentId, "parent-content")` | ✅ |
| SSE 流 key | `AgentStreamHub.key(parentId, "parent")` | `AgentStreamHub.key(parentId, "parent-content")` | ✅ |
| system prompt | `buildServerParentPrompt(...)` | `buildServerParentPrompt(...)` | ❌ **完全相同** |
| 工具集 | 同一套 | 同一套 | ❌ **完全相同** |

因此 `parent-content` 的作用仅限于：**给主题/课程编辑器提供一段独立对话历史、不被通用助手污染，且能订阅自己的 SSE 流**（见 `TopicEditor.tsx:56` 用 `data.childId !== "parent-content"` 过滤流）。它并不是一个"能力或提示词不同的专用 agent"。

## 三、影响与风险

- **非功能性缺陷**：当前功能可正常工作（两个会话都能完成资料生成、计划编排等），不导致崩溃或数据错误。
- **误导维护者**：注释承诺的"专门提示词"不存在，后续维护者按注释预期去改 `parent-content` 的提示词时，会改到与 `parent` 共享的同一份，造成连带影响。
- **潜在能力诉求未满足**：`parent-content` 当初独立出来，隐含意图很可能是"窄化提示词聚焦教学内容生成（如去掉计划域指引、强化资料治理与落库引导）"。这个能力诉求目前未被满足，但鉴于 `parent_upsert_*` 工具尚未接入（见 `ISSUE-081` P2 及核对报告 §17 #3），即便有专用提示词也暂无真正落库的写工具可用。

## 四、待讨论的处理方向（仅列方案，本次不实施）

1. **方案 A（让注释成真）**：给 `buildServerParentPrompt` 增 `kind` 参数，或为 `parent-content` 单独写 `buildServerParentContentPrompt`（聚焦教学内容生成、可收窄工具引导），使两个会话在提示词层面真正解耦。需同步评估是否收窄其工具集（如保留资料治理 + 落库，去掉计划域工具）。
2. **方案 B（让注释归位）**：若确认不需要专用提示词，只需把 `TopicEditor.tsx:39` 的"专门提示词"措辞改为"独立对话实例/流，提示词共用"，消除误导。改动最小。
3. **方案 C（暂不处理）**：现状不影响功能，仅修正注释或加一行代码注释说明"二者共用 prompt，解耦仅限实例层"，留待未来若真需要专用内容提示词时再实施 A。

> 决策点：是否需要 `parent-content` 在提示词/工具层面真正不同于通用助手？若需要，优先 A；若不需要，B/C 即可。

## 五、关联

- `ISSUE-026`（注释中引用的来源，主题/课程编辑器教学内容生成专用会话）
- `ISSUE-081`（P2 家长 agent 上移：parent-registry.ts kind=`parent`/`parent-content` 持久落盘）
- 核对报告 `核对报告-用户说明书功能实现对照-2026-09-13.md` §17 #3（`parent_upsert_*` 未挂载，落库路径相关）
- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §8.1（已据实写成"共用同一 prompt，仅会话 key 与落盘目录不同"）

## 六、关键代码位置

| 项 | 位置 |
|---|---|
| 注释（声称专用提示词） | `src/components/TopicEditor.tsx:39` |
| prompt 构造函数（无 kind 分支） | `server/src/agent/parent-registry.ts:87-124` |
| 会话创建调用（统一 prompt） | `server/src/agent/parent-registry.ts:159` |
| 会话 key 隔离 | `server/src/agent/parent-registry.ts:55-57` |
| 落盘/流 key 隔离 | `server/src/agent/parent-registry.ts:175` / `routes/parent-agent.ts:68` |

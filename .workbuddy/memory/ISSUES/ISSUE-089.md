# [ISSUE-089] `parent_upsert_topic` / `parent_upsert_course` 已定义、已列白名单，但未加入工具 return 数组 → 家长 agent 无法落库主题/课程

- **类型**：功能缺口（prompt 指引与实际可用工具不一致）
- **优先级**：P1（家长 agent 被 prompt 明确要求调用这两个工具，实际调不到，功能等于不可用）
- **状态**：✅ 已解决（2026-09-14，`parent_upsert_topic` / `parent_upsert_course` 已加入 `createParentAgentTools` 的 return 数组）
- **记录时间**：2026-09-13
- **标签**：`parent-agent` `parent-tools` `parent.sqlite` `工具未挂载`

---

## 一、问题要点

家长 agent 的 system prompt（`buildServerParentPrompt`）里有一段专门的「**落库主题与课程（家长库真源）**」指令：

> - `parent_upsert_topic`：写主题（name 主键 + topic_key 目录名 + method/assess_method/progress）
> - `parent_upsert_course`：写课程（topic + title 联合主键 + sort_order/status/lesson_method/html_path/teaching_copy/assess_rubric）
> 覆盖前先 `parent_library_topics` / `parent_library_courses` 核对现有结构……

但代码现状是：

- **工具已定义**：`parent-tools.ts` 里有完整的 `upsertTopicTool` / `upsertCourseTool`（含 INSERT … ON CONFLICT 落库实现、activity-log 记录）。
- **名字已登记**：`PARENT_AGENT_TOOL_NAMES` 白名单里有 `parent_upsert_topic`、`parent_upsert_course`。
- **但未进 return 数组**：`createParentAgentTools` 最终 `return [...]` 里只有 `listTool / readTool / deleteTool / moveTool / putTool / topicsTool / coursesTool / imageTool / logTool / createProgrammingTool(...)` —— **没有这两个 upsert 工具对象**。

会话构建是 `tools: toolNames`（白名单）+ `customTools: 返回数组` 一起下发（`packages/agent-core/src/sessions.ts`）：**白名单里只是一个名字、没有对应的工具对象可绑定**，因此该工具实际不存在可调。

**后果**：家长说"帮我新建一个主题/加一门课"，agent 会按 prompt 尝试调用不存在的工具 → 调用失败（或直接被过滤看不到）→ 只能提示家长去 UI 操作。**通过对话落库主题/课程当前不可行**；活路径只有 UI 表单 → IPC → `parent-library.ts` → REST op `parent_lib.topics.upsert` / `parent_lib.courses.upsert`。

## 二、影响范围

- **家长 agent 能力**：与"课程设计"相关的对话式需求（建主题、加课、写教学文案/考核要点字段）无法闭环，而 prompt 还在指引 agent 用它。
- **一致性**：与 plan 域（study/life/exam 三域工具都完整挂载）不对称——同一批"设计后落库"的工具，只有主题/课程这两个漏挂。
- **文档**：技术实现文档 §3.1 / §3.4 / §17 #3 已如实记录该缺口。

## 三、修复方向（待实施，改动极小）

1. **把两个工具加进 return 数组**（一行两处）：`upsertTopicTool`、`upsertCourseTool`（放在 `coursesTool` 之后）。白名单已登记，无需改 `PARENT_AGENT_TOOL_NAMES`。
2. **顺手核对命名规范（ISSUE-084）**：若要统一 `parent_` 前缀语义，可考虑改名为 `parent_parent_lib_topic_upsert` 之类，但当前 `parent_upsert_topic` 已列白名单 + prompt 引用 + 已有实现，改名成本高于收益，建议**保持现名**。
3. **验证要点**：挂载后用真实家长对话跑一次"新建主题 + 加两门课"，确认 `parent.sqlite` 的 `topics` / `courses` 落库、且 `parent_library_topics` 能查到统计（`total/learned`）。
4. **可选增强**：`parent_upsert_topic` 目前不写 `method_spec`（考核方法结构化字段，由考核内容层维护），保持不写是合理的；但若家长希望 agent 能设置考核方法，需单独设计（关联 ISSUE-067）。

## 四、关联

- 技术实现文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §3.1（挂载工具 + 缺口警告）、§3.4（工具读写字段表）、§17 #3（缺口清单同条）。
- ISSUE-084（工具命名规范；本缺口涉及的两个工具命名保持不变）。
- ISSUE-067（考核内容结构化 / `method_spec`——与 `parent_upsert_topic` 不写 `method_spec` 相关）。
- 代码真源：`server/src/agent/parent-tools.ts`（定义 + 白名单 + return 数组）、`server/src/agent/parent-registry.ts`（`buildServerParentPrompt` 指令）、`packages/agent-core/src/sessions.ts`（`tools` / `customTools` 下发方式）。

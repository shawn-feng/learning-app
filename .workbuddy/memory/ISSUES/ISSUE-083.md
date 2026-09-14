# [ISSUE-083] agent 提示词不再对用户开放编辑与查看（仅存于系统内部）

- **类型**：需求 / 安全隐私
- **优先级**：已解决
- **状态**：✅ 已解决（2026-09-13）—— 已按方案 A（完全收敛到系统内部）实施
- **记录时间**：2026-09-13
- **标签**：`prompt` `隐私` `AgentPromptEditor` `家长` `孩子`

---

## 一、需求要点

1. **agent 的提示词不能展示给用户看**，但必须**保存在系统中**（服务端存储，非删除）。
2. **孩子的 agent 提示词同样不可展示**——理由是其内容包含大量系统相关信息（会话结构、工具调用约定、数据表结构、调度规则等），泄露给终端用户既无意义也存在信息暴露风险。
3. **结论性要求**：agent 的 prompt 不再允许用户**直接编辑**和**查看**，无论家长端还是孩子端。

本质：提示词从「用户可调的可配置项」降级为「系统内部实现细节」，由开发/运维侧维护，不再暴露任何 UI 入口。

## 二、当前现状（待关闭的缺口）

- 系统中存在**提示词编辑器（AgentPromptEditor）**，让家长可在设置页直接查看并编辑各 agent 的提示词。
- 提示词落库于 **agents.sqlite 的 prompts 表**（按 `agentKey` 存储用户覆盖版，与代码默认提示词合并后生效）。
- 当前家长端可编辑的提示词涵盖：通用家长助手、教学内容生成会话、孩子端主会话、场景课会话、考核 agent、编程 agent 等，其中**孩子端会话的默认提示词即含有系统级信息**（工具清单、数据表字段、会话 kind 约定等）。

因此，在需求落地前，存在「用户可读取/改写含系统信息的孩子端 prompt」这一现状，与需求相悖，需收敛。

## 三、影响范围

- **家长端**：移除设置页中 AgentPromptEditor 的「查看 / 编辑」入口（及相关的读、写提示词 REST 路由的客户端暴露）。
- **孩子端**：本就不应暴露提示词编辑（如已无入口则仅需确认），重点在确保孩子端 prompt 内容不以外显形式（如错误回显、调试输出）泄露给终端用户。
- **服务端**：提示词可继续以代码默认 + agents.sqlite 覆盖的形式存在；是否保留覆盖能力由后续讨论决定（见第四节）。
- **运维/开发侧**：提示词的维护改由代码仓库或受控配置承担，不再依赖终端 UI。

## 四、已实施（2026-09-13，采用方案 A）

- **家长端**：`src/pages/Dashboard.tsx` 移除顶部「家长 AI 提示词」按钮（`Bot` 图标）、`AgentPromptEditor` import、`agentPrompt` state 与底部弹窗（`Bot` import 一并清理，防 `noUnusedLocals`）。
- **孩子详情页**：`src/components/ChildDetailPage.tsx` 移除「🤖 AI 提示词」tab、`TABS` 数组项、`AgentPromptContent` import 与渲染块。
- **组件删除**：`src/components/AgentPromptEditor.tsx` 整文件删除。
- **数据保留**：提示词仍存服务端 `agents.sqlite` 的 `prompts` / `prompt_history`（方案 A：保留覆盖能力，仅供系统内部/运维经 db-op `agents.save` 写入），开会话时由服务端 `getAgentPrompt` 注入。
- **文档同步**：技术文档 §0.2、§2.1、§2.2、§2.4、§A.5 与 §14 架构图均已改为「系统内部维护、无用户 UI 入口」。

## 五、遗留（可后续清理）

- **IPC 层未清理**：`electron/preload.ts` 仍暴露 `agentsGet / agentsSave / agentsHistory / agentsRestore`，`electron/lib/ipc-handlers.ts` 仍有 `agents:get/save/history/restore` 四个 handler，`electron/lib/agent-prompts.ts` 仍导出 `saveAgentPrompt` / `listAgentPromptHistory` / `restoreAgentPromptVersion` / `prefetchAgents`。**渲染层（`src/**`）已无任何调用方**（仅陈旧构建产物 `src/out/` 残留旧引用），属死接口，待决定是否删除（保留 `fetchAgentPromptRemote` / `getAgentPrompt` 只读缓存仍需）。注意其安全性已由服务端收口：`agents.get/save` 均经 `scope` 校验（`parent` 的 `ref` 强制为当前家长 id、`child` 需 `assertChildOwned`），即使接口残留也不会越权。

## 六、关联

- `ISSUE-082`（家长 agent 提示词解耦偏差）—— 提示词结构本身的治理问题，与本 issue 的「是否对用户暴露」正交，但都指向提示词应进入受控维护。
- `agents.sqlite`（prompts 表，提示词真源）—— 位于服务端 `<dataDir>/agents.sqlite`（全局库），见技术文档 §2.3。
- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md`（§0.2 / §2.1 / §2.2 / §2.4 / §A.5 / §14）。
- 客户端只读缓存：`data/cache/agents-cache.json`。

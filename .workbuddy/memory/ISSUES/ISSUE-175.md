# ISSUE-175：家长/孩子 agent 统一的「自定义提示词层」——预设基底不可改，用户只可追加，UI 仅查看/编辑自定义部分

- **类型**：需求 / 架构（提示词分层机制统一 + 家长侧补齐）
- **需求（用户 2026-10-06）**：家长和孩子都需要一个**系统级的提示词自定义部分**——预设的系统提示词不能修改，用户（家长）可以增加自己的内容；**UI 上只可以查看和编辑自定义的提示词部分**（基底不可见、不可改）。
- **机制定调（三层边界，延续 ISSUE-083 的隐私边界）**：
  - **① 预设基底**：代码/服务端维护（含系统约定、工具清单、铁律），**不对用户暴露、不可经 UI 修改**；
  - **② 自定义追加层**：每个 agent（家长/孩子）各一份纯追加内容，存服务端 agents.sqlite（scope=`parent`/`child`，ref=对应 id），建会话时以固定小节标题**整段追加在 system prompt 末尾**（内容不变则前缀缓存不受影响）；
  - **③ 运行时注入**（档案/日期等系统拼装）不变。
- **现状盘点（2026-10-06）**：
  - ✅ **孩子侧已就位**（ISSUE-136 待拍板 #7，2026-09-28 落地）：孩子详情页「📝 自定义规范」（`ChildCustomRules`），scope=child/ref=childId，追加为「## 家长设定的额外规范」（`server/src/agent/prompt.ts:68`，session-registry 建会话读一次），50 版历史可回退，重开会话生效——**孩子侧即目标形态，无需改动**；
  - ❌ **家长侧缺位**：现状只有 ISSUE-144 P5 的「场景口径」（场景粒度覆盖技能正文，管"某场景怎么说"），**没有全局追加层**。旧通道残留：`agents:get` 对 scope=parent 返回空底稿（注释称"buildParentPrompt 会追加在默认后"是 Electron 时代语义）——服务端化后 `buildServerParentPrompt`（parent-registry.ts，签名 `{parentId, workspace, today}`）**不读取也不拼接**任何家长自定义层，即 UI 做了也没有注入点。
- **实施清单（家长侧补齐为主）**：
  1. **服务端注入点**：`buildServerParentPrompt` 读取 `getAgentPrompt(dataDir, "parent", parentId)`，非空时以「## 家长补充说明」小节拼在 system prompt 末尾（场景技能索引/铁律之后；getAgentPrompt 是同步本地缓存读，装配处已有缓存刷新链路，无网络阻塞问题）；
  2. **UI 入口**：设置页（`Settings`）新增编辑器，复用 `ChildCustomRules` 组件形态（可抽公共 `CustomPromptEditor`，scope 参数化，仅标题/说明文案不同）：只显示自定义部分、空底稿不预填基底、保存/清空/历史回退（agents.get/save/history/restore；parent scope 的 ref 由 IPC 层强制当前家长 id——既有逻辑）；文案注明"重开会话生效"；
  3. **语义厘清**（UI 文案 + 本 issue 记录）：「场景口径」管**某场景怎么说**（覆盖技能正文，按需 load_skill）；本层管**全局追加要求**（每轮都在 system prompt 里）——两者共存不互斥；
  4. **孩子侧**：零改动；顺手把 `ChildCustomRules` 抽成公共组件供两处复用（可选）。
- **回归**：家长未自定义 → system prompt 与现状逐字节一致（零回归）；自定义后新会话生效、旧会话不变；50 版历史可用；孩子侧行为不变；web 端（共享组件 + shim agents 域）同链路可用；ISSUE-083 边界不破（基底仍不对用户暴露）。
- **优先级**：中（机制补齐；孩子侧已验证可行，改动集中在家长侧一个注入点 + 一个设置页 tab）
- **记录时间**：2026-10-06
- **关联**：ISSUE-136 #7（孩子侧先例，即本 issue 目标形态）、ISSUE-144 P5（场景口径，与本层共存分工）、ISSUE-083（基底不可暴露的边界依据；旧统一编辑器 AgentPromptEditor 下线的由来）

## ✅ 已实施（2026-10-06，用户拍板「先把家长的自定义 prompt 段加上」）

**服务端**（`server/src/agent/parent-registry.ts`）：`buildServerParentPrompt` 签名加 `customNote?: string`——非空（trim 后）时以「## 家长补充说明」小节追加在 system prompt 末尾（工作原则之后），并注明「与上面的规则同样遵守（与铁律冲突时以铁律为准）」；`ensureEntry` 装配处读 `getAgentPrompt(deps.dataDir, "parent", parentId)` 传入（同步本地缓存读，无网络阻塞）。`parent`/`parent-content` 两 kind 共用此装配，均生效。

**客户端**：
- 新增 `src/components/CustomPromptEditor.tsx`：从 ChildCustomRules 抽象的通用编辑器（scope/refId/标题/说明/placeholder 参数化；保存/清空/历史回退/离线降级提示全套）；
- `ChildCustomRules.tsx` 改为其孩子侧薄包装（孩子详情页零改动）；
- 设置页（`Settings`）新增「自定义说明」tab（「场景口径」旁）：scope=parent、refId=""（IPC 层强制当前家长 id——既有逻辑），文案注明与「场景口径」的分工（全局要求 vs 某场景说法）与「重开会话生效」。

**验证**：`test/issue175-parent-custom-prompt.test.ts` 3 例全绿（未自定义→prompt 不含小节零回归、自定义→「## 家长补充说明」原样追加且位于基底之后、存过但清空→同未自定义）；issue144 场景技能 45 例不回归（48/48）；electron/web/server 三端构建过；web typecheck 基线持平。**踩坑**：Settings.tsx 注入的多行 placeholder 字面量（真实换行）导致 esbuild「Unterminated string literal」——需 `\n` 转义；期间该文件被并行会话（ISSUE-174 客户端）竞争写入覆盖过一次，修复用 node 正则对所有多行 placeholder 统一转义后稳定。

**状态**：本地工作树完成；**未部署**（家长侧注入点随下次服务端部署生效——当前 0.5.23 工作树还叠着 ISSUE-174 TokenHub 等并行工作，部署时机待统一拍板）。部署前家长无 UI 入口可写入 parent scope 内容（除运维 db-op），部署即安全。

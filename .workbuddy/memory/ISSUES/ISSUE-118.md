# ISSUE-118：调查——家长 agent 穿管 materials 时，创建好的 HTML 落到哪个目录（结论：三处落点，其中家长会话工作区一处不可穿管）

- **类型**：调查 / 缺陷候选（家长 agent 产出 HTML 的落盘位置收敛问题）
- **调查结论（2026-09-19 实证）**：家长 agent「创建 HTML 并穿管给孩子」的产物**有三个可能的落点**，取决于 agent 用的是哪个工具——其中一处（家长会话工作区）**不在 display_content 可引用范围内**，穿管会失败：
  1. **资料真源（正规主路径）**：`parent_put_material` 工具 → `putMaterial()`（`server/src/agent/parent-materials.ts:133`）→ **`<dataDir>/materials/<parentId>/<topic>/….html`**（topic 必须匹配 `^[a-zA-Z0-9_-]+$`，2MB 上限，写入即同步 materials 索引表 + activity-log）。
     本地实证：`server/data/materials/86a84278-c8ae-415e-8fbc-6140b1b7c88e/english/01-什么是英语/index.html`（珊珊家长，english/changjingyingyu 等多个 topic 共 10+ 门课页面）；另有大量测试家长目录（76 个，多为 `lunyu/tmp-课程.html`，测试污染）。
  2. **孩子工作区 outputs/**：孩子 agent（或家长 agent 明确写 `outputs/` 时）产出的工具/游戏类页面 → **`<dataDir>/workspaces/<parentId>/<childId>/outputs/….html`**。
     本地实证：`server/data/workspaces/86a84278…/1f050a7f…/outputs/论语子路篇第四章.html`、`test.html`。
  3. **家长会话工作区（⚠️ 不可穿管）**：家长 agent 会话 cwd = **`<dataDir>/workspaces/<parentId>/parent/`**（`parent-registry.ts` 头注释 + 实证）——agent 若用**通用 fs 写文件工具**（而非 `parent_put_material`）产出 HTML，文件落这里。
     本地实证：`server/data/workspaces/86a84278…/parent/学而篇第一二章背诵考核.html`、`test/test.html`——**实际发生过**。
     ⚠️ `display_content`（`display-tool.ts:56-61`）只认两种 source：`materials/`（家长资料库）与孩子工作区 `outputs/`——**家长工作区 `parent/` 目录不在校验范围内**，agent 把 HTML 写进自己的 cwd 后再 display 会报「资料不存在」，必须再搬进 materials 才能穿管。
- **穿管机制（不复制文件）**：`display_content` 工具按路径**读取文件正文**，随 SSE `display_content` 事件**内联推送**（`display-tool.ts:84`；多端同看、无需再拉文件，渲染失败走 materialsRefresh 兜底），并登记进孩子库 `display_contents` 表（path/title/source/content 全量入库，ISSUE-113 会话重进回填用）。孩子端拿到的是内容本体，没有第二份文件副本。
- **已核对的路径安全**：materials 读写均过 `resolveWithin` 沙箱 + `normalizeMaterialPath`（禁 `..` 段）+ topic 段白名单——三处落点均在 dataDir 内，无越界风险。
- **候选问题（待定夺，按优先级）**：
  - **P-a 家长工作区 HTML 不可穿管**：`display_content` 是否应兼容 `workspaces/<parentId>/parent/`（加第三种 source=parent-workspace）？还是靠工具引导/prompt 约束「产 HTML 必须走 parent_put_material」（更简单，但 agent 偶发仍会用 fs 工具写 cwd——实证已发生）？倾向后者 + display 报错信息里提示「家长工作区文件不可展示，请先移入资料库（parent_move_material 或 parent_put_material 重新发布）」。
  - **P-b 落点语义文档化**：三种落点的使用边界（共享资料 → materials；孩子个人工具页 → outputs；家长工作区 = 草稿区不可展示）目前只在工具 description 里零散提到，缺一处权威说明（MATERIAL-BRIDGE-PROTOCOL 或家长 agent prompt）。
  - **P-c 测试家长目录污染**：`server/data/materials/` 下 76 个目录绝大多数是测试家长（tmp-课程.html），无清理机制（低优先级，仅本地环境观感）。
- **优先级**：低-中（主链路 parent_put_material → display 正常工作；P-a 是偶发体验问题，有绕行方案）
- **记录时间**：2026-09-19

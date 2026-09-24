# ISSUE-138 · 孩子 agent 的工作区与文件能力（域 I：知道目录架构 + 能操作文件）

- **类型**：需求（提示词补一段 + 一处低风险实现调整；**不新增工具**）
- **描述**：让孩子端 agent 具备与家长侧**同构的文件操作场景**——**① 知道自己的工作区目录架构**（根在哪、`outputs/` 是什么、`scratch/` 与 `.pi/` 不能碰）；**② 有明确的"操作文件"场景与口径**（找我的产出 I3、存我的成果 I6、造页面并展示 I5）。核实结论：**工具早已齐备**（`read`/`write`/`edit`/`ls` 四件套 + `display_content` + `create_html_lesson`），**缺的是提示词里对目录的说明与场景动作定义**。
- **影响范围**：①`server/src/agent/prompt.ts` 的①基底（新增「我的工作区」通用段 + [域 I] 一节）；②**可选**：`server/src/agent/fs-tools.ts` 的 `ls` 过滤隐藏目录。**工具面、数据面、沙箱机制均不变。**
- **排查/修改入口**：
  - 提示词：`server/src/agent/prompt.ts`（孩子主会话/课程会话基底；工作区句在 `buildServerChildPrompt`，现为一句"你的工作区：X（read/write/edit/ls 只能在此目录内操作）"）
  - 文件工具：`server/src/agent/fs-tools.ts`（`createServerFsTools(workspaceRoot)` / `listTree` / `SERVER_FS_TOOL_NAMES`）
  - 工具装配：`server/src/agent/session-registry.ts`（`fsTools = createServerFsTools(paths.childWorkspaceDir(parentId, childId))`；场景会话**不给** fs 工具）
  - 路径沙箱：`packages/agent-core/src/paths.ts`（`childWorkspaceDir` / `childScratchDir` / `resolveWithin`）
  - 展示与产出：`server/src/agent/display-tool.ts`（按 `outputs/` 前缀判定孩子工作区）、`server/src/agent/programming-agent.ts`（孩子侧缺省 `outputs/<标题>.html`）
- **优先级**：中
- **记录时间**：2026-09-23
- **关联**：`docs/孩子使用场景梳理-2026-09-23.md`（域 I 表 + 「域 I 讨论」+ §6 硬约束 #12 + §8 #14）；`ISSUE-136`（提示词按场景整理，本条的两节属其增补）；`ISSUE-131`（家长侧工作区层级 P2 定稿，本条沿用同一层级）。

---

## 一、现状核实（工具齐了，说明没写）

| | 家长 agent | 孩子 agent |
|---|---|---|
| 文件工具 | `read` / `write` / `edit` / `ls` | **同一套**（`SERVER_FS_TOOL_NAMES = ["read","write","edit","ls"]`）|
| 根目录 | `workspaces/<pid>/`（= `paths.agentRoot`：`materials/`、`uploads/`、`scratch/`、各孩子目录都在其内） | `workspaces/<pid>/<cid>/`（= `paths.childWorkspaceDir`） |
| 越界防护 | `resolveWithin(root, rel)`：`..` 逃逸 / 绝对路径 / 符号链接外逃**一律抛错** | **同一实现**（一处防线覆盖四个工具） |
| 读取上限 | `MAX_READ_BYTES = 256KB`；写入 `MAX_WRITE_BYTES = 2MB` | 同 |
| 提示词描述 | 一句：「你的工作区：X（read/write/edit/ls 只能在此目录内）——用于放临时产出，正式资料请用 `parent_put_material` 发布到真源」 | **只有一句**：「你的工作区：X（read/write/edit/ls 只能在此目录内操作）」 |
| 场景会话 | — | 场景课会话**不装 fs 工具**（只有 `display_content` / `scene_command` / `get_date`） |

⇒ 结论：**"能操作文件"已成立**；**"知道目录架构"完全缺失**——模型只有一个绝对路径，不知道里面该有什么、产出该放哪、什么不该碰。

## 二、工作区实际结构（实测 `server/data/workspaces/<pid>/<cid>/`）

```
workspaces/<parentId>/<childId>/          ← 孩子 agent 的根（read/write/edit/ls 只在这棵树内）
├─ outputs/                                ← ★ 孩子的"作品柜"（产出位）
│   ├─ 论语子路篇第四章.html                  （create_html_lesson 孩子侧缺省 outputs/<标题>.html）
│   └─ test.txt
├─ scratch/.pi/…                           ← 编程 agent 运行区（paths.childScratchDir；自动生成，非学习产物）
└─ .pi/<childId>-main/                     ← 孩子自己的会话槽（agent 历史/上下文）⚠ 不是学习内容
```

三条要点：

1. **`outputs/` 是唯一正式产出位**：`create_html_lesson` 孩子侧缺省写 `outputs/<标题>.html`；`display-tool.ts` 也**按 `outputs/` 前缀**判定"这是孩子工作区里的文件"（其它相对路径按**家长资料库**解析）。
2. `scratch/`（`childScratchDir`）与 `.pi/`（`session-registry` 的 `agentDir = <workspace>/.pi/<slot>`）是**运行区 / 会话数据**，不是学习产物。
3. 现在提示词**一个字都没提这三层**。

## 三、缺口

| # | 缺口 | 性质 | 建议 |
|---|---|---|---|
| 1 | **目录架构不在提示词里**：模型不知道 `outputs/` 是产出位、不知道 `scratch/`+`.pi/` 不该碰 | 提示词（①基底） | 通用节新增「我的工作区」一段（见五） |
| 2 | **I3「找我的产出」没有提示词**：孩子问"我上次做的东西在哪"，模型可能凭记忆编、或忘了自己能用 `ls` | 提示词（①基底 [域 I]） | 新增 [域 I] · I3 一节 |
| 3 | **I6「存我的成果」根本没这条场景口径**：孩子说"帮我记下来/整理成清单"，落不落文件、落哪、怎么找回，全无说明 | 提示词（①基底 [域 I]） | 新增 [域 I] · I6 一节 |
| 4 | **`ls` 会把 `.pi/` 列出来**（实现级） | 代码（低风险） | `listTree` 跳过点号目录（或至少跳过 `.pi`）；提示词同时写明"运行区不要读" |
| 5 | **I1「看资料清单」对话里无出口** | 能力缺口（待拍板） | 若要支持，需新开**只读列举**（家长资料库）；**维持现状亦可** |

> 缺口 4 的风险两面：**上下文污染**（模型去 `read .pi/...jsonl`，把自己的会话历史/系统提示读回来，浪费预算且可能自相矛盾）+ **隐私面**（系统数据不是"孩子的作品"）。

## 四、有意边界（不是缺口，不要改）

| 边界 | 事实 |
|---|---|
| 孩子**不能浏览**家长资料库 | 无 `parent_list_materials` 一类工具（家长专属）；孩子侧只有 `parent_content`，且**必须按"主题 + 课程名"点名** |
| 孩子**不能读**资料文件内容 | fs 工具的根在孩子工作区，资料库在**另一棵树** |
| 孩子**不能写**资料库 | `create_html_lesson` 的 `materials/` 前缀是**家长侧**行为；孩子产出只能落自己 `outputs/` |

⇒ 与「资料真源由家长掌握」一致，**建议保持**。

## 五、建议的提示词（按 `ISSUE-136` 的三段式落地）

**[通用 · 我的工作区]**（新增一段，插在"数据规则"之后）

- 我的工作区在 `<绝对路径>`；`read`/`write`/`edit`/`ls` **只能在这个目录内**（越界会直接报错）。
- **产出的东西一律写到 `outputs/`**：这样孩子能在「我的文件」里找到、也能被 `display_content` 展示。`create_html_lesson` 不传路径时**默认就在 `outputs/`**。
- `scratch/` 与 `.pi/` 是**我的运行区**（程序生成的），**不要读、不要列、不要展示给孩子**。
- 数据（学习记录/进度/计划）仍然**只走数据工具**，不要用文件去记（文件只放"产物"）。

**[域 I] · I3 找我的产出**

- **孩子会说**：「我上次做的东西在哪？」「那个小游戏呢？」
- **怎么做**：先 `ls outputs/` 看**真实存在什么**（**不要凭记忆说**）→ 把文件名念给孩子让他选 → 若是 `.html`，用 `display_content`（path 传 `outputs/xxx.html`）**直接展示**。
- **边界**：`outputs/` 里没有就说没有，别编；不主动翻 `scratch/`、`.pi/`。

**[域 I] · I6 存我的成果**

- **孩子会说**：「帮我记下来」「整理成一份清单」「把这个存起来」
- **怎么做**：值得留存的（学习清单、总结、练习安排）才落文件：`write outputs/<名字>.md`；**落完告诉孩子存在哪、以后怎么找回来**（"存在「我的文件」里了，下次问我'我上次整理的清单'就行"）。
- **边界**：一次性闲聊/临时中间结果不落文件（避免 `outputs/` 变垃圾场）；正式学习记录仍走 `kb_insert`（文件≠数据真源）。

**[域 I] · I5 造页面**（已有，保持）：产出后用 `display_content` 展示给孩子。

## 六、待拍板

1. **目录架构现在写进基底吗**？（改完**必须重开会话才生效**，见文档 §2.4）
2. **`ls` 要不要默认跳过点号目录**（`.pi` / `.git` 之类）？——属实现细节，改动小、收益明确（防上下文污染），建议一并做。
3. **要不要给孩子开"列出资料清单"的只读能力**（I1 的对话出口）？还是维持"只按课程名取、要浏览去界面"？

## 七、验收

- [ ] 问"我上次做的东西在哪" → 模型**先 `ls outputs/`** 再看结果说话，不凭记忆编；
- [ ] 说"帮我整理成一份清单" → 落到 `outputs/*.md`，并告知存放位置；
- [ ] `ls .` **不再列出 `.pi/`**（若采纳缺口 4）；
- [ ] 模型**不会**尝试读/写家长资料库（尝试即报错，且提示词已劝阻）；
- [ ] 场景课会话行为不变（无 fs 工具，仍只展示）。

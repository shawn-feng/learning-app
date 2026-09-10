## [ISSUE-021] 孩子端学习资料列表：课名显示"未命名" + 重发资料不刷新/卡在别的课程

- **类型**：Bug / 数据展示 + 交互（孩子端左侧学习资料列表）
- **描述**：在 192.168.1.201（ubuntu）运行的孩子端 app、闻闻的会话里：① `display_content` 时左侧「学习资料」列表没有课程名，全是"未命名资料"；② 家长重新发送某课学习资料时，左侧不会自动显示最新重发的那份，仍停在别的课程的资料上。
- **现状 / 根因（已查证代码）**：
  - **列表 title 来源**：`MaterialsPanel.tsx:420` 渲染 `m.title || "未命名资料"`；`m.title` 来自 `display_content` 工具结果 `details.panelContent.title`（`custom-tools.ts:139`）。
  - **title 生成逻辑**：`custom-tools.ts:113/130` `titleBase = rest.replace(/\.[^.]+$/,"").split("/").pop()`（=资料文件名去扩展名），`title = params.title || titleBase`。即：仅当 agent 显式传 `title` 或文件名本身含可读课名时列表才显课名；否则是裸文件名，无意义/为空即"未命名资料"。
  - **课名未下传（核心 A）**：课程真实名称在 `courses.title`（`parent-library.ts:139` 等，`(topic,title)` 唯一），但 `display_content` 只接收 `path`（`<topic>/<file>.html`），**从不查 `courses` 取课名**下传给列表——系统知道课名却不传。若学习 agent 调 `display_content` 不带 `title`、且 html 文件名非课名（每课一子目录 / 按 id 命名），列表即全"未命名"。
  - **重发卡别的课程（核心 B）**：`Learn.tsx:226` 去重 `if (filePath && prev.some(m => m.filePath === filePath)) return prev`——同一课重发（path 相同）被整体丢弃，`materials` 引用不变 → `useEffect([materials])`（`:209`）不触发 → `setSelectedMaterialId(materials[materials.length-1].id)`（`:213`）不执行 → 选中项停在之前别的课程资料上；即便家长改了内容重发（同 path）旧内容也不更新。仅 path 不同（新课）才追加并自动选中——故"卡别的课程"正是**同 path 重发被去重**所致。
  - **⚠️ 环境差异（2026-08-31 用户补充）**：**该问题仅在 ubuntu（192.168.1.201）孩子端出现，Windows 本机 app 客户端不复现**。两条症状（"未命名" + 重发不跳最新）在 Windows 正常 → 强烈指向 **ubuntu 客户端跑的是滞后构建**：当前代码里 `titleBase` 文件名回退（`custom-tools.ts:130`）、`Learn.tsx:209` 自动选中 effect（ISSUE-014）、以及下文 ① 的 `courses.title` 下传修复若存在则 Windows 已含、ubuntu 未含。即：**根因大概率不是"代码永远错"，而是"ubuntu 构建没拿到这些已存在的修复"**。
  - **结论性排查顺序（必须先做）**：① 先核对 ubuntu 客户端版本/构建日期，确认是否含 `titleBase` 回退 + ISSUE-014 自动选中；② 若滞后 → **升级 ubuntu 客户端到当前构建并复测**，很可能直接消失，无需改代码；③ 若升级后仍在当前构建上复现 → 才是真代码 bug，按 ①② 改造方向修。
- **改造方向**：
  ① **课名下传**：`display_content` 解析 `path` → 按 `topic` + `html_path` 匹配查 `courses` 取 `courses.title` 作默认 `title`（agent 显式 `title` 仍优先）；或在 agent 系统提示/教学方法里要求展示课程必须带 `title=课名`。列表恒显课名。
  ② **重发刷新（关键约束）**：**禁止用"完全重复就不显示"的逻辑**。即使重发的内容与上一课 100% 相同（path 相同、内容 hash 也相同），左侧也必须自动把"最近一次 display_content 的那份"重新选中并显示在最前/最新位置，方便用户查看——即去掉 `Learn.tsx:226` 的"同 filePath 即 `return prev` 整体丢弃"，改为：命中同 path 时就地替换内容 + **无条件重新 `setSelectedMaterialId(该项)` 并滚动定位到该项**；新增资料照常追加末条并选中。去重只用于避免"同一轮消息内连续推送多份同 path 资料时堆积成 N 条"，不用于"跨轮重发时吞掉显示"。
  ③ **优先：升级 ubuntu 客户端核对（环境差异，最高优先级）**：Windows 不复现 → 先确认 192.168.1.201 ubuntu 客户端构建是否含 `titleBase` 回退 + ISSUE-014 自动选中 + ① 的 `courses.title` 下传；若滞后则**升级该 ubuntu 客户端并复测**，很可能症状直接消失、无需改代码。仅在升级后仍于当前构建复现，才推进 ① ② 代码修复。
  ④ **回归**：display_content 新教材自动弹开（ISSUE-014）、去重不堆积（`:224` 注释）、列表 title 渲染（`:420`）仍正确。
- **优先级**：已完成（2026-08-31 实施：① `custom-tools.ts` display_content 解析 `{topic}/{file}.html` 后按归一化 `html_path` 匹配查 courses 取 `title` 作默认（agent 显式 title 优先；先孩子库 `kb.courses.list` 再家长库 `parent_lib.courses.list`，匹配失败静默回退文件名）；② `Learn.tsx` handleToolEnd 去掉「同 filePath 即 return prev 丢弃」——同 path 重发改为**就地替换 content/title/time + 移到列表末尾（最新位置）+ 返回新数组引用触发自动选中**（满足「重发必须重新显示」约束，去重仅防同轮堆积）；③ `MaterialsPanel.tsx` HtmlFrame key 由 `html.length` 改为 `长度:内容hash`，同长度不同内容的重发也能重建 iframe 展示最新内容；④ ubuntu 环境差异核对结论：Windows 不复现→大概率滞后构建，需在 ubuntu 客户端升级到本构建后复测确认）
- **记录时间**：2026-08-31

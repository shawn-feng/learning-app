# ISSUE-178：编程 agent 沙箱只有 materials（够不着 uploads 等家长工作区）+ prompt 无路径事实 → 盲猜路径"扫描不存在目录"；PiBridge 协议已知但引用死链

- **类型**：设计确认 + 缺陷（能力边界未文档化 / prompt 缺环境事实 / 过时规则残留）
- **优先级**：高（「上传作业照片 → 编程 agent 做成互动资料」主流程卡在读不到图）
- **记录时间**：2026-10-10
- **来源**：用户让家长 agent 转述编程 agent「把 uploads 里的文件拷贝到 materials」，编程 agent 回复无权限、只能操作 materials 里的文件；且编程 agent 经常扫描不存在的目录。

## 问题一：编程 agent 能否操作家长工作区所有文件？——**不能，只有 materials 一棵树**

| 项 | 事实 | 代码 |
|---|---|---|
| 沙箱根（家长侧 parent_build_material） | cwd = `materialsRoot` = `workspaces/<pid>/materials`，会话以 cwd=base 创建 | `server/src/agent/programming-agent.ts:316`（resolveLessonOutputPath 家长分支 base=materialsRoot）+ `:366`（getProgrammingSession(deps, base, …)） |
| 工具面 | `tools: ["read", "write", "edit"]`——pi SDK 内置三件，全部限制在 cwd 内；**没有 ls**，无法列目录只能猜路径 | `programming-agent.ts:257` |
| 够不着的位置 | `workspaces/<pid>/` 下的 uploads/、scratch/、parent/、各孩子目录——全在 cwd 外，读/写一律被拒（用户看到的「无权限」） | 同上 |
| 输出路由 | 家长侧恒落资料真源（`<topic>/<file>.html`），设计如此 | `programming-agent.ts:307-318` |
| **不对称** | 孩子侧 create_html_lesson 的 cwd = **整个孩子工作区**（workspaceRoot），家长侧反而最窄 | `programming-agent.ts:320`、`:467-468` |

设计本意是「只做代码生成，输出恒落真源」（文件头 `:6-9`），但调用方（家长 agent）和用户都不知道这条边界——工具 description（`programming-agent.ts:477-480`）没说「编程 agent 读不到 uploads」。

**家长 agent 自己其实够得着 uploads**：家长 agent 的 fs 工具根 = `workspaces/<pid>` 整棵（`server/src/agent/parent-registry.ts:182-188`），P2 归并后 uploads 就在里面。但两条旧规则把它拦住了，见问题三。

## 问题二：prompt 是否知道 PiBridge 协议？——**知道，但引用了个死链**

`buildProgrammingPrompt()`（`programming-agent.ts:114-139`）：
- ✅ **PiBridge 协议完整在内**（`:131-139`）：emit/request/on/off、tts.speak 的 {ok}=已受理语义（勿自行排队）、lookup、`<meta name="pi-bridge" content="capture=manual">`、scene.* 下行/上行全家、action 命名规范——正文自足（"正文约定以上述为准"）。
- ⚠️ **死引用**：末尾写「完整协议规范见**仓库根** MATERIAL-BRIDGE-PROTOCOL.md」——文件实际在 `docs/MATERIAL-BRIDGE-PROTOCOL.md`；且嵌套会话 cwd=materials、无越界工具，**根本读不到仓库任何位置**。此引用对编程 agent 永远无效。
- ⚠️ **完全没有路径/环境事实**：prompt 不说「你的 cwd=资料真源根」「cwd 里有哪些 topic」「uploads 等区域你够不着」「要引用图先把文件转存进 `<topic>/media/`」。需求文本里家长 agent 传来的路径（uploads 路径、`materials/` 前缀路径、记错的扩展名）在 cwd 内对不上时，模型唯一能做的就是盲猜——下条的 9 连 ENOENT 就是这么来的。

## 问题三：「经常扫描不存在目录」——201 生产日志实锤（2026-10-09 17:41）

`journalctl -u learning-server`（ISSUE-172 P0 错误收集器的落痕）：

```
17:41:13 工具错误：read ENOENT …workspaces/<pid>/materials/files/ee3c8068-a43f-419a-bc61-99e7b336962f
17:41:13 工具错误：read ENOENT …materials/schoolwork/2026-10-09书写格式示例.jpg     ← 实际存在的是 .png！
17:41:13 工具错误：read ENOENT …materials/schoolwork/files/ee3c8068-…
17:41:18 工具错误：read ENOENT …materials/uploads/8f55dedd921ec918ba5861c1c0dfbfd6.jpg   ← 猜uploads前缀（cwd内）
17:41:18 工具错误：read ENOENT …materials/parents/8f55dedd….jpg                    ← 继续猜
17:41:18 工具错误：read ENOENT …materials/attachments/8f55dedd….jpg
17:41:18 工具错误：read ENOENT …materials/assets/8f55dedd….jpg
17:41:18 工具错误：read ENOENT …materials/files/8f55dedd….jpg
17:41:38 [programming-agent] 生成完成但过程有错误：…（非致命路径，本次侥幸出了文件）
```

三种盲猜形态全齐：① 猜目录前缀（uploads/parents/attachments/assets/files 一圈）；② **扩展名猜错**（`2026-10-09书写格式示例.png` 实际存在于 `materials/schoolwork/`，模型试的 .jpg → ENOENT）；③ 拿 uuid 落盘名当文件名找（uploads 区 uuid 命名、原名只在 files 表）。另注：`uploads/8f55dedd….jpg` 在 201 的 uploads/ 里已不存在（find 全树只命中 schoolwork png）——模型还在追一个已经不在的引用。

## 问题四（连带）：家长 agent 侧的过时规则与工具缺口

| 项 | 事实 | 代码 |
|---|---|---|
| **过时隔离规则** | materials 场景技能还写着「**资料真源与上传区是两个隔离区域**：不要自己拼路径、不要加 materials/ 前缀、**不要去试 uploads/**」——这是 P1 时代（uploads 在 files/<pid>）的规则；P2 归并后 uploads 就在家长 agent 的 fs 工具根内，此规则已失真，且直接导致家长 agent 遇到「用 uploads 里的图」时不敢自己动手/给不出正确路径，把活推给够不着的编程 agent | `server/src/agent/skills/parent/materials.ts:53` |
| move 工具沙箱窄 | `parent_move_material` 的 from/to 都走 `materialAbsPath`（materials 根沙箱），uploads→materials 移动不了 | `server/src/agent/parent-tools.ts:268-284` |
| 无二进制转存工具 | 家长 agent 的通用 fs 工具是文本向（read 截断 256KB、write 上限 2MB、utf-8），拷贝图片会损坏；网盘 `fsMove` 对 uploads 跨区移动也明确 400 | `server/src/agent/fs-tools.ts`（MAX_READ/WRITE）；`server/src/routes/fs.ts:678`「uploads 区原始件挂着 files 表登记，暂不支持跨区移动」 |

## 方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0) | 编程 agent prompt 补「环境事实」段：cwd=资料真源根（附当前 topic 清单或指示先 ls）、uploads/scratch/孩子目录**不可达**、引用外部文件要让调用方先转存进 `<topic>/media/` 并给 materials 相对路径；同时 `tools` 加 `ls`（SDK 内置），让它看目录而不是猜 | `programming-agent.ts:114-139`、`:257` | 消灭三类盲猜的土壤 |
| F2 (P0) | 调用方约定对齐：parent_build_material 工具 description + materials 场景技能补「引用上传文件 → 家长 agent 先转存到 `<topic>/media/`，需求里只给 materials 相对路径」；**改写 `materials.ts:53` 旧隔离规则为 P2 现实**（uploads 在家长 fs 工具根内，文本文件可直接读写；二进制转存走新工具） | `programming-agent.ts:477-480`、`skills/parent/materials.ts:36-53` | 家长 agent 不再把活推给够不着的下级 |
| F3 (P1) | 新工具 `parent_transfer_upload`（uploads→`<topic>/media/` 二进制转存：fs.copyFileSync + 原名保留映射 + files 表登记语义处理）；或放开网盘 fsMove 的 uploads 跨区限制（同步 files 表 stored_path）。与 ISSUE-124 F2「转存为资料」同源，agent 侧与网盘侧二选一对齐 | `parent-tools.ts` 或 `routes/fs.ts:678` | 补上「上传原始件 → 资料」的唯一正规通道 |
| F4 (P1) | 修死引用：prompt 末尾「仓库根 MATERIAL-BRIDGE-PROTOCOL.md」改删或改「docs/」（对嵌套会话都读不到，建议直接删引用保正文自足） | `programming-agent.ts:139` | 顺手项 |
| F5 (P2) | 需求路径预检：generateHtmlLesson 组 prompt 前对 requirement 中提及的相对路径逐个 `fs.existsSync`（在 base 内解析），不存在的连同「实际可用相近文件」一并列进 prompt，模型不再靠 ENOENT 试错 | `programming-agent.ts:368-379` | 锦上添花；F1 落地后价值下降 |

## 验证建议

- 家长 agent：「把 uploads 里那张图用到新资料里」→ 家长 agent 自己转存（或调 F3 工具）→ 需求里给 `materials` 相对路径 → 编程 agent read 成功，journal 无 ENOENT 连发；
- 编程 agent 生成前先 ls cwd（journal 可见 read/write/edit/ls 调用序列正常）；
- 引用 PiBridge 的页面照常上报（回归 MATERIAL-BRIDGE-PROTOCOL 用例）；
- 201 部署后重复 10-09 场景（schoolwork png 引用）确认扩展名/路径一次命中。

## ✅ 已实施（2026-10-10，F1~F4 全做 + F5 轻量版）

**F1 环境事实段 + ls**（`programming-agent.ts`）：`buildProgrammingPrompt` 尾部新增「## 环境事实」——cwd=资料真源根（第一层是 topic 目录）、动手前先 ls 看真实文件名（含扩展名）、uploads/scratch/parent/孩子目录不可达（引用外部文件让调用方先转存 `<topic>/media/`）、read 失败先 ls 核对不要连续猜、页面内引用同真源资源用相对路径；`tools: ["read","write","edit","ls"]`（SDK ls 工具已验证存在）。**F4**：死链「完整协议规范见仓库根 MATERIAL-BRIDGE-PROTOCOL.md」删除，改为「以上即完整协议（正文约定为准，无外部文档可读）」。

**F2 调用方约定**：`parent_build_material` description 加「重要边界」（只能读 materials、先 parent_transfer_upload 转存、requirement 只给资料真源相对路径）；`skills/parent/materials.ts` 的 P1 旧隔离规则**改写为 P2 现实**（uploads 在家长 fs 工具根内：文本可直读写、二进制走 parent_transfer_upload；给 build_material 只传真源相对路径）+ tools 清单/参数速查补新工具。

**F3 新工具 `parent_transfer_upload`**（`parent-materials.ts` 纯函数 `transferUploadMaterial` + `parent-tools.ts` 注册）：uploads→`<topic>/media/` **二进制拷贝**（copyFileSync，uploads 原件保留）——源新根优先旧根 files/<pid> 兜底；原名 files 表按 stored_path 回填（缺省落盘名）；toName 可选、拒路径段；目标已存在拒绝覆盖；toTopic 走既有 topic 校验。materials 无索引表（磁盘即真源），无登记负担。守卫归属 materials 场景（materialsSkill.tools + PARENT_AGENT_TOOL_NAMES），注册返回数组同步。

**F5 需求路径预检**（`probeRequirementPaths` 导出，generateHtmlLesson 组 prompt 时附加）：正则提取需求里的相对路径 → resolveWithin(base) 后逐个 existsSync → 「✓ 已核对存在 / ✗ 不存在+同目录实际文件名」附进 prompt（含 uploads/ 前缀猜错的路径——在 materials 基座内可解析必不存在，明确 ✗ 正是 201 盲猜形态的解药）。

**验证**：`test/issue178-programming-sandbox.test.ts` 4 例全绿（转存原名回填/bytes 一致/原件保留/不覆盖/穿越拒绝；预检 ✓✗/uploads 前缀明示/无路径空串）；issue144 49 例全绿（防拼错抓到漏注册 → 补 PARENT_AGENT_TOOL_NAMES；工具块预算 17000→17500 放宽注明 +transfer 工具）；issue131 17 例不回归；三端构建过。**踩坑**：bash 双引号/未引 heredoc 的反斜杠转义三次吃掉 `\n`/`\\`（Settings.tsx 同款教训）——python/node 注入一律用 quoted heredoc + Edit 工具收尾。

**待部署 201**（随下次服务端发版）：部署后重复 10-09 场景（schoolwork png）确认一次命中、journal 无 ENOENT 连发。

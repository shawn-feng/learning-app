# ISSUE-124：家长聊天框上传图片 → 家长 agent 读不到 uploads 目录，无法走视觉模型

- **类型**：bug（兼需求）
- **优先级**：高
- **记录时间**：2026-09-21
- **影响范围**：家长端「聊天框上传图片/文件」→ 家长 agent 无法读取并理解图片内容（如语文作业扫描页），整条「上传作业图 → agent 读图 → 转成课程/计划」工作流直接断在读取这一步。

## 现象（来自真实家长 agent 回复）

家长在聊天框上传了一张珊珊的语文作业图，agent 自查后回复：

> 根据附件路径，图片上传到了这个目录：`parents/86a84278-c8ae-415e-8fbc-6140b1b7c88e/uploads/`（家长上传区）
> 但我确认了一下，这个目录在我的访问范围之外，所以我读不到图里的内容：
> | 我能访问的区域 | 你的上传区 |
> | 课程资料真源（parent_read_material / parent_read_image 只认这里，如 lunyu/media/page1.jpg） | parents/<家长ID>/uploads/… |
> | 我的工作区 …/workspaces/86a84278-…/parent | 不在这里 |
> 刚才我已经把 parents/…、uploads/… 等路径都试遍了，都不在材料库里（返回「材料不存在」/「目录不存在」）。

→ 最终 agent 只能让家长用文字把作业内容发过来。

## 根因分析（已读源码定位）

**1. 上传落点（用户确认 + 代码印证）**
- 家长维度目录约定为 `<dataDir>/parents/<parentId>/`（见 `server/src/db/parent-lib.ts:3` 注释：`路径：<dataDir>/parents/<parentId>/parent.sqlite`）。
- 聊天框上传文件实际落在 `<dataDir>/parents/<parentId>/uploads/<file>`，即相对 dataDir 的路径 = `parents/<pid>/uploads/<file>`。
- 家长 agent 收到的附件路径就是这种带 `parents/<pid>/` 前缀的格式（回复已印证）。

**2. `parent_read_image` 已有「读上传图」分支，但路径解析写错（半成品 bug）**
位置：`server/src/agent/parent-tools.ts:1202`（工具定义）+ `:1212-1237`（execute）。
```js
const rel = String(params.path ?? "").trim();
if (rel.startsWith("uploads/") || rel.startsWith("files/")) {
  abs = resolveWithin(deps.dataDir, rel.replace(/^files\//, "files/"));   // ← 解析到 <dataDir>/uploads/<file>
} else {
  abs = materialAbsPath(ctx, rel);                                        // ← 材料库根 <dataDir>/materials/<pid>
}
```
两处错位：
- **前缀不匹配**：agent 拿到的路径是 `parents/<pid>/uploads/xxx.jpg`（带 `parents/<pid>/` 段），不以裸 `uploads/` 开头 → 走 `else` 分支，去**材料库**（`materials/<pid>` 根）找 → 必然「材料不存在」。
- **即使传裸 `uploads/xxx`**：`resolveWithin(deps.dataDir, "uploads/xxx")` 解析到 `<dataDir>/uploads/xxx`，**缺了 `parents/<pid>/` 一段** → 实际文件在 `<dataDir>/parents/<pid>/uploads/xxx` → 仍读不到（`fs.existsSync` 失败抛「图片不存在」）。

**3. 材料库工具也读不到**
- `parent_read_material` / `parent_read_image` 的材料库根 = `<dataDir>/materials/<parentId>`（`parent-materials.ts:10`），`uploads` 不在材料库内，所以这两个工具都够不着上传区。

**4. 视觉模型能力本身存在（只差把图喂进去）**
- `parent_read_image` 内部调 `describeImageViaVision`（`server/src/agent/vision.ts:62`），视觉模型链路已就绪；卡点纯粹是「前面的路径解析读不到 upload 文件」。

## 排查 / 修改入口

| 入口 | 位置 | 改什么 |
|---|---|---|
| 家长读图工具 | `server/src/agent/parent-tools.ts:1212-1237`（`parent_read_image` execute） | 支持 `parents/<pid>/uploads/`、`parents/<pid>/files/` 真实前缀；校验 pid==deps.parentId 防越权；解析用 `resolveWithin(deps.dataDir, rel)` |
| 材料库根 | `server/src/agent/parent-materials.ts:10` / `materialAbsPath` | 不改（uploads 本就不在材料库，属另一区） |
| 上传落点 | `parents/<pid>/uploads/`（前端/路由约定，全 server/src 未见 uploads 路由，疑在客户端直传 201 静态目录） | 确认 agent 收到的附件相对路径格式，确保与 read_image 识别前缀一致（端到端联调） |
| 视觉模型 | `server/src/agent/vision.ts:62` `describeImageViaVision` | 不动（已可用） |
| system prompt | `server/src/agent/prompt.ts`（parent 段） | 补「收到家长上传图片附件 → 直接 `parent_read_image` 传该附件相对路径（带 parents/<pid>/uploads/ 前缀）；读不到则提示家长用『转存为资料』或文字描述」 |

## 方案（建议）

- **F1（核心 bug 修复）**：`parent_read_image` 增补识别 `parents/<pid>/uploads/` 与 `parents/<pid>/files/`（对齐 agent 实际收到的路径格式），解析 `resolveWithin(deps.dataDir, rel)`；**强制校验路径里的 pid 等于 `deps.parentId`**，拒绝读别家家长的上传区（安全红线）。保留原有裸 `uploads/`/`files/` 分支（若另有调用方）但修正其缺 `parents/<pid>/` 段的问题，或统一改为「落在 `parents/<pid>/` 下即放行」。
- **F2（产品入口，需求）**：家长端加「转存为资料」——把 `parents/<pid>/uploads/<file>` move/copy 到 `materials/<pid>/<topic>/media/`，统一走材料库；agent 收到图片后可先建议/自动转存。对应 agent 回复里给家长的建议（「若家长端有转存为资料入口」）。
- **F3（prompt 引导）**：parent agent system prompt 补一段——收到家长上传图片附件时，直接 `parent_read_image` 传附件相对路径；若仍读不到，**不要**去试 materialAbsPath / 文件系统裸路径（如本次回复那样绕一圈失败），直接提示家长用「转存为资料」或文字描述。
- **F4（防回归）**：端到端联调——家长上传图 → agent 收到附件路径 → `parent_read_image` 读到 → `describeImageViaVision` 返回 → 能继续生成课程/计划。补一条冒烟用例覆盖「uploads 路径读图成功」。

## 现状小结

- **能读图+调视觉模型的工具是有的**：`parent_read_image`（→ `describeImageViaVision`），但当前因 uploads 路径解析 bug + 前缀不匹配，**读不到家长上传区**，所以这条链路断在第一步。
- `parent_db_*` / `parent_library_*` / `parent_read_material` 一律只认材料库/家长库，**碰不到** `parents/<pid>/uploads/`。
- 属「家长上传区与材料库是两个隔离区域、且读图工具没接上」的设计 + 实现缺口，优先级高（直接卡住「上传作业图」主流程）。

---

## 现场核实（2026-09-21，只读探针）

- 家长会话里的真实标记（`agent-sessions/<pid>/parent/*.jsonl`）：
  `【附件图片：微信图片_20260921154809_498_98.jpg|parents/86a84278-…/uploads/1789977385917-微信图片_….jpg】`
  —— 路径是**客户端本机**相对路径。同文件里还有 `files/86a84278-…/<stored>.webm` 与裸 uuid 形态的音频引用（Web shim / 旧路径），说明客户端形态并不统一。
- 服务端 `/opt/learning-server/data`：`parents/86a84278-…/` 只有 `activity-log.md + parent.sqlite`，**没有 `uploads/`**；`files/<pid>/` 里 186 个文件**全是 .wav/.webm 语音**（考试录音），没有任何图片。
- ⇒ **附件根本没到服务端**：本次故障不只是「路径解析写错」，而是「文件不在服务端」——只修 `parent_read_image` 的路径解析**仍然读不到**。

## 实施记录（2026-09-21）

| 改动 | 位置 | 说明 |
|---|---|---|
| **附件上送服务端** | `electron/lib/server-client.ts`（`uploadFileToServer`）+ `ipc-handlers.ts`（`file:save_upload_parent`） | 本机落盘后顺带 `POST /files/upload`，返回 `{path, ref('files/<id>'), uploadError}`；失败不阻断落盘（前端在输入框下方提示） |
| **标记用服务端引用** | `src/lib/attachment-ref.ts`（新）+ `ChatWindow.tsx` + `ParentChatPanel.tsx` | `attachmentMarker` 统一组装 `【附件图片：名\|引用】`，**ref 优先、path 兜底**；8 条 vitest 回归（含与历史恢复正则的对齐） |
| **引用解析（核心）** | `server/src/agent/upload-ref.ts`（新） | `resolveAttachmentRef` 三类引用：① 裸 uuid / `files/<id>` → 查主库 `files` 表 → `<dataDir>/files/<pid>/<stored_path>`；② `files/<x>`、`files/<自己pid>/<stored>` → 按磁盘布局（先按当前家长目录）；③ `uploads/<x>`、`parents/<pid>/uploads/<x>` → 本机上传区（同机部署才有）。**pid≠当前家长 → forbidden**；一律 `resolveWithin` 沙箱 |
| **工具接上** | `parent-tools.ts` | `parent_read_image` 改用解析器（引用形态优先，否则仍走材料库）；**新增 `parent_read_upload`**（非图片附件：文本类回正文 ≤200KB，图片提示改用 read_image，pdf 等二进制只回元数据）；两工具进 return 数组 + `PARENT_AGENT_TOOL_NAMES` 白名单 |
| **可执行口径** | `upload-ref.ts` `missingRemoteHint` | 读不到时明确「附件只在家长电脑上 → 请升级客户端后重发 / 改用文字截图」，并**明令不要再试 materials/uploads/parents 路径**（现场就是这么绕圈失败的） |
| **prompt** | `parent-registry.ts` | 新增「家长在聊天里上传的图片/文件（附件）」段：标记格式、哪个工具、不要自己拼路径、读不到就如实转述 |

**验证**
- 服务端 `tsc --noEmit` 0 错；`build.mjs` 通过（**v0.5.3**，产物含 `parent_read_upload` / `resolveAttachmentRef` / `missingRemoteHint`）
- 冒烟 `server/tmp-smoke-124.mjs` **30/30 PASS**：三类引用解析、越权拒绝（别人上传区 / 别人的 files id 查不到）、`files/<pid>/<stored>` 直写布局、图片提示改用 read_image、服务端缺失 → 可执行提示（含**现场同款旧路径**）、材料路径传错工具被纠正、pdf 元数据、大文本截断 200KB、`parent_read_image` 未再误判（材料库路径仍报材料侧错误）
- 客户端 `npm run build` 通过（`out/main/index.js` 含 `/api/v1/files/upload` 上送；renderer 含附件标记）；`npx vitest run test/attachment-ref.test.ts` **8/8**
- **待上线**：服务端 0.5.3 未部署 201；**客户端 0.1.20 已打包（Windows NSIS，2026-09-21 16:57）但未发布**——`dist-release-020/学习伙伴 Setup 0.1.20.exe`（171.6MB，asar 内已核实含本次改动、根 package.json=0.1.20；安装包签名状态 NotSigned，与 0.1.19 一致属既有状态）。**安装后本机附件才会被上送服务端**；不升级时服务端只能给出「请升级后重发」的提示。

## 关联缺口（另立 ISSUE-125）

**孩子聊天附件同款问题**：孩子端的 `【附件图片：…|children/<id>/uploads/x】`（`Learn.tsx` 剥掉 `children/<childId>/` 前缀）同样是**本机路径**，服务端孩子 agent 既没有读上传区的工具、客户端也不上送服务端；且 `POST /agent/:childId/prompt` 的 body 也只取 `{text, pageEvents, session}`，`images`（base64）**根本没被服务端消费**。未在本 issue 范围内处理。

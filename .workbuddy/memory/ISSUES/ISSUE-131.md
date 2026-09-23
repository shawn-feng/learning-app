# ISSUE-131：文件区统一为「单 agent 根 + 区域子目录」+ 前端网盘（家长/孩子双端）——实施方案定稿（2026-09-22 用户拍板四项决策）

- **类型**：架构 / 需求（含实施方案与回归清单；讨论脉络：ISSUE-123/124/118 + 2026-09-21~22 设计对话）
- **需求描述**：
  1. **物理归并**：`materials/<pid>/`、`files/<pid>/`、`workspaces/<pid>/…` 三分 → **单 agent 根 + 区域子目录**；uploads 并入 workspace（一个 fs 工具看全自己的文件，终结多工具多路径——ISSUE-124 路径形态混乱的根源）；
  2. **前端网盘双端**：家长端**和**孩子端都要有文件管理页（浏览/新建文件夹/重命名/移动/删除/上传到指定位置）。
- **✅ 已拍板（2026-09-22，原待定项全部定案）**：
  1. **materials 索引去掉**：materials 表是目录树纯镜像（id=base64url(相对路径)，无归属/无关联，materials.ts:100-140 全量重建），删表；列表=现场 walk（量级几百文件，重建函数本来就全量 walk）；courses.html_path 等外部引用语法不变（相对 materials 根的 `topic/file`，物理根变化由 materialAbsPath 单点吸收）；
  2. **家长网盘可管理孩子：可读可写**——家长文件管理的根 = `workspaces/<pid>/` 整棵树（含 materials/uploads/scratch 与所有孩子目录），对孩子目录有完全管理权；
  3. **孩子端也要有文件管理**：管理范围 = 自己的工作区 `workspaces/<pid>/<cid>/`（可读可写）；
  4. **层级定稿**：**家长工作区根 = `workspaces/<pid>/`，孩子工作区在其内** = `workspaces/<pid>/<cid>/`；**孩子 agent 的所有文件操作工具严格限制在自己目录内**（现状 childWorkspaceDir 即此语义，保留 + 加显式越权断言测试）。
- **目标布局（定稿）**：
  ```
  workspaces/<pid>/                ← 家长工作区根（家长 agent fs 工具根 + 家长网盘可见/可管范围）
    uploads/                       ← 家长上传原始件（原 files/<pid>/、parents/<pid>/uploads/）
    materials/                     ← 共享课程资产（原 materials/<pid>/…；受控写=putMaterial 语义；孩子端 display/读授权此子树；孩子 agent 不可见）
    scratch/                       ← 家长草稿/会话运行区（cwd、.pi/agent——不再污染资产区）
    <cid>/                         ← 孩子工作区（在家长根内；家长网盘完全管理；孩子 agent 唯一根）
      uploads/                     ← 孩子上传原始件（ISSUE-125 修复落点）
      outputs/                     ← 孩子生成物（display 可推；现有行为保留）
      scratch/                     ← 孩子会话运行区（考核 agent cwd 等）
  ```
  三态流水线：**uploads 原始件 → scratch 处理区 → materials 资产**；跨区 move/copy 按目标策略路由（进 materials = 转存语义，走 putMaterial 流程，保 courses.html_path 引用一致）。
- **关键机制事实（设计依据，已核实）**：①display_content 是服务端读正文内联推 SSE（display-tool.ts:84），前端不按物理路径读盘——materials 挪位置不影响机制，只影响来源白名单（display-tool.ts:57-74）；②materials 索引=纯镜像（决策 1 的依据）；③upload-ref.ts（ISSUE-124）已打通三类区域路径解析——统一视图雏形已在。

## 实施方案（三期，P1 零风险交付网盘，P2 动物理路径）

### P1 双端网盘（不动物理布局，先管理现有三区）
- **服务端 fs 管理路由**（`server/src/routes/fs.ts` 新文件）：
  - `POST /fs/list | mkdir | rename | move | delete | upload`（multipart）；
  - **scope 解析**：家长 token → 根 `workspaces/<pid>/`（整棵树含孩子目录，完全管理）；孩子上下文（parent token + childId + assertChildOwned）→ 根 `workspaces/<pid>/<cid>/`；
  - 全部 `resolveWithin` + `safeSegment`；materials 区写路由到 putMaterial 语义；**删除/移动 materials 文件前做引用影响检查**（R-1）；materials 索引表本期起停维护（P2 删表）。
- **家长端**：Dashboard 新增「文件」view：面包屑树 + 列表（名称/类型/大小/时间）+ 新建文件夹/重命名/移动/删除（带引用影响提示）/上传到当前目录/下载；孩子目录在树内直接可管。
- **孩子端**：Learn 左侧边栏新增文件管理入口（ISSUE-026 icon 弹框范式，root=自己工作区）：同套操作（简化 UI：上传/新建/重命名/删除/移动）。
- **P1 交付**：双端网盘可用，物理路径未动，现有功能零风险。

### P2 物理归并（新布局切换 + 兼容层）
- **paths.ts（唯一真源）**：新增 `agentRoot(parentId)`= `workspaces/<pid>`、`agentScratchDir` 等；`childWorkspaceDir` 语义不变（= agentRoot/<cid>，孩子 agent 工具根——**规则 7 的现状即目标**，补越权断言）；旧 materialsDir/filesDir 保留指向旧位置由兼容层兜底（或改指新位置，二选一在实现时定，倾向前者）。
- **写入点切换清单（12 项，漏一个即断链）**：
  | # | 位置 | 改动 |
  |---|---|---|
  | 1 | `routes/files.ts`（/files/upload） | 按 scope 落盘到 `workspaces/<pid>/{uploads\|<cid>/uploads}`；files 表登记不变，**旧行不迁移**靠 resolver 兼容 |
  | 2 | `electron/lib/ipc-handlers.ts` `file:save_upload_parent`（ISSUE-124） | 上送不变；本机缓存路径对齐（服务端为准） |
  | 3 | `upload-ref.ts` | 解析顺序**置顶**新位置（`workspaces/<pid>/{uploads\|<cid>/uploads}`）；保留 files/<pid>/、parents/<pid>/uploads/、裸 uuid 旧位置永久兜底 |
  | 4 | `parent-tools.ts` `parent_read_image`/`parent_read_upload` | 走 upload-ref 新位置；材料库分支随新根 |
  | 5 | `materialAbsPath`/`materialsRoot` | **根切换** → `workspaces/<pid>/materials/`（外部 `topic/file` 引用语法不变，全仓只允许此一处拼 materials 物理路径） |
  | 6 | `putMaterial`/`deleteMaterial` + 网盘 materials 写 | 写新根；**materials 索引表删除**（决策 1），list 改现场 walk（`db/materials.ts` walk 函数保留复用） |
  | 7 | `display-tool.ts:57-74` 来源解析 | 三源：家长 `materials/` 子树（孩子会话可解析——display/读授权放行，孩子 fs 工具仍不可写不可见）、孩子 `outputs/`、存量 `materials/` 旧路径兼容；source 字段兼容前端 |
  | 8 | `fs-tools.ts` 孩子 agent 工具根 | **维持 `workspaces/<pid>/<cid>/` 严格不变**（规则 7）；加显式越权断言：摸 `../materials`、`../uploads`、兄弟目录必须被拒 |
  | 9 | 会话 cwd 三处 → 各自 `scratch/`：`exam-engine.ts:268`（孩子考核）、`parent-registry.ts:229`（家长，根改 `workspaces/<pid>` 后 cwd 设 `scratch/`）、`programming-agent.ts`（agentDir/.pi 进 scratch——不再长进资产区，ISSUE-118 实证） | sessionKey 机制不变，「生成+改」上下文连续性保持 |
  | 10 | `page-tools.ts:95` ws 用途 | 核对后对齐新子区 |
  | 11 | 孩子上传链路（**ISSUE-125 本期收口**）：`ipc-handlers.ts:1846` `file:save_upload` + `Learn.tsx:1210` 标记 | 上送服务端 → 写 `<cid>/uploads/`；标记用 attachmentMarker（ref 优先） |
  | 12 | 家长会话根切换 | `parent-registry.ts` cwd `workspaces/<pid>/parent/` → 废除（新根即 `workspaces/<pid>`，运行区 scratch）——**旧 `workspaces/<pid>/parent/` 存量内容按需人工挪至 scratch/ 或 uploads/** |
- **存量数据**：不物理迁移——旧位置（files/<pid>/、materials/<pid>/、parents/<pid>/uploads/、workspaces/<pid>/parent/）靠 resolver/来源解析兼容层永久可解析；可选一次性迁移脚本后补。

### P3 收尾
- 旧目录只读退役；MATERIAL-BRIDGE-PROTOCOL / 家长与孩子 agent prompt 补新布局说明（吃掉 ISSUE-118 P-b）；兼容层保留期评审。

## 回归清单（改路径防断链 checklist）
- **R-1 引用影响检查**（网盘删/移 materials 文件前）：扫 `courses.html_path`、`material/send_material`、`display_contents`、考核计划 scope——命中列出并确认；
- **R-2 存量附件 ref**：`files/<id>`、裸 uuid、`parents/<pid>/uploads/…`、`children/<cid>/uploads/…`、`files/<pid>/<stored>` 历史引用全部可解析（兼容层）；
- **R-3 display 三源**：存量 materials 旧路径、孩子 outputs、新结构（家长 materials 子树）都能推；
- **R-4 html_path 语义**：`topic/file` 相对语法不变，旧值零改动有效；
- **R-5 考核录音**：audioFileId/speech_assessments 的 files 旧路径可读；
- **R-6 沙箱越权**：孩子 agent 工具摸 `../materials`、`../uploads`、兄弟 `<cid2>/` 必须被拒（规则 7 显式测试）；网盘 API A 家长摸 B 家长树被拒；孩子网盘 API 越过自己 <cid> 被拒；
- **R-7 编程 agent 连续性**：会话挪 scratch 后同 sessionKey「生成→改」上下文连续；`.pi` 不再出现在 materials/uploads；
- **R-8 网盘操作边界**：重名冲突、移动进自身子目录、删非空目录、materials 操作后磁盘即真源（无索引可漂移）；
- **R-9 旧客户端兼容期**：未升级客户端仍传旧位置 → 兼容层兜底 + 升级提示（missingRemoteHint 模式）；
- **R-10 索引摘除后**：GET /materials/list、agent 资料列表工具、资料下发链路改 walk 后行为等价（含软链目录——walk 已有软链处理注释，materials.ts:60）。
- 测试基线：现有 vitest 全量 + ISSUE-124 冒烟 30 + attachment-ref 8 + 新增 fs 路由用例（每操作 1 正 1 越权 1 边界）+ R-6 专项越权组。

## 实施顺序
P1 双端网盘（独立交付）→ P2 归并（需专门联调窗口，按 12 项清单逐项 + 回归组跑）→ P3 收尾。
- **优先级**：中（网盘是独立用户价值；归并是架构收益，需联调窗口）
- **记录时间**：2026-09-22（同日用户拍板四项决策：索引去掉/家长管孩子可读写/孩子端也要文件管理/层级 parent 根含孩子根 + 孩子 agent 严格限自己目录）

## ✅ P1 实施记录（2026-09-22，本机交付，未部署 201）
**服务端**（`server/src/routes/fs.ts` 新文件，index.ts 注册；server.cjs 构建过）：
- `POST /api/v1/fs/list|mkdir|rename|move|delete|refs|upload`（multipart）+ `GET /fs/download?path=&childId=&token=`；
- **scope 解析**：家长 token（childId 省略）→ 虚拟根 = `materials/`（→物理 `materials/<pid>/`）+ `uploads/`（→物理 `files/<pid>/`）+ 其余段（→物理 `workspaces/<pid>/…`，孩子目录全可管）；孩子上下文（token+childId+归属断言）→ 物理 `workspaces/<pid>/<cid>/`（无区映射）。P2 归并后映射在此单点塌缩；
- 全部 `normalizeRelPath`（拒 .. 段/反斜杠）+ `resolveWithin` 沙箱；R-6 越权组测试过（孩子摸 ../materials、../uploads、兄弟目录、别家 childId 归属断言全拒）；
- **materials 区 = putMaterial 语义**：topic 段（第一级）强制 `^[a-zA-Z0-9_-]+$`；上传/转存走 `upsertMaterialFile`；删/改名/移出先 **R-1 引用影响检查**（courses.html_path/material/send_material + 各孩子库 display_contents + 孩子库 exam_plans scope 三源），命中且未 `confirm:true` → 返回 `needsConfirm+refs` 短路（前端弹引用清单二次确认）；写删后 `scanMaterials` 现场重建索引 = 磁盘即真源（R-8 无索引漂移；索引表删除仍留给 P2）；
- **uploads 区 P1 收敛面**：uuid 落盘 + files 表登记（original_name 展示名），只开 list/upload/delete/download——改名/移动会扯断 `files/<id>` 引用语义（R-2），P2 归并到 `workspaces/<pid>/uploads/` 后放开；删除连 files 表行一起清（与 DELETE /files/:id 同语义）；
- R-8 边界：重名上传 409（`overwrite:true` 覆盖）、目录移进自身拒绝、`materials/`/`uploads/` 保留区根不可删改、家长根下不得新建同名区。
**客户端**：
- Electron：`electron/lib/server-client.ts` 增 `serverUploadWithFields`；ipc-handlers 增 `fs:list|mkdir|rename|move|delete|refs|upload|download_url` 透传（`{success,...}` 包装，needsConfirm 原样上浮）；preload 增 fsList/fsMkdir/fsRename/fsMove/fsDelete/fsRefs/fsUpload/fsDownloadUrl；
- Web：`web/src/shim/domains/fs.ts` 新域（http/uploadMultipart 同构实现 + `?token=` 下载直链），install.ts 接线（web-shim-coverage 覆盖测试要求 shim 同名实现，已过）；
- 渲染层：`src/components/FilesPanel.tsx` 双端共用（面包屑 + 列表[名/类型/大小/时间] + 新建/重命名/移动/删除/上传到当前目录/下载；materials 删改移先 fsRefs 预检弹确认，服务端 needsConfirm 兜底同弹）。**家长端**：Dashboard 侧边栏新增「文件」🗂️ view；**孩子端**：Learn 左侧 icon 栏新增「我的文件」FolderOpen 弹框（ISSUE-026 范式，root=自己工作区，UI 同套）。
**测试**：`test/issue131-fs-drive.test.ts` 16 用例全过（scope 解析/越权/三区操作/R-1 三源引用/R-8 边界）。全量 vitest：397 过，15 失败均属 8 个**基线（HEAD 干净树验证）同样失败**的既有文件（assess-guide/assessment/english-course-session/event-poll-config/kb-sqlite/page-bridge/sync/token-stats），与本次无关。server tsc、web/electron 构建全过。
**遗留（P2/P3）**：物理归并 12 项清单未动（本期零物理路径变更，现有功能零风险）；uploads 改名/移动、整目录转存进 materials、下载 Range 支持留待 P2 一并处理；201 部署待窗口。

**补记（2026-09-22 下午，本地实测反馈）**：①首测 404 根因 = 本地 dev server 是 `tsx src/index.ts`（非 watch）旧进程，未加载新路由——重启即好（已重启，PID 见 server-dev.log）；②家长虚拟根的孩子目录原样显示 uuid 没法管，补 `label` 映射：孩子目录=「<孩子名> 的工作区」、`parent`=「家长工作区」、`materials`=「课程资料库」、`uploads`=「上传原始件」（展示用 label，操作仍走 path），真实数据端到端验证过（materials 下 13 个 topic、孩子工作区 outputs/.pi 可浏览）。

## ✅ P2 物理归并实施记录（2026-09-22 用户拍板"现在就做"，本机已交付+真实数据联调通过）
**新布局（真实生效）**：`workspaces/<pid>/{materials, uploads, scratch, <cid>/{uploads,outputs,scratch}}`；孩子 agent 工具根严格维持 `workspaces/<pid>/<cid>`（规则 7 现状即目标）。
- **#0 paths.ts（唯一真源）**：新增 `agentRoot(pid)`=workspaces/<pid>、`agentScratchDir(pid)`、`childScratchDir(pid,cid)`；`childWorkspaceDir` 语义不变。
- **#5 materials 根切换**：`materialsRoot()` → `workspaces/<pid>/materials`（全仓唯一拼接点）；`legacyMaterialsRoot()`（旧 `materials/<pid>`）只读兜底；`resolveMaterialFile` 新根优先旧根兜底，覆盖 content 路由/doc 网关/display_tool/readMaterial。
- **#6 索引表删除**：db.ts 移除建表+迁移 DROP；`listMaterialsMeta` 现场双根 walk（新根覆盖同名、跳 .pi/node_modules/.git 运行时目录）；`diffMaterialIndex` 保持 /materials/index 响应形状（旧客户端同步不受影响）；routes/materials 与 parent-materials 全部去索引化；putMaterial/moveMaterial 写恒落新根（编程 agent"迁移即用"：目标只在旧根时先复制到新根再修改，单源写入点）。
- **#1/#3/#4 files 通道**：/files/upload 按 scope 落盘 `workspaces/<pid>/{uploads|<cid>/uploads}`（files 表登记不变）；`resolveStoredFileAbs`/upload-ref 新根优先旧根永久兜底（R-2/R-5：存量 files/<pid>、裸 uuid、parents/<pid>/uploads 引用全可解析）；`uploads/<name>` 引用加新根兜底。
- **#7 display 三源**：孩子 outputs（workspace）+ 家长 materials 新根 + 存量旧根（resolveMaterialFile），source 字段不变（前端零改动）。
- **#9/#12 会话 cwd 进 scratch**：exam-engine（考核）→ childScratchDir；parent-registry 家长根 → agentRoot（fs 工具/网盘同边界）、cwd/.pi → agentScratchDir；programming-agent agentDir → scratch/.pi（输出 base 不变，sessionKey 连续性保持——.pi 不再长进资产区，ISSUE-118 收口）。
- **#10 page-tools**：核对为仅错误提示文案引用工作区路径，孩子工作区语义不变，零改动。
- **#11 ISSUE-125 收口**：Electron `file:save_upload` 上送服务端（带 child_id → 落 `<cid>/uploads/`）返回 `files/<id>`；Learn 语音/图片/文件三处标记 ref 优先 path 兜底；web shim saveUpload 同步返回 ref。
- **网盘 fs.ts P2 化**：uploads 物理根迁 `workspaces/<pid>/uploads`（列表合旧根 files/<pid> 存量、files 表补名）；materials 列表/删/移双根化；uploads 区放开改名/移动/建子目录（files 行 stored_path 同步，跨区移动仍拒保 `files/<id>` 引用）；R-1 引用检查保留。
- **测试**：`issue131-fs-drive`（17）+ 新 `issue131-p2-merge`（10：R-2/R-3/R-5/R-6/R-9/R-10 + 双根合并/索引摘除）全过；issue118 回归更新到新根后 7/7；全量 vitest 417 过、15 失败=基线既有（干净 HEAD 比对过）。三端构建全过。
- **真实数据联调（201 本地镜像 server/data）**：materials 列表 12 旧 topic 可见、旧 html 经 /materials/content 200 可读、uploads 列出 91 个存量原始件（files 表补名）、新上传物理落 `workspaces/<pid>/uploads/<uuid>`、网盘删除连 files 行一起清、启动时 materials 索引表确认已 DROP。
- **遗留（P3）**：旧目录只读退役策略、MATERIAL-BRIDGE-PROTOCOL/agent prompt 补新布局说明、兼容层保留期评审；`workspaces/<pid>/parent/` 存量内容按需人工挪 scratch/。

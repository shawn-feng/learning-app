# ISSUE-079｜家长 agent 无法整理/治理服务端课程学习资料（缺 list/read/delete/move 的 agent 工具）

> **⚠️ 2026-09-12 19:55 形态变更（ISSUE-080 §七定案连带）**：用户已定案「agent 只在 server 端、client 不再有 agent、不要过渡」。因此本 issue 的方案 A（在**客户端**把服务端材料能力封装成 agent 工具）**不再作为落地形态**——家长材料工具将直接在 server 端实现、直调 handler（见 `DESIGN-server-agent-migration-2026-09-12.md` P2）。
> 本文件的**底层函数盘点（第二节）与存储真源分析仍然有效**（server 端函数 `materialsListRemote`/`readParentMaterial`/`deleteParentMaterial`/`uploadMaterialToServer` 就是 P2 要用的），继续作为 P2 的输入；第六节「待确认项」中的 delete 确认/dryRun/read 限流/路径白名单等决策项在 P2 依然要回答。
> 落地排期：并入 P2（ISSUE-081 之后的阶段）。

- **优先级**：高
- **记录时间**：2026-09-12
- **状态**：待处理
- **标签**：`家长agent` `学习资料` `SPLIT` `agent工具` `服务端真源`

---

## 一、现象（用户原话场景）

> 在家长 agent 里，让 agent 整理课程学习资料时，由于文件在服务端，agent 无法操作。
> 这个问题会影响家长 agent 做学习资料的能力。

具体表现：家长对 agent 说「帮我整理一下 lunyu 主题的资料 / 把散落的 html 归到 materials/lunyu/ / 删掉重复的那份 / 把这份改名」，agent 只能去动本地 `data/` 下的临时文件，**真正的课程学习资料（服务端真源）它既看不到、也改不了、也删不了**，于是「无法操作」，整理能力形同虚设。

---

## 二、根因（已定位，可直接执行）

**SPLIT 架构下，课程学习资料的唯一真源在服务端（云端/家庭主机），客户端只存临时副本；但家长 agent 工具集只暴露了一个能碰服务端的材料工具 `parent_upload_material`（上传），缺 list / read / delete / move 的 agent 工具封装。**

### 存储真源（服务端）
- `electron/lib/parent-library.ts`：
  - `getParentMaterialsDir()`（L93）注释写「父库共享资料目录（html 文件唯一副本，多孩子共享）」——但 `readParentMaterial`（L788）/ `fetchMaterialContent`（media-protocol.ts L51）实际都从服务端拉取（`media://` 代理 → `/materials/...`），本地 `data/parents/<pid>/materials/` 只是临时落盘。
  - 服务端底层能力**已存在**：
    - `materialsListRemote()`（L37）→ `GET /api/v1/materials/list`
    - `readParentMaterial()`（L788）→ 读服务端材料内容（IPC `parent:readMaterial`）
    - `deleteParentMaterial()`（L1026）→ `DELETE /api/v1/materials/:id`
    - `uploadMaterialToServer()`（L46）→ `POST /api/v1/materials/upload`（只能新增/覆盖写整文件，**无 move/rename 端点**）

### agent 工具缺口（关键）
- 家长 agent 注册的工具集：`electron/lib/pi-session.ts` L1069（通用家长会话）/ L1121（content 会话）完全一致：
  - `read/write/edit/ls` → 只作用本地 `data/` 文件系统（cwd=`data/`）
  - `move_file`/`copy_file`（`custom-tools.ts` L1248/L1281）→ 只作用本地 `data/`，`guardCwd` 限制在 data/ 内，**对服务端无效**
  - `parent_upload_material`（L835）→ **唯一碰服务端的材料工具**，但只能「把本地文件整体上传/覆盖写」到 `<topic>/<subDir>`，不能列、不能读内容、不能删、不能移动/改名
  - `parent_course_save` → 只登记 htmlPath 元数据
- **全代码库 grep 确认**：无 `parent_list_materials` / `parent_read_material` / `parent_delete_material` / `parent_move_material` 任何 agent 工具（底层函数与 IPC 有，唯独缺 agent 工具封装）
- IPC 通道其实齐了（`electron/lib/preload.ts` L244-253：`parentReadMaterial`/`parentListMaterials`/`parentListTopicMaterials`/`parentDeleteMaterial`；`ipc-handlers.ts` L573-627 都有 handler）——**说明"最后一公里"只是没把这些包成 agent 工具**

### 矛盾点（设计意图未落地）
- `pi-session.ts` L211 提示词写：「资料在服务端由 tools 管理（上传/替换/登记用 parent_upload_material + parent_course_save）；本地散放的临时文件移动/重命名/复制用 move_file / copy_file」——但"由 tools 管理"实际只实现了 **上传 + 登记**，缺 **list / read / delete / move** 四个必备管理动作，所以"整理"做不了。
- 服务端也没有 move/rename 端点（只有 upload/delete/list），要做"改名/归并到其他 topic"只能「下载→本地改→重新上传(新路径)→删旧文件」，而删旧文件又卡在缺 delete 工具。

---

## 三、影响范围

- 家长 agent 的「学习资料治理」能力缺失：无法去重、无法按主题归并目录、无法重命名、无法清理废弃页、无法把散落 html 统一进 `materials/{topic}/`、无法删除错误资料。
- 直接命中本次场景：让 agent「整理课程学习资料」→ agent 只能面向本地临时文件，动不了服务端真源 → 报"无法操作"。
- 间接放大 ISSUE-078（上传落 `parents/default` 而非登录家长目录）：整理时连"该整理哪个家长目录"都乱。

---

## 四、建议解决方案

### 方案 A（推荐，最小改动、补齐能力，不碰服务端）
把已存在于 `parent-library.ts` + IPC 的服务端材料能力，封装成家长 agent 工具（仿 `parentUploadMaterialTool` 写法，注册进 `pi-session.ts` L1069/L1121 的 `customTools` 数组）：

1. **`parent_list_materials`**（topic? / 可选 relPrefix）→ 列服务端材料树。封装 `materialsListRemote()` / `listParentTopicMaterials()`，返回现有文件与目录结构，让 agent「知道有什么」。
2. **`parent_read_material`**（topic + relPath）→ 读服务端材料内容到上下文。封装 `readParentMaterial()`（base64url id 解析同 `deleteParentMaterial`）。让 agent「能读内容、能改」。
3. **`parent_delete_material`**（topic + relPath）→ 删服务端材料。封装 `deleteParentMaterial()`。**危险操作：执行前必须向家长复述并征得确认**（参考 `parent_topic_save` 的"大改先确认"约定）。
4. **`parent_move_material`**（fromTopic/fromRel → toTopic/toRel）→ 服务端 move/rename。服务端无 move 端点时的实现：下载(from)→`parent_upload_material`(to)→`parent_delete_material`(from)。**更干净的做法是给 cloud-service 加一个 `POST /api/v1/materials/move` 端点**（见方案 C）；先用组合顶上，端点另开。
5. **提示词修正**（`pi-session.ts` L211）：明确 `move_file`/`copy_file` 只管本地临时文件；真源整理用上述 `parent_*` 工具，避免 agent 误用本地工具去"整理"服务端。

### 方案 B（收敛式，不改架构）
把所有"整理"动作规定为「下载到本地 → 本地 `edit`/`move_file` → 重新 `parent_upload_material` → 必要时 `parent_delete_material`」。但 delete/list/read 工具仍是前置（同 A 核心），所以 A 是 B 的基础，B 是 A 之上的流程约定。

### 方案 C（架构层，不推荐作本 issue 解法）
把"资料编辑真源"也放回本地、服务端只做同步/分发（回归旧一体化思路）。动摇 SPLIT 根基、波及面大，仅作长期备选，不在本 issue 实施。

**推荐落地顺序**：A-1(list) + A-2(read) + A-3(delete) 优先（让 agent 能看见/读/删真源）；A-4(move) 用组合先顶上，需要服务端 move 端点再开单独 issue。

---

## 五、排查 / 修改入口（可直接执行）

| 动作 | 文件 : 行 / 函数 | 现状 |
|---|---|---|
| agent 工具注册 | `electron/lib/pi-session.ts` L1069、L1121（`tools` + `customTools` 数组） | 缺 list/read/delete/move 四项 |
| 上传工具（范本） | `electron/lib/custom-tools.ts` L835 `parentUploadMaterialTool` | 可照此写新工具 |
| 本地 move/copy（仅本地） | `electron/lib/custom-tools.ts` L1248 `moveFileTool`、L1281 `copyFileTool` | 仅 data/，对服务端无效 |
| 服务端 list | `electron/lib/parent-library.ts` L37 `materialsListRemote`、L984 `listParentTopicMaterials` | 已有 |
| 服务端 read | `electron/lib/parent-library.ts` L788 `readParentMaterial` | 已有 |
| 服务端 delete | `electron/lib/parent-library.ts` L1026 `deleteParentMaterial` | 已有 |
| 服务端 upload | `electron/lib/parent-library.ts` L46 `uploadMaterialToServer` | 已有（无 move） |
| IPC 通道 | `electron/lib/preload.ts` L244-253；`ipc-handlers.ts` L573-627 | 已有（read/list/listTopic/delete） |
| 提示词修正 | `electron/lib/pi-session.ts` L211 | 写明本地 vs 服务端工具的分工 |
| 服务端 move 端点（可选） | cloud-service `/api/v1/materials/*` | 当前无 move，待加 |

---

## 六、待确认项（留实施者/用户拍板）

1. `parent_delete_material` 的"危险操作确认"强度——是否要求 agent 每次删除前显式问家长（建议是，且建议加 `dryRun` 清单能力：先列要删的、确认后再删）？
2. 服务端是否要新增 `POST /api/v1/materials/move` 端点（干净 rename/move），还是先用"下载+重传+删旧"组合（A-4 默认）？
3. `parent_read_material` 读取内容是否要限制大小/类型（html/md 文本可读，音视频只返回元数据不返正文），避免大文件灌爆上下文？
4. 与 ISSUE-078 的联动：整理前是否应先修"上传落到登录家长目录"（否则 agent 整理的是 `default` 目录资料，与当前家长不一致）？
5. 服务端 `/materials/list` 是否按 `parentId` 隔离返回（确认 list 结果不会把别的家长的资料列给当前家长 agent）？

---

## 七、关联

- 关联 ISSUE-078（家长上传落 `parents/default` 而非登录家长目录，整理对象会错乱）
- 关联 `pi-session.ts` L211 提示词「资料在服务端由 tools 管理」设计意图未完整落地
- 关联 SPLIT 架构（`SPLIT-REQUIREMENTS.md` / `MATERIAL-BRIDGE-PROTOCOL.md`）

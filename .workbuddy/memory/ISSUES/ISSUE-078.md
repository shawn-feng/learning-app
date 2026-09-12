# ISSUE-078｜家长端上传文件后，家长 agent 读不到（【附件文件】标记路径被错误剥前缀 + parentId 未透传）

- **优先级**：中
- **记录时间**：2026-09-12
- **状态**：✅ 已实施（2026-09-12，待用户实测）
- **提出人**：用户（实测：家长上传文件后，家长 agent 一开始找不到文件，后来才找到）

## 现象

家长在聊天框上传文件（txt/md/pdf/图片等）后，消息里带上 `【附件文件：文件名|路径】` 标记发给家长 agent。
agent 第一轮按标记去读文件 → **报「找不到文件」**；第二轮（agent 用 `ls parents/<pid>/uploads/` 或按提示词猜全路径 `parents/<pid>/uploads/xxx`）才命中真实文件 → 「后来找到」。

表现成「时灵时不灵」，根因是标记里的相对路径指向了错误目录。

## 根因（两层，互相叠加）

### 根因 A（直接原因）：`toRel` 把 `parents/<pid>/` 前缀错误剥掉
- `src/components/ParentChatPanel.tsx:241`：
  ```js
  // 家长 agent cwd = data/，却把 parents/<pid>/ 前缀剥掉 → 标记变成 uploads/xxx
  const toRel = (p?: string) => (p ? p.replace(/^parents\/[^/]+\//, "") : "未保存");
  ```
- 主进程 `file:save_upload_parent`（`electron/lib/ipc-handlers.ts:2023-2047`）返回的路径是
  `parents/<pid>/uploads/xxx`（相对 `data/`）。
- 家长 agent 会话 cwd = `data/`（`electron/lib/pi-session.ts:1035 / 1058 / 1099 / 1116` 均为 `cwd: dataDir`）。
- 于是标记变成 `【附件文件：文件名|uploads/xxx】`，agent 按 cwd=`data/` 去读 `data/uploads/xxx`
  —— **该目录不存在**，真实文件在 `data/parents/<pid>/uploads/xxx`。→ 第一轮找不到。
- 对照孩子端（正确）：`src/pages/Learn.tsx:1177` `toRel` 剥 `children/<id>/` → `uploads/xxx`，
  而孩子 cwd = `data/children/<id>`（`pi-session.ts:704/746/841/857`），解析正确。**家长端是单侧写错。**

### 根因 B（连带）：家长聊天没把登录家长 id 透传，上传全落到 `parents/default`
- `src/components/ParentChatPanel.tsx:337` 渲染 `<ChatWindow ... owner="parent" />`
  **未传 `parentId` 属性** → `ChatWindow.tsx:178` `const pid = parentId || "default";` → `pid` 恒为 `"default"`。
- 所以家长聊天上传**全部落到 `data/parents/default/uploads/`**，而非登录家长的真实目录。
- 磁盘实证（`data/parents/`）：
  - `86a84278-c8ae-415e-8fbc-6140b1b7c88e/`（登录家长真实 id，13 文件）
  - `default/`（13 文件）
  - `_guest/`（1 文件）
  - `data/parents/default/uploads/` 真实存在 10 个文件，含家长刚传的 `1788333902593-论语原文.txt`、`1788334444253-教学文案生成要求.txt`、多个 mp4、`index.html`。
  - `data/.session.json`：`{ "parentId": "86a84278-c8ae-415e-8fbc-6140b1b7c88e" }`（已登录真实家长）。
- 即：家长 agent 提示词（`pi-session.ts:181`）写「read `parents/「当前家长」/uploads/`」，agent 以为在当前家长 `86a84278-…` 目录下找，
  但实际文件在 `default` 下；再叠加根因 A 的 `uploads/xxx` 错误路径 → 最终去找 `data/uploads/xxx`（不存在）。

### 代码与注释自相矛盾（需清理）
- `electron/lib/config.ts:37-38` 注释：「未登录 = 无任何家长数据…`default` 已废弃」。
- 但 `parent-library.ts:78` `DEFAULT_PARENT_ID = "default"` 仍是大量函数兜底参数，且
  `delivery.ts:103`、`custom-tools.ts:152`、`material-doc.ts:54`、`programming-agent.ts:200`
  **显式用 `DEFAULT_PARENT_ID`** 写 `data/parents/default/`。`config.ts` 那条「default 已废弃」注释已与代码事实不符。

## 影响

1. 家长上传文件 → 家长 agent 第一轮读不到，需二次交互才能命中（核心「上传→问 agent」链路破损）。
2. 家长聊天上传未按登录家长隔离：全部进 `parents/default`，违反 ISSUE-044「按家长隔离」的初衷，
   多家长同机时聊天上传会混在 `default` 下（当前单机单家长故未暴露，但隔离是破的）。

## 排查 / 修改入口（可直接执行）

| 位置 | 说明 |
|---|---|
| `src/components/ParentChatPanel.tsx:241` | `toRel` 剥 `parents/<pid>/` → **应改为透传**（见下修复） |
| `src/components/ParentChatPanel.tsx:337` | `<ChatWindow>` 未传 `parentId` → 应传 `getCurrentParentId()`（修复隔离） |
| `src/components/ChatWindow.tsx:178` | `pid = parentId \|\| "default"`（透传后此处即真实 id） |
| `electron/lib/ipc-handlers.ts:2023-2047` | `file:save_upload_parent` 返回 `parents/<pid>/uploads/xxx`（正确，无需改） |
| `electron/lib/pi-session.ts:1035/1058/1099/1116` | 家长 cwd = `dataDir`（正确，无需改） |
| `electron/lib/pi-session.ts:181` | 提示词 `parents/「当前家长」/uploads/`（与全路径标记一致，无需改） |
| `src/pages/Learn.tsx:1177` | 孩子端 `toRel` 剥 `children/<id>/`（正确，**勿动**） |

## 修复建议

1. **最小修复（修根因 A，解决「找不到文件」）**：`ParentChatPanel.tsx:241` 改为
   ```js
   // 家长 agent cwd = data/，saveParentUpload 已返回相对 data/ 的全路径，直接透传
   const toRel = (p?: string) => (p ? p : "未保存");
   ```
   图片 `【附件图片】` 走同一 `toRel`，一并修好。

2. **隔离修复（修根因 B，建议同批）**：`ParentChatPanel.tsx:337` 给 `<ChatWindow>` 加 `parentId={getCurrentParentId()}`
   （renderer 需从 `window.api` 取当前 parentId，或父组件已持有），使上传落到登录家长真实目录，
   与 `pi-session.ts:181` 提示词「当前家长」一致，落实 ISSUE-044 家长隔离。

3. **文档清理**：`config.ts:37-38`「default 已废弃」注释与事实不符，修复后改为描述真实行为
   （default 仅作未传 parentId 时的兜底落盘目录，非「已废弃」）。

## 待确认项（留给实施者 / 用户拍板）

1. 修复 B（透传真实 parentId）后，**历史已落在 `data/parents/default/uploads/` 的文件是否迁移**到登录家长目录？
   当前单机单家长，可保留 `default` 作为默认家长目录、不清迁移；多家长上线时才需迁移。
2. `parent/default` 是否继续作为「默认/兜底」家长目录长期使用，还是彻底改为按登录 id 隔离、
   删除 `default` 兜底？取决于多家长需求是否上线。
3. 修复 B 需 renderer 能拿到当前 parentId：确认 `window.api` 是否已暴露 `getCurrentParentId`，
   没有则在 preload/ipc 加一个只读通道（不建议把 `.session.json` 直接读逻辑塞进渲染端）。

## 关联
- ISSUE-044：家长上传归家长库、与孩子隔离（本 issue 发现「家长之间」也未隔离，全落 `default`）。
- 同族对照：孩子端 `Learn.tsx:1177` 路径处理正确，本 bug 仅家长端 `ParentChatPanel.tsx:241`。

## 修复记录（2026-09-12）

按修复建议 1+2+3 全部实施，采纳「待确认项 1」当前方案（default 保留为兜底，不迁移历史文件）：

1. **根因 A（找不到文件）**——`src/components/ParentChatPanel.tsx` `toRel` 改为**全路径透传**：
   `const toRel = (p?: string) => (p ? p : "未保存")`。家长 agent cwd=`data/`，
   `saveParentUpload` 返回的 `parents/<pid>/uploads/xxx` 即相对 cwd 的正确路径；
   【附件图片】/【附件文件】共用 toRel 一并修好。
2. **根因 B（隔离失效）**——新增只读 IPC 通道把登录家长 id 透传给 renderer：
   - `electron/lib/ipc-handlers.ts`：新增 `session:get_parent_id` → `{ success, parentId: getCurrentParentId() }`（getCurrentParentId 原已 import，无需改 import）。
   - `electron/preload.ts`：新增 `getSessionParentId()`。
   - `src/components/ParentChatPanel.tsx`：mount 时取 `parentId` 存 state（失败静默保持 ""），
     `<ChatWindow parentId={parentId} ...>` 透传；ChatWindow `pid = parentId || "default"` 兜底不变。
     上传/打开/读取附件随之落到 `data/parents/<登录家长>/uploads/`，与 `pi-session.ts:181` 提示词「当前家长」一致。
3. **文档纠偏**——`electron/lib/config.ts:34-42` 注释改写：`default` 并未废弃，
   是未显式传 parentId 时的兜底落盘目录（与 parent-library/delivery/custom-tools 现状一致）。

**待确认项裁决（用户既有意向推断）**：历史 `parents/default/uploads/` 文件**不迁移**（单机单家长）；
`default` 长期保留为未登录/未拿到 id 时的兜底目录。多家长上线时再评估迁移。

**验证**：`electron-vite build` 通过（renderer+main+preload 全量打包无错）；
本 workspace `node_modules/typescript/lib` 缺失全部 `lib.*.d.ts`（既有环境问题），tsc 独立类型检查不可用，以构建验证为准。
**待用户实测**：登录家长上传 txt → 第一轮 agent 直接按标记路径读到文件；文件落 `parents/<真实pid>/uploads/`。

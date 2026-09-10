## [ISSUE-057] 家长端删除孩子：该孩子 uuid 目录（本地 + 服务端真源）未清理
- **类型**：Bug（删除不彻底 / 孤儿数据残留）
- **现象**：家长界面删除一个孩子后，`data` 目录里以该孩子 `uuid` 命名的文件夹没有被删除（本地 `data/children/<uuid>` 残留；SPLIT 下服务端真源的孩子数据也残留）。
- **当前删除链路（已读代码）**：
  - 前端：`src/components/ChildDetailPage.tsx:60-71` `handleDeleteChild` → `window.api.childDelete(child.childId)`。
  - IPC：`electron/lib/ipc-handlers.ts:269-272` `child:delete` → `deleteChild(childId)`。
  - 客户端删目录：`electron/lib/child-auth.ts:323-337` `deleteChild` —— `fs.rmSync(getChildDir(childId), {recursive,force})`（`getChildDir`=`data/children/<uuid>`，见 `electron/lib/config.ts:73`），随后调服务端 `DELETE /children/:id`（失败仅跳过）。
  - 服务端删行：`server/src/routes/children.ts:169-179` `DELETE /children/:id` —— **仅 `DELETE FROM children WHERE id=?` 删 DB 行**，注释明示「kb 文件本期保留（防误删学习数据）」，**不做物理删除**。
- **根因（两处缺口）**：
  1. **本地竞态（client）**：`deleteChild` 删目录前**未 dispose 内存会话**——`pi-session.ts` 的 `activeSessions` 里该孩子的主会话 + 各课程子会话（`key=childId` / `childId|courseKey`）仍驻留；若删除时孩子会话活跃或删除后任何代码路径触碰 `getChildSession/createChildSession`/`SessionManager` 落盘，会**重建 `data/children/<uuid>/.pi/agent/sessions/...`**，表现为「删了又回来/删不干净」。
  2. **服务端真源不清理（SPLIT 主因）**：服务端按 `childId` 散存多处真源数据，但 `DELETE /children/:id` 一个都不删：
     - kb：`server/src/db/kb.ts:3` `<dataDir>/kb/<parentId>/<childId>.sqlite`（`openKb`，backup.ts:216/260 同路径）。
     - 会话：`server/src/db/sessions.ts:13-14` `<dataDir>/sessions/<parentId>/<childId>/`（`getSessionsDir`）。
     - 资料：`server/src/db/materials.ts:38` `<dataDir>/materials/<parentId>/<topic>/...`（该孩子名下资料文件）。
     - 此外 `courses`/`daily_entries`/`todo_items`/`study_plan_items`/`exam_*` 等表里的孩子行也残留。SPLIT 下服务端是真源，这些 uuid 关联产物全部变成孤儿。
- **修改入口 / 修复方向**：
  - **客户端（防竞态）**：`electron/lib/child-auth.ts:323` `deleteChild` 在 `fs.rmSync` **之前**，先 `disposeChildSession`/清空 `activeSessions` 中所有 `key` 以 `childId` 开头（主+`childId|*` 课程子会话）的条目并 `await` flush，杜绝重建。
  - **服务端（清真源）**：`server/src/routes/children.ts:169` `DELETE /children/:id` 删行后，物理清理：
    - `fs.rmSync(path.join(dataDir,"kb",parentId,\`${id}.sqlite\`),{force:true})`；
    - `fs.rmSync(path.join(dataDir,"sessions",parentId,id),{recursive,force:true})`；
    - 该孩子 `materials` 子树（先查 `materials` 表取其 `rel_path` 逐个 `unlink`，再删表行），参考 `materials.ts:160-163` 的单条删法；
    - 联动删 `courses/daily_entries/todo_items/study_plan_items/exam_*` 中 `child_id=id` 的行（或保留表行仅标孤儿——但目录与 kb 必须物理删）。
  - 删前可加二次确认已在 `ChildDetailPage.tsx:61` 的 `confirmDialog` 层（文案已写「不可撤销」），无需再加。
- **优先级**：高（删除不彻底 → 本地/服务端累积 uuid 孤儿目录与 kb，既占空间又可能在重新建同名 uuid 时串数据；SPLIT 下服务端真源残留是主因）
- **记录时间**：2026-09-06

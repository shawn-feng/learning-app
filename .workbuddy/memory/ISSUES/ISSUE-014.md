## [ISSUE-014] 孩子 agent 调用 page_inspect 多次失败，需定位失败档位

- **类型**：bug
- **描述**：孩子 agent 几次调用 `page_inspect`（查看学习资料页面 DOM 快照）均失败（返回「快照获取失败：xxx」/「页面无响应」等），需排查。
- **调用链（已梳理）**：
  - `electron/lib/custom-tools.ts:1019` `pageInspectTool.execute` → `executePageAction(childId, { action: "read", maxDepth, maxNodes })`（`page-bridge.ts:191`，**10s 超时兜底**「页面无响应（10 秒超时）」）→ `pageExecTransport`（`ipc-handlers.ts:48` 注入：`w.webContents.send("pi:page:exec", …)`）→ 渲染 `src/pages/Learn.tsx:343` `handlePageExec` → **childId 不匹配则静默 return**（:350）→ `materialsPanelRef.current.exec("read")`（面板未挂载则回执「当前没有打开的学习资料页面」）→ `MaterialsPanel.exec`（`MaterialsPanel.tsx:153-171`：iframe/桥未就绪 →「页面未就绪或已关闭」；postMessage 后 10s 无回执 →「页面无响应」）→ 回执 `pi:page:exec:result` → `resolvePageAction`（page-bridge.ts:211）。
- **失败档位（按可能性排序，需 agent 报错原文定位）**：
  1. **未展示资料/无 iframe**：MaterialsPanel 处于列表态（没选中资料）或当前 `view !== "materials"`（如进度看板页，面板卸载）→「页面未就绪或已关闭」/「当前没有打开的学习资料页面」——agent 在未先 `display_content` 时调 page_inspect 必然失败。
  2. **childId 不匹配**：agent 会话 childId（`childIdFromCwd(ctx.cwd)`）与学习界面当前孩子（`childIdRef.current`）不一致（多孩子切换 / 后台会话）→ 渲染层静默丢弃 → 主进程 **10s 超时**「页面无响应」。
  3. **iframe 桥未就绪**：资料刚打开、iframe 仍在加载/桥未握手（`readyRef` false）→「页面未就绪或已关闭」。
  4. **transport 未注入 / 主窗口 null**：`registerIpcHandlers` 未执行或 `getMainWindow()` 为 null → `pageExecTransport` 默认分支 `console.warn("[page-bridge] transport 未注入…")` 丢弃 → 超时。
  5. **iframe 内快照执行失败/超时**：页面 DOM 巨大（默认 maxNodes 500 / maxDepth 8 仍可能慢）或桥脚本异常 → postMessage 无回执 → 超时。
- **待用户提供**：agent 返回的报错**原文**（「快照获取失败：`<error>`」的 error 内容 / 是否显示超时），可直接定位到上述档位。
- **优先级**：已完成（2026-08-30 实测会话报错原文=`Cannot read properties of undefined (reading 'catch')`——是代码级异常非上述 5 档位：pageExecTransport 未注入/主窗口 null 时返回 undefined，executePageAction 直接 `.catch` 崩。已改 `Promise.resolve(pageExecTransport(...)).catch` 兜底；主窗口不存在时按 10s 超时「页面无响应」语义返回）
- **记录时间**：2026-08-30

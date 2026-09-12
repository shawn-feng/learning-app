/**
 * iframe 学习资料 ↔ AI agent 双向通讯 —— 客户端主进程入口。
 *
 * 2026-09-12 P0：实现已上移到共享包 `packages/agent-core/src/bridge.ts`（唯一真源），
 * 本文件仅做转发，保持客户端既有调用点（ipc-handlers / custom-tools / 测试）不变。
 * 原因：同一套桥逻辑在 agent 上移服务端后被两端复用（客户端 transport=IPC、服务端 transport=SSE），
 * 各存副本必然漂移——prompt/协议这类「两份文本」正是 ISSUE-056 的教训来源。
 */
export {
  PAGE_EXEC_TIMEOUT_MS,
  PAGE_EVENT_RECENT_LIMIT,
  PageEventBuffer,
  PageBridgeHub,
  defaultPageBridge,
  formatPageEvent,
  eventText,
  setPageExecTransport,
  queuePageEvent,
  takePendingPageEvents,
  executePageAction,
  resolvePageAction,
  recentInteractions,
  genRequestId,
} from "../../packages/agent-core/src/bridge";
export type {
  PageBridgeEvent,
  PageExecParams,
  PageExecResult,
  PageExecTransportFn,
} from "../../packages/agent-core/src/bridge";

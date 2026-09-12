/**
 * 每会话的资料页桥（P3）：把 agent-core 的 PageBridgeHub 按会话装配，并把「下行指令」
 * 接到 SSE（服务端 → 客户端执行端点），回执走 `POST /api/v1/agent/:childId/page-result`。
 *
 * 为什么不是全局单例：一个进程里同时有多个孩子的会话（还可能有家长会话），
 * 下行 requestId 必须按会话隔离，否则 A 孩子的页面回执可能兑现 B 孩子的 pending 指令。
 */
import { PageBridgeHub, type PageExecTransportFn } from "@pi/agent-core";
import { agentStreamHub } from "./stream-hub.js";

const hubs = new Map<string, PageBridgeHub>();

/** 下行 transport：把指令作为 SSE 事件发给订阅了该会话的客户端。 */
function makeTransport(streamKey: string): PageExecTransportFn {
  return (_childId: string, requestId: string, action: string, params: Record<string, unknown>) => {
    agentStreamHub.publish(streamKey, "page_cmd", { requestId, action, params });
  };
}

/**
 * 取（或建）某会话的资料页桥。
 * @param streamKey 与 stream-hub 一致的 `<parentId>:<childId>`；childId 用于 page-result 回执定位。
 */
export function hubFor(streamKey: string, childId: string): PageBridgeHub {
  let hub = hubs.get(streamKey);
  if (!hub) {
    hub = new PageBridgeHub(makeTransport(streamKey));
    hubs.set(streamKey, hub);
    // 回执路由按 childId 查 hub：登记别名，见 resolvePageActionForChild
    hubs.set(`child:${childId}`, hub);
  }
  return hub;
}

/** 回执路由用：按 childId 找 hub（未建则 null，说明该孩子还没有活跃会话）。 */
export function hubForChild(childId: string): PageBridgeHub | null {
  return hubs.get(`child:${childId}`) ?? null;
}

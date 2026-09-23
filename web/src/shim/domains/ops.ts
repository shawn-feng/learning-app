/**
 * ops 域——家长端「运营/治理」面板的 window.api 实现（Web 适配层）。
 *
 * 覆盖四组此前仅 Electron preload 有的方法（web 端原本是 undefined，调用即在渲染层
 * 同步抛错——家长 Dashboard 挂载即调 parentReportGet，曾导致 web 家长模式白屏）：
 *  - parentReportGet：ISSUE-108 家长报表（GET /parent-agent/report）
 *  - mistakesList / mistakeReport / mistakeAction：错题本（/kb/:childId/mistakes*）
 *  - namespacesList / namespaceDecide / namespaceStatus：Tier 2 自定义数据（/namespaces*）
 *  - wechatFeishuGet / wechatFeishuSave / wechatBindings / wechatBindRequests /
 *    wechatBindDecide / wechatBindingRemove：飞书/微信渠道绑定（/wechat*）
 *
 * 返回形状逐一对齐 electron/lib/ipc-handlers.ts 同名通道的 {success, data|...} 包装。
 */
import { http, getStoredToken } from "../core/server-fetch";

function requireToken(): string | null {
  return getStoredToken() || null;
}

export const opsDomain = {
  /** parentReportGet: () => Promise<{success, data?: {report: {title,content,ts} | null}}>（ISSUE-108；Dashboard 挂载即调） */
  parentReportGet: async (): Promise<{ success: boolean; data?: { report: { title: string; content: string; ts: number } | null }; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<{ report: { title: string; content: string; ts: number } | null }>("/parent-agent/report");
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** mistakesList: ({childId,status?,kind?,limit?}) => Promise<{success, mistakes?}> */
  mistakesList: async (
    payload: { childId: string; status?: string; kind?: string; limit?: number }
  ): Promise<{ success: boolean; mistakes?: unknown[]; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const qs = new URLSearchParams();
      if (payload.status) qs.set("status", payload.status);
      if (payload.kind) qs.set("kind", payload.kind);
      if (payload.limit) qs.set("limit", String(payload.limit));
      const data = await http<{ mistakes?: unknown[] }>(
        `/kb/${encodeURIComponent(payload.childId)}/mistakes?${qs.toString()}`
      );
      return { success: true, mistakes: data?.mistakes ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** mistakeReport: ({childId,kind,content,...}) => Promise<{success}>（上报生字词/错题/薄弱点） */
  mistakeReport: async (
    payload: { childId: string; kind: "unknown_word" | "wrong_question" | "weak_point"; content: string; detail?: string; source?: string; course?: string }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      await http(`/kb/${encodeURIComponent(payload.childId)}/mistakes`, {
        method: "POST",
        body: payload,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** mistakeAction: ({childId,id,action}) => Promise<{success}>（mastered/dismiss/reopen） */
  mistakeAction: async (
    payload: { childId: string; id: string; action: "mastered" | "dismiss" | "reopen" }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      await http(`/kb/${encodeURIComponent(payload.childId)}/mistakes/action`, {
        method: "POST",
        body: { id: payload.id, action: payload.action },
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** namespacesList: () => Promise<{success, namespaces?}>（含 pending/disabled，管理面板清单） */
  namespacesList: async (): Promise<{ success: boolean; namespaces?: unknown[]; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<{ namespaces?: unknown[] }>("/namespaces");
      return { success: true, namespaces: data?.namespaces ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** namespaceDecide: ({ns,action:"confirm"|"reject"}) => Promise<{success}>（设计器草案确认/拒绝） */
  namespaceDecide: async (payload: { ns: string; action: "confirm" | "reject" }): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      await http("/namespaces/decide", { method: "POST", body: payload });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** namespaceStatus: ({ns,action:"disable"|"enable"}) => Promise<{success}> */
  namespaceStatus: async (payload: { ns: string; action: "disable" | "enable" }): Promise<{ success: boolean; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      await http("/namespaces/status", { method: "POST", body: payload });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatFeishuGet: () => Promise<{success, data?: {enabled,appId,hasSecret,running,status,envFallback}}> */
  wechatFeishuGet: async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<unknown>("/wechat/feishu-config");
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatFeishuSave: ({appId,appSecret?,enabled}) => Promise<{success, data?}>（PUT；appSecret 空则保留原值） */
  wechatFeishuSave: async (
    payload: { appId: string; appSecret?: string; enabled: boolean }
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<unknown>("/wechat/feishu-config", { method: "PUT", body: payload, timeoutMs: 20000 });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatBindings: () => Promise<{success, data?: {bindings}}> */
  wechatBindings: async (): Promise<{ success: boolean; data?: { bindings?: unknown[] }; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<{ bindings?: unknown[] }>("/wechat/bindings", { method: "POST", body: { action: "list" } });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatBindRequests: () => Promise<{success, data?: {requests}}>（待确认绑定请求列表） */
  wechatBindRequests: async (): Promise<{ success: boolean; data?: { requests?: unknown[] }; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<{ requests?: unknown[] }>("/wechat/bind-requests");
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatBindDecide: ({id,action,role?,childId?,label?}) => Promise<{success, data?}> */
  wechatBindDecide: async (
    payload: { id: string; action: "confirm" | "reject"; role?: "parent" | "child"; childId?: string; label?: string }
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<unknown>("/wechat/bind-requests/decide", { method: "POST", body: payload });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** wechatBindingRemove: (wechatId) => Promise<{success, data?}> */
  wechatBindingRemove: async (wechatId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      if (!requireToken()) return { success: false, error: "未登录" };
      const data = await http<unknown>("/wechat/bindings", { method: "POST", body: { action: "remove", wechatId } });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

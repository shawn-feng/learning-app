/**
 * plans 域（Phase 6 实现）：2026-09-10 计划域重构版 —— 孩子端「今日计划」（todoGet 走
 * /plans/today 三表窗口覆盖当天的行）与「我的执行力」趋势（todoStatsList 走 /rewards/:childId
 * 的 recentStats 按日汇总），积分读写与档位配置（/rewards/*），计划状态推进（/plans/status），
 * 家长端学习计划只读面板（/study-plans*，ISSUE-033）。
 * 逐通道对齐 electron/lib/ipc-handlers.ts；返回 {success, ...} 信封与 ipc 一致
 * （RewardPanel/TodoModal/ChildDailyPlans 按此消费）。
 */
import { http } from "../core/server-fetch";

/** 本地时区 YYYY-MM-DD（逐字对齐 electron/lib/dates.ts formatLocalDate——不用 toISOString，
 *  那是 UTC 日期，东八区晚上会跨到错误的「今天」）。 */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export const plansDomain = {
  /** todoGet: (childId, date?) => {success, date, items}（todo:get → GET /plans/today，date 缺省=本地今天） */
  todoGet: async (
    childId: string,
    date?: string
  ): Promise<{ success: boolean; date?: string; items?: unknown[]; error?: string }> => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const res = await http<{ date?: string; items?: unknown[] }>(
        `/plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(d)}`,
        { timeoutMs: 20000 }
      );
      return { success: true, date: res.date ?? d, items: res.items ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** plansRange: (childId, from?, days?) => {success, from, days}（plans:range → GET /plans/range，
   *  ISSUE-130 多日三域聚合；from 缺省=本地今天、days 缺省 14（服务端夹取 1~31）） */
  plansRange: async (
    childId: string,
    from?: string,
    days?: number
  ): Promise<{ success: boolean; from?: string; days?: Array<{ date: string; items: unknown[] }>; error?: string }> => {
    try {
      const q = new URLSearchParams({ childId });
      if (from) q.set("from", from);
      if (days) q.set("days", String(days));
      const res = await http<{ from: string; days: Array<{ date: string; items: unknown[] }> }>(
        `/plans/range?${q.toString()}`,
        { timeoutMs: 20000 }
      );
      return { success: true, from: res.from, days: res.days ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** todoStatsList: (childId, range?) => {success, rows}（todo:stats:list → GET /rewards/:childId?days=n，
   *  reward_daily_stats 按日汇总；range 缺省 30，夹取 1~365） */
  todoStatsList: async (
    childId: string,
    range?: number
  ): Promise<{ success: boolean; rows?: unknown[]; error?: string }> => {
    try {
      const n = typeof range === "number" ? Math.min(365, Math.max(1, Math.floor(range))) : 30;
      const res = await http<{ recentStats?: unknown[] }>(
        `/rewards/${encodeURIComponent(childId)}?days=${n}`,
        { timeoutMs: 20000 }
      );
      return { success: true, rows: res.recentStats ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** rewardGet: (childId, opts?) => {success, ...res}（reward:get → GET /rewards/:childId?date=&limit=&days=，
   *  余额 + 当日结算（含未解锁）+ 近 N 天趋势 + 流水，整包展开） */
  rewardGet: async (
    childId: string,
    opts?: { date?: string; limit?: number; days?: number }
  ): Promise<{ success: boolean; error?: string } & Record<string, unknown>> => {
    try {
      const q = new URLSearchParams();
      if (opts?.date) q.set("date", opts.date);
      if (opts?.limit) q.set("limit", String(opts.limit));
      if (opts?.days) q.set("days", String(opts.days));
      const res = await http<Record<string, unknown>>(
        `/rewards/${encodeURIComponent(childId)}${q.toString() ? `?${q}` : ""}`,
        { timeoutMs: 20000 }
      );
      return { success: true, ...res };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** rewardConfigGet: (childId) => {success, config}（reward:config:get → GET /rewards/:childId/config） */
  rewardConfigGet: async (
    childId: string
  ): Promise<{ success: boolean; config?: unknown; error?: string }> => {
    try {
      const res = await http<{ config: unknown }>(`/rewards/${encodeURIComponent(childId)}/config`, {
        timeoutMs: 20000,
      });
      return { success: true, config: res.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** rewardConfigSet: (childId, config) => {success}（reward:config:set → PUT /rewards/:childId/config） */
  rewardConfigSet: async (
    childId: string,
    config: Record<string, unknown>
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      await http(`/rewards/${encodeURIComponent(childId)}/config`, {
        method: "PUT",
        body: config,
        timeoutMs: 20000,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** planSetStatus: (plan) => {success, status}（plan:setStatus → POST /plans/status，
   *  家长审计与修正：cancel 取消 / reopen 撤销判定 / done 代判完成） */
  planSetStatus: async (plan: {
    childId: string;
    planId: string;
    kind: string;
    action: string;
    note?: string;
  }): Promise<{ success: boolean; status?: string; error?: string }> => {
    try {
      const res = await http<{ status: string }>("/plans/status", {
        method: "POST",
        body: plan,
        timeoutMs: 20000,
      });
      return { success: true, status: res.status };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** studyPlanList: (childId, opts?) => {success, rows}（studyPlan:list → GET /study-plans?childId=，
   *  from/to 由 ipc 在客户端过滤（date >= from / date <= to），逐行移植） */
  studyPlanList: async (
    childId: string,
    opts?: { from?: string; to?: string }
  ): Promise<{ success: boolean; rows?: unknown[]; error?: string }> => {
    try {
      const res = await http<{ rows?: any[] }>(
        `/study-plans?childId=${encodeURIComponent(childId)}`,
        {}
      );
      let rows = res.rows ?? [];
      if (opts?.from) rows = rows.filter((r: any) => r.date >= opts!.from!);
      if (opts?.to) rows = rows.filter((r: any) => r.date <= opts!.to!);
      return { success: true, rows };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** studyPlanToday: (childId, date?) => {success, date, items}（studyPlan:today → GET /study-plans/today，
   *  某天的排期聚合，date 缺省=本地今天；items 每课一行含 mode/carry/done） */
  studyPlanToday: async (
    childId: string,
    date?: string
  ): Promise<{ success: boolean; date?: string; items?: unknown[]; error?: string }> => {
    try {
      const d = typeof date === "string" && date ? date : formatLocalDate(new Date());
      const res = await http<{ date?: string; items?: unknown[] }>(
        `/study-plans/today?childId=${encodeURIComponent(childId)}&date=${encodeURIComponent(d)}`,
        {}
      );
      return { success: true, date: res.date ?? d, items: res.items ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

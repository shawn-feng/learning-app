/**
 * sessions 域（Phase 2 实现）——移植 electron/lib/ipc-handlers.ts 对应通道：
 *   - sessionReviewDates / sessionReviewMessages：方案B 阶段① 家长「对话回顾」，
 *     透传服务端 /sessions/:childId/dates 与 /sessions/:childId?date=，
 *     包装成 {success, dates|messages}（ipc 形态）。
 *   - parentChildDaily（ISSUE-049）：POST /db/query op=kb.daily_entries.queryByRange
 *     （child_id/from/to + 可选 block/tag/title），返回 {success, entries}
 *     （entries 为 kb.sqlite daily_entries 行的精简结构：date/block/title/raw/tags）。
 */
import { http, getStoredToken } from "../core/server-fetch";
import { dbQuery } from "./db";

export const sessionsDomain = {
  /** parentChildDaily: (childId, from, to, filters?) => Promise<{ success: boolean; entries?: unknown[]; error?: string }>（按日期范围倒序） */
  parentChildDaily: async (
    childId: string,
    from: string,
    to: string,
    filters?: { block?: string; tag?: string; title?: string }
  ): Promise<{ success: boolean; entries?: unknown[]; error?: string }> => {
    try {
      const entries = await dbQuery<unknown[]>("kb.daily_entries.queryByRange", {
        child_id: childId,
        from,
        to,
        ...(filters?.block ? { block: filters.block } : {}),
        ...(filters?.tag ? { tag: filters.tag } : {}),
        ...(filters?.title ? { title: filters.title } : {}),
      });
      return { success: true, entries: entries ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** sessionReviewDates: (childId) => Promise<{ success: boolean; dates?: Array<{ date: string; count: number }>; error?: string }> */
  sessionReviewDates: async (
    childId: string
  ): Promise<{ success: boolean; dates?: Array<{ date: string; count: number }>; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ dates?: Array<{ date: string; count: number }> }>(
        `/sessions/${encodeURIComponent(childId)}/dates`
      );
      return { success: true, dates: data?.dates ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** sessionReviewMessages: (childId, date) => Promise<{ success: boolean; messages?: Array<{ ts: number; role: string; text: string; toolCalls?: Array<{ id: string; name: string; arguments: string }> }>; error?: string }>（剔除 thinking 的完整逐字稿） */
  sessionReviewMessages: async (
    childId: string,
    date: string
  ): Promise<{ success: boolean; messages?: unknown[]; error?: string }> => {
    try {
      if (!getStoredToken()) return { success: false, error: "未登录" };
      const data = await http<{ messages?: unknown[] }>(
        `/sessions/${encodeURIComponent(childId)}?date=${encodeURIComponent(date)}`
      );
      return { success: true, messages: data?.messages ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

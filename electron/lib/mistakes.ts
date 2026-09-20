/**
 * 错题/生字本客户端 API（ISSUE-114）：查词上报 / 清单 / 状态流转。
 * 走家庭 license token（与 /agent/:childId/* 同口径），服务端做归属校验。
 */
import { currentSessionToken } from "./client-data";
import { serverFetch } from "./server-client";

export interface MistakeItem {
  id: string;
  kind: "wrong_question" | "unknown_word" | "weak_point";
  content: string;
  detail: string;
  source: string;
  question_id: string;
  course_ref: string;
  knowledge_point_id: string;
  knowledge_point_name: string;
  count: number;
  status: "open" | "mastered" | "dismissed";
  first_seen: string;
  last_seen: string;
}

/** 查词/口述信号上报（同内容自动合并计数） */
export async function mistakeReport(
  childId: string,
  payload: { kind: "unknown_word" | "wrong_question" | "weak_point"; content: string; detail?: string; source?: string; course?: string }
): Promise<{ ok?: boolean; error?: string }> {
  return serverFetch(`/kb/${encodeURIComponent(childId)}/mistakes`, {
    method: "POST",
    token: currentSessionToken(),
    body: {
      kind: payload.kind,
      content: payload.content,
      detail: payload.detail ?? "",
      source: payload.source ?? "lookup",
      course_ref: payload.course ?? "",
    },
    timeoutMs: 15000,
  });
}

export async function mistakesList(
  childId: string,
  query: { status?: string; kind?: string; limit?: number } = { status: "open" }
): Promise<{ mistakes?: MistakeItem[] }> {
  const qs = new URLSearchParams();
  if (query.status) qs.set("status", query.status);
  if (query.kind) qs.set("kind", query.kind);
  if (query.limit) qs.set("limit", String(query.limit));
  return serverFetch<{ mistakes?: MistakeItem[] }>(
    `/kb/${encodeURIComponent(childId)}/mistakes?${qs.toString()}`,
    { method: "GET", token: currentSessionToken(), timeoutMs: 15000 }
  );
}

export async function mistakeAction(
  childId: string,
  id: string,
  action: "mastered" | "dismiss" | "reopen"
): Promise<{ ok?: boolean; error?: string }> {
  return serverFetch(`/kb/${encodeURIComponent(childId)}/mistakes/action`, {
    method: "POST",
    token: currentSessionToken(),
    body: { id, action },
    timeoutMs: 15000,
  });
}

/**
 * 学习考核客户端（EXAM-REQUIREMENTS.md）——主进程侧：与服务端 /api/v1/exam/* 对接。
 * 出卷与判分在客户端（本地 LLM 独立内存 session）完成，本模块只负责：
 *   取考核配置（知识点 + assess_method/assess_rubric + 判分 prompt，判分口径服务端单一真源）
 *   上传语音（files 通道）→ 提交考核结果（写服务端 exam_attempts + 回写孩子 exam_mastery）
 *   家长查询考核记录 / 每课程考核记录表 / 播放原音。
 */
import { currentSessionToken } from "./client-data";
import { getServerUrl } from "./config";
import { serverFetch, serverFetchBinary } from "./server-client";

// ==================== 类型（与服务端路由契约一致） ====================

export interface ExamCourseConfig {
  title: string;
  firstLearned: string;
  lastReview: string;
  mastery: string;
  assessRubric: string;
}

export interface ExamTopicConfig {
  topicKey: string;
  name: string;
  assessMethod: string;
  courses: ExamCourseConfig[];
}

export interface ExamConfig {
  topics: ExamTopicConfig[];
  scoringPrompt: string;
}

export interface ExamPerQuestion {
  qid: string;
  course: string;
  question: string;
  /** 语音经 files/upload 后拿到的 fileId；无语音（纯文字兜底）可为空 */
  audioFileId?: string;
  asrText: string;
  startedAt?: number;
  answeredAt?: number;
  durationMs?: number;
  pointGot: number;
  pointMax: number;
  correct: boolean;
  aiComment: string;
}

export interface ExamAttemptPayload {
  childId: string;
  topic: string;
  title: string;
  startedAt: string;
  submittedAt: string;
  score: number;
  perQuestion: ExamPerQuestion[];
  courseMastery: Record<string, { correct: number; total: number; rate: number }>;
  reinforcePlan: Record<string, { planReviewAt: string; focus: string[]; aiSuggestion?: string }>;
  wrongQuestions: string[];
}

export interface ExamAttempt extends ExamAttemptPayload {
  id: string;
  status: string;
}

export interface ExamCourseRecord {
  course: string;
  attempts: number;
  lastAssessAt: string;
  correct: number;
  total: number;
  rate: number;
  difficulties: string[];
  highlights: string[];
  planReviewAt: string;
  focus: string[];
}

// ==================== 服务端调用 ====================

/** 取孩子考核配置（周期内学/复习过的知识点 + rubric + 判分 prompt）。 */
export async function getExamConfig(childId: string): Promise<ExamConfig> {
  return serverFetch<ExamConfig>(`/exam/config/${encodeURIComponent(childId)}`, {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 20000,
  });
}

/** 上传一段语音到服务端 files 通道（child 归属），返回 fileId。 */
export async function uploadExamVoice(
  childId: string,
  originalName: string,
  buffer: ArrayBuffer | Buffer
): Promise<string> {
  const base = getServerUrl();
  if (!base) throw new Error("未配置服务端地址");
  const token = currentSessionToken();
  const form = new FormData();
  form.append("child_id", childId);
  form.append("file", new Blob([buffer]), originalName || `voice-${Date.now()}.webm`);
  const res = await fetch(`${base}/api/v1/files/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (!res.ok) {
    let detail = `语音上传失败 (HTTP ${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b?.error) detail = b.error;
    } catch {
      /* 保留默认 */
    }
    throw new Error(detail);
  }
  const data = (await res.json()) as { file?: { id?: string } };
  const id = data.file?.id;
  if (!id) throw new Error("语音上传失败：服务端未返回 file id");
  return id;
}

/** 提交一次考核结果（客户端判分后上报；perQuestion 内 audioFileId 已由上传获得）。 */
export async function submitExamAttempt(payload: ExamAttemptPayload): Promise<{ ok: boolean; id: string }> {
  return serverFetch<{ ok: boolean; id: string }>("/exam/attempts", {
    method: "POST",
    body: payload,
    token: currentSessionToken(),
    timeoutMs: 30000,
  });
}

/** 家长查询某孩子考核记录列表（倒序）。 */
export async function listExamAttempts(childId: string, limit = 50): Promise<ExamAttempt[]> {
  const data = await serverFetch<{ attempts: ExamAttempt[] }>(
    `/exam/attempts/${encodeURIComponent(childId)}?limit=${limit}`,
    { method: "GET", token: currentSessionToken(), timeoutMs: 20000 }
  );
  return data.attempts ?? [];
}

/** 家长查询某孩子每课程考核记录表。 */
export async function getExamCourseRecords(childId: string): Promise<ExamCourseRecord[]> {
  const data = await serverFetch<{ records: ExamCourseRecord[] }>(
    `/exam/course-records/${encodeURIComponent(childId)}`,
    { method: "GET", token: currentSessionToken(), timeoutMs: 20000 }
  );
  return data.records ?? [];
}

/** 取语音文件为 data URL（家长端「听原音」：<audio src> 直接可播；文件走鉴权流式下载）。 */
export async function getExamAudioDataUrl(fileId: string): Promise<string> {
  const buf = await serverFetchBinary(`/files/${encodeURIComponent(fileId)}`, {
    token: currentSessionToken(),
    timeoutMs: 20000,
  });
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:audio/webm;base64,${btoa(binary)}`;
}

// ==================== 待考核（周期到点标红提醒，不强制打断） ====================

export interface ExamPendingTopic {
  topicKey: string;
  name: string;
  pending: boolean;
  lastExamAt: string; // "" = 从未考过
  periodDays: number;
}

/** 从考核方法说明解析周期（天）：每天/每日=1、每周=7、每月=30、每N天/每N周=按数字；写不出来默认 7。 */
export function parsePeriodDays(method: string): number {
  const m = method || "";
  if (/每天|每日|daily/i.test(m)) return 1;
  if (/每周|weekly/i.test(m)) return 7;
  if (/每月|monthly/i.test(m)) return 30;
  const nd = m.match(/每\s*(\d+)\s*天/);
  if (nd && Number(nd[1]) > 0) return Number(nd[1]);
  const nw = m.match(/每\s*(\d+)\s*周/);
  if (nw && Number(nw[1]) > 0) return Number(nw[1]) * 7;
  return 7;
}

/**
 * 计算孩子各科目的「待考核」状态（孩子端边栏标红提醒用）：
 * - 仅统计「写了考核方法说明 且 学/复习过课程」的科目（即 exam/config 会下发的）；
 * - 到期规则：从未考过 → 待考核；否则 距上次考核 ≥ periodDays → 待考核。
 */
export async function getExamPending(
  childId: string
): Promise<{ pending: boolean; count: number; topics: ExamPendingTopic[] }> {
  const [cfg, attempts] = await Promise.all([
    serverFetch<ExamConfig>(`/exam/config/${encodeURIComponent(childId)}`, {
      method: "GET",
      token: currentSessionToken(),
      timeoutMs: 20000,
    }).catch(() => null),
    serverFetch<{ attempts?: Array<{ topic?: string; submitted_at?: string }> }>(
      `/exam/attempts/${encodeURIComponent(childId)}?limit=200`,
      { method: "GET", token: currentSessionToken(), timeoutMs: 20000 }
    ).catch(() => null),
  ]);
  if (!cfg?.topics?.length) return { pending: false, count: 0, topics: [] };
  const lastByTopic = new Map<string, string>();
  for (const a of attempts?.attempts ?? []) {
    const t = String(a?.topic ?? "");
    const s = String(a?.submitted_at ?? "");
    if (!t) continue;
    const cur = lastByTopic.get(t) ?? "";
    if (s > cur) lastByTopic.set(t, s);
  }
  const topics = cfg.topics.map((t) => {
    const periodDays = parsePeriodDays(t.assessMethod);
    const lastExamAt = lastByTopic.get(t.topicKey) ?? "";
    const pending = !lastExamAt || Date.now() - new Date(lastExamAt).getTime() >= periodDays * 86400000;
    return { topicKey: t.topicKey, name: t.name, pending, lastExamAt, periodDays };
  });
  return { pending: topics.some((t) => t.pending), count: topics.filter((t) => t.pending).length, topics };
}

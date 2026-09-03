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
  examMastery: string;
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

/** 选课阶段候选课程元数据（v3 §14.9：服务端下发、客户端 LLM 按选课 prompt 挑选；不含 rubric 全文）。 */
export interface ExamSelectionCandidate {
  topic: string;
  topicName: string;
  title: string;
  firstLearned: string;
  lastReview: string;
  mastery: string;
  examMastery: string;
  lastExamAt: string;
  planReviewAt: string;
}

/** config 第一段（选课）：选课 prompt + 候选课程清单（固定排期） */
export interface ExamSelectionConfig {
  schedule: ExamScheduleBrief;
  selectionPrompt: string;
  candidates: ExamSelectionCandidate[];
}

/** config 第二段（出卷/判分）：选中课程（含 rubric）+ 判分 prompt */
export interface ExamCoursesConfig {
  schedule: ExamScheduleBrief;
  courses: ExamCourseConfig[];
  scoringPrompt: string;
}

/** config 返回中排期的精简信息 */
export interface ExamScheduleBrief {
  id: string;
  kind: "fixed" | "custom";
  freq: string;
  title: string;
  scheduledAt: string;
  status: string;
  scope: Record<string, unknown>;
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

/** 取孩子考核配置第一段（选课）：固定排期返回 selectionPrompt + candidates（客户端 LLM 选课）；
 *  自定义排期（scope 指定范围）直接返回 courses + scoringPrompt（见 ExamSelectionConfig/ExamCoursesConfig）。 */
export async function getExamConfig(childId: string, scheduleId?: string): Promise<ExamSelectionConfig | ExamCoursesConfig> {
  const q = scheduleId ? `?schedule=${encodeURIComponent(scheduleId)}` : "";
  return serverFetch<ExamSelectionConfig | ExamCoursesConfig>(`/exam/config/${encodeURIComponent(childId)}${q}`, {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 20000,
  });
}

/** 取孩子考核配置第二段：客户端选课完成后，按选中课程 title 拉 rubric + 判分 prompt。 */
export async function getExamCoursesForSchedule(
  childId: string,
  scheduleId: string,
  titles: string[]
): Promise<ExamCoursesConfig> {
  const q = `?schedule=${encodeURIComponent(scheduleId)}&courses=${encodeURIComponent(titles.join(","))}`;
  return serverFetch<ExamCoursesConfig>(`/exam/config/${encodeURIComponent(childId)}${q}`, {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 20000,
  });
}

// ==================== 考核排期 v2（EXAM-REQUIREMENTS §14.2） ====================

export interface ExamScheduleItem {
  id: string;
  kind: "fixed" | "custom";
  freq: string;
  scheduledAt: string;
  status: "pending" | "started" | "done" | "expired";
  attemptId: string;
  title: string;
  scope: Record<string, unknown>;
  /** 已到点且未完成（孩子侧可开始） */
  pending: boolean;
}

export interface ExamScheduleListResult {
  generated: number;
  schedules: ExamScheduleItem[];
}

/** 取排期列表（服务端懒生成固定排期）。 */
export async function getExamSchedules(childId: string): Promise<ExamScheduleListResult> {
  return serverFetch<ExamScheduleListResult>(`/exam/schedules/${encodeURIComponent(childId)}`, {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 20000,
  });
}

/** 创建自定义考核排期（家长对话 agent 生成）。scope: {topics?, courses?, note?} */
export async function createExamSchedule(
  childId: string,
  scheduledAt: string,
  scope: Record<string, unknown>
): Promise<{ ok: boolean; id: string }> {
  return serverFetch<{ ok: boolean; id: string }>("/exam/schedules", {
    method: "POST",
    body: { childId, scheduledAt, scope },
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

/** 标记排期开始（孩子点「开始这次考核」）。 */
export async function startExamSchedule(id: string): Promise<{ ok: boolean }> {
  return serverFetch<{ ok: boolean }>(`/exam/schedules/${encodeURIComponent(id)}/start`, {
    method: "POST",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

/** 考核完成后标记排期完成（关联 attempt_id）。 */
export async function completeExamSchedule(id: string, attemptId: string): Promise<{ ok: boolean }> {
  return serverFetch<{ ok: boolean }>(`/exam/schedules/${encodeURIComponent(id)}/complete`, {
    method: "POST",
    body: { attemptId },
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

/** 取消排期（家长端；仅待考核状态可取消；固定排期取消后会自动按配置补生成）。 */
export async function cancelExamSchedule(id: string): Promise<{ ok: boolean }> {
  return serverFetch<{ ok: boolean }>(`/exam/schedules/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

// ==================== 固定考核配置（家长设置：频率档 + 每轮课程数 N + 时刻） ====================

export interface FixedExamConfigData {
  /** 启用的固定频率档：daily | weekly（UI 标签管理；monthly+ 保留兼容） */
  frequencies: string[];
  courseCount: number;
  /** 每日考核时刻 HH:mm */
  time: string;
  /** 每周考核：周几（1=周一…7=周日）+ 时刻 */
  weekly: { weekday: number; time: string };
  anchorAt: string;
  /** 各频率档选课 prompt（家长可编辑；缺省用服务端默认模板） */
  selectionPrompts: Record<string, string>;
}

export async function getFixedExamConfig(): Promise<{ config: FixedExamConfigData }> {
  return serverFetch<{ config: FixedExamConfigData }>("/exam/fixed-config", {
    method: "GET",
    token: currentSessionToken(),
    timeoutMs: 15000,
  });
}

export async function saveFixedExamConfig(
  patch: Partial<{
    frequencies: string[];
    courseCount: number;
    time: string;
    weekly: { weekday: number; time: string };
    selectionPrompts: Record<string, string>;
  }>
): Promise<{ ok: boolean; config: FixedExamConfigData }> {
  return serverFetch<{ ok: boolean; config: FixedExamConfigData }>("/exam/fixed-config", {
    method: "POST",
    body: patch,
    token: currentSessionToken(),
    timeoutMs: 15000,
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

/** 课程综合学习情况（一站式）：某孩子每门课的学习/复习/考核全景，供家长计划与复习决策。 */
export interface CourseStatusItem {
  topic: string;
  topicName: string;
  title: string;
  topicType: string;
  status: string;
  mastery: string;
  firstLearned: string;
  lastReview: string;
  reviewCount: number;
  lastExamAt: string;
  examCount: number;
  examMastery: string;
  examRate: number;
  planReviewAt: string;
  focus: string[];
}

/** 取某孩子全部课程的综合学习情况（一次调用返回所有维度，LLM 自行判断薄弱项）。 */
export async function getCourseStatus(childId: string): Promise<CourseStatusItem[]> {
  const data = await serverFetch<{ records: CourseStatusItem[] }>(
    `/courses/status/${encodeURIComponent(childId)}`,
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

// ==================== 待考核（v2：排期到期未完成 = 待考核角标） ====================

export interface ExamPendingTopic {
  topicKey: string;
  name: string;
  pending: boolean;
  lastExamAt: string; // "" = 从未考过
  periodDays: number;
}

/**
 * @deprecated v2 周期改由固定频率排期（服务端 freqToMs）驱动，不再从 assess_method 文本解析。
 * 保留纯函数供旧逻辑/测试引用。
 */
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
 * 计算孩子「待考核」状态（孩子端边栏角标）：v2 改为按排期——
 * status=pending 且 scheduled_at ≤ 现在（已到点未考）的排期数 = 待考核数。
 * 失败时静默返回 0（不打扰孩子学习）。
 */
export async function getExamPending(
  childId: string
): Promise<{ pending: boolean; count: number; topics: ExamPendingTopic[] }> {
  try {
    const r = await getExamSchedules(childId);
    const now = Date.now();
    const pendings = (r.schedules ?? []).filter(
      (s) => s.status === "pending" && new Date(s.scheduledAt).getTime() <= now
    );
    return { pending: pendings.length > 0, count: pendings.length, topics: [] };
  } catch {
    return { pending: false, count: 0, topics: [] };
  }
}

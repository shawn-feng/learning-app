/**
 * 考核内容结构化 v2 管理（家长 agent 读/写新表）。
 * 权威库 = 服务端 parent.sqlite（客户端本地 parent.sqlite 为空占位），一律经 /api/v1/assess/* REST。
 */
import { serverFetch } from "./server-client";
import { currentSessionToken } from "./client-data";

const TOK = () => currentSessionToken();

export interface AssessCategory {
  id: string;
  topicId: string;
  name: string;
  behavior: string;
}
export interface AssessQuestionView {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null;
  pointMax: number;
  seq: number;
  /** 题级行为：speech_recite / speech_read / generic（2026-09-10 起判题以题级为准） */
  behavior: string;
  note: string;
  knowledgeSummary: string;
}
export interface AssessBankQuestion extends Omit<AssessQuestionView, "seq"> {
  contexts: Array<{ topic: string; course: string; category: string }>;
}
export interface AssessCourseItem {
  categoryId: string;
  categoryName: string;
  behavior: string;
  overview: string;
  questions: AssessQuestionView[];
}
export interface AssessCourseContent {
  topic: string;
  title: string;
  courseId: string;
  structured: boolean;
  items: AssessCourseItem[];
}
/** 整课保存里每项：categoryId 或 categoryName(+behavior)；questions 引用或内联新建。 */
export interface AssessSaveItem {
  categoryId?: string;
  categoryName?: string;
  behavior?: string;
  overview?: string;
  questions: Array<
    | { questionId: string }
    | { stem: string; answer: string; scoring?: string | null; pointMax?: number }
  >;
}

export async function listTopicCategories(topic: string): Promise<{ topic: string; categories: AssessCategory[] }> {
  return serverFetch(`/assess/topics/${encodeURIComponent(topic)}/categories`, { method: "GET", token: TOK() });
}

/** 添加/确保主题类别（同名已存在时服务端直接返回既有行）。 */
export async function saveAssessCategory(
  topicId: string,
  name: string,
  behavior = "generic"
): Promise<{ category: AssessCategory }> {
  return serverFetch(`/assess/categories`, {
    method: "POST",
    body: { topicId, name, behavior },
    token: TOK(),
  });
}

export async function getTopicMethodSpec(topic: string): Promise<{ topic: string; spec: unknown }> {
  return serverFetch(`/assess/topics/${encodeURIComponent(topic)}/method-spec`, { method: "GET", token: TOK() });
}

export async function getCourseAssess(topic: string, title: string): Promise<{ course: AssessCourseContent }> {
  return serverFetch(`/assess/courses/${encodeURIComponent(topic)}/${encodeURIComponent(title)}`, {
    method: "GET",
    token: TOK(),
  });
}

export async function saveCourseAssess(
  topic: string,
  title: string,
  items: AssessSaveItem[]
): Promise<{ ok: boolean; courseUuid: string; categories: number; questionsCreated: number; questionsLinked: number }> {
  return serverFetch(`/assess/courses/save`, {
    method: "POST",
    body: { topic, title, items },
    token: TOK(),
    timeoutMs: 30000,
  });
}

export async function saveChildMethodSpec(
  topicId: string,
  childId: string,
  input: { require?: Record<string, number>; exclude?: string[]; recitePass?: number }
): Promise<{ ok: boolean; spec: unknown }> {
  return serverFetch(`/assess/method-spec`, {
    method: "POST",
    body: { topicId, childId, ...input },
    token: TOK(),
  });
}

export interface QuestionRecord {
  childId: string;
  childName: string;
  attemptId: string;
  submittedAt: string;
  pointGot: number | null;
  pointMax: number | null;
  correct: boolean;
  aiComment: string;
}

/** 某道题的历次考核结果（该家长全部孩子，各返回最近一次）。 */
export async function questionAssessRecords(questionId: string): Promise<{ records: QuestionRecord[] }> {
  return serverFetch(`/assess/questions/${encodeURIComponent(questionId)}/records`, { method: "GET", token: TOK() });
}

/** 全量题库列表（家长「题库」菜单）。 */
export async function listAssessQuestions(): Promise<{ questions: AssessBankQuestion[] }> {
  return serverFetch(`/assess/questions/list`, { method: "GET", token: TOK() });
}

/**
 * 考核内容结构化管理（家长 agent 读/写，知识点制）。
 * 权威库 = 服务端 parent.sqlite（客户端本地 parent.sqlite 为空占位），一律经 /api/v1/assess/* REST。
 */
import { serverFetch } from "./server-client";
import { currentSessionToken } from "./client-data";

const TOK = () => currentSessionToken();

export interface AssessQuestionView {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null;
  pointMax: number;
  seq: number;
  /** 题级行为：speech_recite / speech_read / generic（判题以题级为准） */
  behavior: string;
  note: string;
  knowledgeSummary: string;
  /** 选择题选项 [{key,text}]；[] = 非选择题 */
  options: Array<{ key: string; text: string }>;
}
export interface AssessBankQuestion extends Omit<AssessQuestionView, "seq"> {
  contexts: Array<{ topic: string; course: string; knowledgePoint: string }>;
}
export interface AssessCourseItem {
  knowledgePointId: string;
  knowledgePointName: string;
  /** 知识点详情（该课考核要点的一部分） */
  detail: string;
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
/** 整课保存里每项：一个知识点（id 或 名称+详情）+ 挂在其下的题目（引用或内联新建）。 */
export interface AssessSaveItem {
  knowledgePointId?: string;
  knowledgePoint?: string;
  detail?: string;
  overview?: string;
  questions: Array<
    | { questionId: string }
    | { stem: string; answer: string; scoring?: string | null; pointMax?: number; behavior?: string; note?: string; options?: Array<{ key: string; text: string }> }
  >;
}

export interface AssessKnowledgePoint {
  id: string;
  courseUuid: string;
  courseTitle: string;
  name: string;
  detail: string;
  seq: number;
}

/** 某主题下全部课程的知识点（名称/详情/所属课程）。 */
export async function listTopicKnowledgePoints(topic: string): Promise<{ topic: string; knowledgePoints: AssessKnowledgePoint[] }> {
  return serverFetch(`/assess/topics/${encodeURIComponent(topic)}/knowledge-points`, { method: "GET", token: TOK() });
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
): Promise<{ ok: boolean; courseUuid: string; knowledgePoints: number; questionsCreated: number; questionsLinked: number }> {
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

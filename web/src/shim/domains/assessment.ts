/**
 * assessment 域（Phase 6 实现）：发音评测配置与试评（智聆/阿里儿童）+ 考核内容结构化查询。
 * 逐通道对齐 electron/lib/ipc-handlers.ts（1909-1934、2204-2230 行）与
 * electron/lib/assess-admin.ts（权威库 = 服务端 parent.sqlite，一律经 /api/v1/assess/* REST）：
 *   - 配置读写：GET/POST /assessment/config（服务端打码回显，绝不返回明文密钥），返回
 *     {success, config} 与 ipc 一致；POST 即服务端 patch 合并语义（applyAssessmentConfigPatch）。
 *   - 试评 assessmentTest：与 ipc 同协议——uploadExamVoice（multipart child_id + file，文件名
 *     assessment-test.webm，childId 留空）拿 fileId → POST /assessment/assess
 *     { childId:"", audioFileId, refText: refText || "hello", provider }，返回 {success, result}。
 *   - assessCourseContent/assessQuestionList/assessQuestionRecords：/assess/* 只读透传，
 *     ipc 解包后以 {success, data} 返回（course / questions / records）。
 */
import { http } from "../core/server-fetch";
import { uploadExamVoice } from "./exam";

export const assessmentDomain = {
  /** assessmentConfigGet: () => {success, config}（assessment:config:get → GET /assessment/config，打码回显） */
  assessmentConfigGet: async (): Promise<{ success: boolean; config?: unknown; error?: string }> => {
    try {
      const data = await http<{ config: unknown }>("/assessment/config", { timeoutMs: 15000 });
      return { success: true, config: data.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessmentConfigSet: (patch) => {success, config}（assessment:config:set → POST /assessment/config，服务端 patch 合并后返回打码配置） */
  assessmentConfigSet: async (patch: any): Promise<{ success: boolean; config?: unknown; error?: string }> => {
    try {
      const data = await http<{ config: unknown }>("/assessment/config", {
        method: "POST",
        body: patch,
        timeoutMs: 15000,
      });
      return { success: true, config: data.config };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessmentTest: (audio, provider?, refText?) => {success, result}（assessment:test，试评）
   *  协议对齐 ipc：录音原始 buffer 先上传（childId 留空）拿 fileId，再 POST /assessment/assess；
   *  无凭证时服务端 502，按 {success:false, error} 透传给设置页提示。 */
  assessmentTest: async (
    audio: ArrayBuffer,
    provider?: string,
    refText?: string
  ): Promise<{ success: boolean; result?: unknown; error?: string }> => {
    try {
      const childId = "";
      const fileId = await uploadExamVoice(childId, "assessment-test.webm", audio);
      const data = await http<{ audioFileId: string; assessmentId: string; result: unknown }>(
        "/assessment/assess",
        {
          method: "POST",
          body: { childId, audioFileId: fileId, refText: refText || "hello", provider },
          timeoutMs: 60000,
        }
      );
      return { success: true, result: data.result };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessCourseContent: (topic, title) => {success, data: course}（assess:courseContent → GET /assess/courses/:topic/:title） */
  assessCourseContent: async (
    topic: string,
    title: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ course: unknown }>(
        `/assess/courses/${encodeURIComponent(topic)}/${encodeURIComponent(title)}`,
        {}
      );
      return { success: true, data: data.course };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionList: () => {success, data: questions[]}（assess:questionList → GET /assess/questions/list） */
  assessQuestionList: async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ questions?: unknown[] }>("/assess/questions/list", {});
      return { success: true, data: data.questions || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionRecords: (questionId) => {success, data: records[]}（assess:questionRecords → GET /assess/questions/:questionId/records） */
  assessQuestionRecords: async (
    questionId: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ records?: unknown[] }>(
        `/assess/questions/${encodeURIComponent(questionId)}/records`,
        {}
      );
      return { success: true, data: data.records || [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessBankFacets: () => {success, data: {topics,courses,knowledgePoints}}（assess:bankFacets → GET /assess/questions/facets，ISSUE-132） */
  assessBankFacets: async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<Record<string, unknown>>("/assess/questions/facets", {});
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionSave: (q) => {success, data: {id}}（assess:questionSave → POST /assess/questions，create/update 单题不含挂载） */
  assessQuestionSave: async (q: any): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ id: string }>("/assess/questions", { method: "POST", body: q });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionDelete: (questionId) => {success, data: {deleted,mountsRemoved}}（assess:questionDelete → DELETE /assess/questions/:id） */
  assessQuestionDelete: async (questionId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ deleted: boolean; mountsRemoved: number }>(
        `/assess/questions/${encodeURIComponent(questionId)}`,
        { method: "DELETE" }
      );
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionLink: (input) => {success, data}（assess:questionLink → POST /assess/questions/link，挂到课×知识点） */
  assessQuestionLink: async (input: any): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<Record<string, unknown>>("/assess/questions/link", { method: "POST", body: input });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** assessQuestionUnlink: (input) => {success, data: {removed}}（assess:questionUnlink → POST /assess/questions/unlink） */
  assessQuestionUnlink: async (input: any): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ removed: boolean }>("/assess/questions/unlink", { method: "POST", body: input });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

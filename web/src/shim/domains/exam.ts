/**
 * exam 域（Phase 6 实现）：学习考核全家桶（EXAM-REQUIREMENTS.md）。
 * 逐通道对齐 electron/lib/ipc-handlers.ts（2020-2248 行）与 electron/lib/exam.ts 的服务端调用：
 *   - 配置/排期/固定配置/记录：/exam/config/:childId、/exam/schedules*、/exam/fixed-config、
 *     /exam/attempts*、/exam/course-records/:childId、/courses/status/:childId（纯 HTTP 透传，
 *     返回 {success, data} 信封与 ipc 一致）。
 *   - 语音上传（examSubmit 各题录音 / examAssessSpeech / assessment 试评共用）：与 ipc 的
 *     uploadExamVoice 同协议——POST /files/upload（multipart，child_id + file 字段，原始录音 buffer），
 *     取 data.file.id 作 fileId，再由 JSON 接口按 fileId 引用（服务端评测/回放都吃 fileId）。
 *   - examSubmit：先逐段上传录音拿 fileId 回填 payload.perQuestion[].audioFileId，再 POST /exam/attempts。
 *   - examAssessSpeech：上传语音（保留家长端回放）→ POST /assessment/assess，返回
 *     { audioFileId, assessmentId, result }（与 ipc 返回结构一致）。
 *   - examPending：ipc 侧 getExamPending 是「先拉排期列表（服务端 GET 时幂等补跑当日固定计划）、
 *     客户端过滤到期未完成」，失败静默 0——逐行移植。
 *   - examScore：判分口径服务端单一真源，scoringPrompt 参数不参与请求（ipc 同样忽略），
 *     POST /exam/agent/grade 后按 ipc 的 reshape 返回（courseMastery/reinforcePlan 置空、score=0）。
 *   - examAudio：Electron 返回 data:audio/webm;base64 data URL；Web 版改回 blob URL
 *     （渲染层 ExamView 只把 r.data 当字符串塞进 <audio src>，两种形态等价，blob URL 免 base64 双份内存）。
 */
import { http, httpBinary } from "../core/server-fetch";

// ---------------------------------------------------------------------------
// 内部工具（对齐 electron/lib/exam.ts + ipc-handlers 的信封）
// ---------------------------------------------------------------------------

function enc(v: string): string {
  return encodeURIComponent(v);
}

function fail(err: unknown): { success: false; error: string } {
  return { success: false, error: (err as Error).message };
}

interface FileUploadResp {
  file?: { id?: string };
}

/** 上传一段语音到服务端 files 通道（child 归属），返回 fileId。
 *  协议逐字对齐 electron/lib/exam.ts uploadExamVoice：multipart 字段 child_id + file（带原始文件名）。 */
export async function uploadExamVoice(
  childId: string,
  originalName: string,
  buffer: ArrayBuffer
): Promise<string> {
  const form = new FormData();
  form.append("child_id", childId);
  form.append("file", new Blob([buffer]), originalName || `voice-${Date.now()}.webm`);
  const res = await http<Response>("/files/upload", {
    method: "POST",
    body: form,
    raw: true,
    timeoutMs: 120000,
  });
  const data = (await res.json()) as FileUploadResp;
  const id = data.file?.id;
  if (!id) throw new Error("语音上传失败：服务端未返回 file id");
  return id;
}

/** 排期列表（服务端 GET 时幂等补跑当日固定考核计划）。 */
async function fetchSchedules(
  childId: string
): Promise<{ generated: number; schedules: Array<Record<string, unknown>> }> {
  return http(`/exam/schedules/${enc(childId)}`, { timeoutMs: 20000 });
}

/** 非结构化课程出题（POST /exam/agent/generate，对齐 server-agent-client.ts examGenerateCourse）。 */
async function generateCourseQuestions(
  childId: string,
  body: { topicName: string; courseTitle: string; childName?: string }
): Promise<{ questions: Array<Record<string, unknown>> }> {
  return http("/exam/agent/generate", { method: "POST", body: { childId, ...body }, timeoutMs: 120000 });
}

// ---------------------------------------------------------------------------
// window.api 方法（签名逐条摘自 electron/preload.ts 369-404 行）
// ---------------------------------------------------------------------------

export const examDomain = {
  /** examConfig: (childId, scheduleId?, courses?) => {success, data}（exam:config → GET /exam/config/:childId?schedule=&courses=） */
  examConfig: async (
    childId: string,
    scheduleId?: string,
    courses?: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      if (scheduleId && courses) {
        // 第二段（兼容路径）：按选中课程 title 拉 rubric + 判分 prompt
        const data = await http<unknown>(
          `/exam/config/${enc(childId)}?schedule=${enc(scheduleId)}&courses=${enc(courses)}`,
          { timeoutMs: 20000 }
        );
        return { success: true, data };
      }
      const q = scheduleId ? `?schedule=${enc(scheduleId)}` : "";
      const data = await http<unknown>(`/exam/config/${enc(childId)}${q}`, { timeoutMs: 20000 });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examSelectCourses: (childId, selectionPrompt) => {success:false, error}（exam:selectCourses——选课 LLM 已废弃，服务端内置规则） */
  examSelectCourses: (
    _childId: string,
    _selectionPrompt: string
  ): { success: false; error: string } => ({
    success: false,
    error: "选课已由服务端内置规则处理（计划周期内必学课全考），无需再调用选课。",
  }),

  /** examPending: (childId) => {success, data:{pending,count,topics}}（exam:pending——拉排期后本地过滤，失败静默 0） */
  examPending: async (
    childId: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const r = await fetchSchedules(childId);
      const now = Date.now();
      const pendings = (r.schedules ?? []).filter(
        (s: any) => s.status === "pending" && new Date(s.scheduledAt).getTime() <= now
      );
      return { success: true, data: { pending: pendings.length > 0, count: pendings.length, topics: [] } };
    } catch {
      // 失败时静默返回 0（不打扰孩子学习），对齐 electron/lib/exam.ts getExamPending
      return { success: true, data: { pending: false, count: 0, topics: [] } };
    }
  },

  /** examSchedules: (childId) => {success, data:{generated, schedules}}（exam:schedules → GET /exam/schedules/:childId） */
  examSchedules: async (
    childId: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await fetchSchedules(childId);
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examScheduleCreate: (childId, scheduledAt, scope) => {success, data:{ok,id}}（POST /exam/schedules） */
  examScheduleCreate: async (
    childId: string,
    scheduledAt: string,
    scope: any
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ ok: boolean; id: string }>("/exam/schedules", {
        method: "POST",
        body: { childId, scheduledAt, scope },
        timeoutMs: 15000,
      });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examScheduleStart: (id) => {success, data:{ok}}（POST /exam/schedules/:id/start） */
  examScheduleStart: async (id: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ ok: boolean }>(`/exam/schedules/${enc(id)}/start`, {
        method: "POST",
        timeoutMs: 15000,
      });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examScheduleComplete: (id, attemptId) => {success, data:{ok}}（POST /exam/schedules/:id/complete {attemptId}） */
  examScheduleComplete: async (
    id: string,
    attemptId: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ ok: boolean }>(`/exam/schedules/${enc(id)}/complete`, {
        method: "POST",
        body: { attemptId },
        timeoutMs: 15000,
      });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examScheduleCancel: (id) => {success, data:{ok}}（DELETE /exam/schedules/:id） */
  examScheduleCancel: async (id: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ ok: boolean }>(`/exam/schedules/${enc(id)}`, {
        method: "DELETE",
        timeoutMs: 15000,
      });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examFixedConfig: () => {success, data:{config}}（exam:fixedConfig → GET /exam/fixed-config） */
  examFixedConfig: async (): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ config: unknown }>("/exam/fixed-config", { timeoutMs: 15000 });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examFixedConfigSave: (patch) => {success, data:{ok,config}}（POST /exam/fixed-config） */
  examFixedConfigSave: async (patch: any): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ ok: boolean; config: unknown }>("/exam/fixed-config", {
        method: "POST",
        body: patch,
        timeoutMs: 15000,
      });
      return { success: true, data };
    } catch (err) {
      return fail(err);
    }
  },

  /** examSubmit: (payload, voices) => {success, data:{ok,id}}（exam:submit）
   *  协议对齐 ipc：先逐段 uploadExamVoice 拿 fileId、按 qid 回填 payload.perQuestion[].audioFileId，
   *  再 POST /exam/attempts（payload 原样上报，服务端按 scheduleId 置 done 并落 speech_assessments）。 */
  examSubmit: async (
    payload: any,
    voices: Array<{ qid: string; buffer: ArrayBuffer; name: string }>
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const childId = String(payload?.childId ?? "");
      for (const v of voices ?? []) {
        const fileId = await uploadExamVoice(childId, v.name, v.buffer);
        const q = (payload.perQuestion ?? []).find((x: any) => x.qid === v.qid);
        if (q) q.audioFileId = fileId;
      }
      const r = await http<{ ok: boolean; id: string }>("/exam/attempts", {
        method: "POST",
        body: payload,
        timeoutMs: 30000,
      });
      return { success: true, data: r };
    } catch (err) {
      return fail(err);
    }
  },

  /** examAttempts: (childId) => {success, data: attempts[]}（exam:attempts → GET /exam/attempts/:childId?limit=50） */
  examAttempts: async (childId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ attempts: unknown[] }>(
        `/exam/attempts/${enc(childId)}?limit=${50}`,
        { timeoutMs: 20000 }
      );
      return { success: true, data: data.attempts ?? [] };
    } catch (err) {
      return fail(err);
    }
  },

  /** examCourseRecords: (childId) => {success, data: records[]}（exam:courseRecords → GET /exam/course-records/:childId） */
  examCourseRecords: async (childId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ records: unknown[] }>(`/exam/course-records/${enc(childId)}`, {
        timeoutMs: 20000,
      });
      return { success: true, data: data.records ?? [] };
    } catch (err) {
      return fail(err);
    }
  },

  /** courseStatus: (childId) => {success, data: records[]}（course:status → GET /courses/status/:childId） */
  courseStatus: async (childId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const data = await http<{ records: unknown[] }>(`/courses/status/${enc(childId)}`, {
        timeoutMs: 20000,
      });
      return { success: true, data: data.records ?? [] };
    } catch (err) {
      return fail(err);
    }
  },

  /** examAudio: (fileId) => {success, data: <audio src 字符串>}（exam:audio）
   *  Electron 返回 data:audio/webm;base64 data URL；Web 版返回 blob URL——渲染层（ExamView）
   *  只把它作为字符串写入 <audio src>，两种形态等价，blob URL 免 base64 编码的内存/耗时。
   *  MIME 对齐 electron 硬编码的 audio/webm（浏览器按内容嗅探播放，wav 内容亦可播）。 */
  examAudio: async (fileId: string): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const buf = await httpBinary(`/files/${enc(fileId)}`, { timeoutMs: 20000 });
      const url = URL.createObjectURL(new Blob([buf], { type: "audio/webm" }));
      return { success: true, data: url };
    } catch (err) {
      return fail(err);
    }
  },

  /** examGenerate: (childId, topicConfig) => {success, data: questions[]}（exam:generate）
   *  对齐 ipc：一次性出题兼容旧调用，逐课串行走 /exam/agent/generate，单课失败跳过，结果拍平。 */
  examGenerate: async (
    childId: string,
    topicConfig: any
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const courses = Array.isArray(topicConfig?.courses) ? topicConfig.courses : [];
      const out: any[] = [];
      for (const c of courses) {
        try {
          const r = await generateCourseQuestions(childId, {
            topicName: topicConfig?.name ?? "",
            courseTitle: c?.title ?? "",
            childName: "",
          });
          out.push(...(r.questions ?? []));
        } catch {
          /* 单课失败跳过，与旧实现一致 */
        }
      }
      return { success: true, data: out };
    } catch (err) {
      return fail(err);
    }
  },

  /** examGenerateCourse: (childId, topicName, course, childName) => {success, data: questions[]}（POST /exam/agent/generate） */
  examGenerateCourse: async (
    childId: string,
    topicName: string,
    course: any,
    childName: string
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const r = await generateCourseQuestions(childId, {
        topicName: topicName || "",
        courseTitle: course?.title ?? "",
        childName: childName || "",
      });
      return { success: true, data: r.questions };
    } catch (err) {
      return fail(err);
    }
  },

  /** examScore: (childId, scoringPrompt, answers) => {success, data}（exam:score）
   *  判分口径服务端单一真源：scoringPrompt 参数不参与请求（ipc 同样忽略），POST /exam/agent/grade；
   *  返回按 ipc reshape：{ perQuestion, courseMastery:{}, reinforcePlan:{}, score:0, overall }。 */
  examScore: async (
    childId: string,
    _scoringPrompt: string,
    answers: any[]
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const result = await http<{ perQuestion: unknown[]; overall: string }>("/exam/agent/grade", {
        method: "POST",
        body: { childId, answers },
        timeoutMs: 120000,
      });
      return {
        success: true,
        data: { perQuestion: result.perQuestion, courseMastery: {}, reinforcePlan: {}, score: 0, overall: result.overall },
      };
    } catch (err) {
      return fail(err);
    }
  },

  /** examAssessSpeech: (childId, name, buffer, questionType, refText, opts?) => {success, data:{audioFileId, assessmentId, result}}
   *  （exam:assessSpeech）协议对齐 ipc：uploadExamVoice（保留家长端回放）→ POST /assessment/assess
   *  { childId, audioFileId, refText, provider: opts?.provider }；评测在服务端完成（服务端统一转 16k wav）。 */
  examAssessSpeech: async (
    childId: string,
    name: string,
    buffer: ArrayBuffer,
    _questionType: string,
    refText: string,
    opts?: any
  ): Promise<{ success: boolean; data?: unknown; error?: string }> => {
    try {
      const fileId = await uploadExamVoice(childId, name, buffer);
      const data = await http<{ audioFileId: string; assessmentId: string; result: unknown }>(
        "/assessment/assess",
        {
          method: "POST",
          body: { childId, audioFileId: fileId, refText: refText || "", provider: opts?.provider },
          timeoutMs: 60000,
        }
      );
      return {
        success: true,
        data: { audioFileId: data.audioFileId, assessmentId: data.assessmentId, result: data.result },
      };
    } catch (err) {
      return fail(err);
    }
  },
};

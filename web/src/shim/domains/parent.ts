/**
 * parent 域（Phase 3 实现）：家长库（ISSUE-029）——topics/courses/tags、孩子主题分配与
 * 主题类型、资料上传/列表/读取/删除。
 *
 * 语义逐行对齐 electron/lib/ipc-handlers.ts 的 parent:* 通道 + electron/lib/parent-library.ts
 * 的 SPLIT 方案 A 实现（786-815 行注释：**无本地缓存，全部从服务端拉取**）——本域即把同一套
 * 服务端调用面移植到浏览器（token 由 http() 自动携带，家长隔离由服务端 session 决定）：
 *
 * | ipc 通道                  | 服务端映射                                                     |
 * |--------------------------|---------------------------------------------------------------|
 * | parent:listTopics        | db parent_lib.topics.list + parent_lib.progress.list + GET /materials/list(html 计数) |
 * | parent:listCourses       | db parent_lib.courses.list {topic} → rowToParentCourse           |
 * | parent:getTags           | db parent_lib.tags.list {tag:""}                                |
 * | parent:upsertTag         | db parent_lib.tags.upsert                                       |
 * | parent:upsertTopic       | db parent_lib.topics.upsert + courses.upsert×N + courses.list 计数 |
 * | parent:allocate          | 读 parent_lib.*（topics/courses）→ 写 kb.topics.upsert + kb.courses.upsert×N（快照拷贝，保留孩子既有进度） |
 * | parent:listChildTopics   | db kb.topics.list {child_id}                                    |
 * | parent:setChildTopicDaily| 读 kb.topics.list → 合并 rules_json → 写 kb.topics.upsert        |
 * | parent:deallocate        | db kb.topics.deallocate                                         |
 * | parent:upsertCourse      | 读 parent_lib.courses.list 合并旧值（COALESCE 语义）→ courses.upsert |
 * | parent:deleteCourse      | db parent_lib.courses.delete                                    |
 * | parent:moveCourse        | db parent_lib.courses.move                                      |
 * | parent:readMaterial      | html → GET /materials/doc/:id?token=（doc 网关：改写资源+注桥）；md/其它 → GET /materials/content/:id 文本 |
 * | parent:listMaterials     | GET /materials/list 过滤 `<topic>/` 顶层文件                     |
 * | parent:uploadMaterial    | <input type=file multiple> → POST /materials/upload（topic+subDir；媒体默认进 media/ 子目录） |
 * | parent:listTopicMaterials| GET /materials/list 过滤 `<topic>/` 递归组树                     |
 * | parent:deleteMaterial    | DELETE /materials/:id（id=base64url(`<topic>/<relPath>`)）       |
 *
 * 与 Electron 的刻意差异：
 *   - allocate 后的「分配包上传云端暂存」（delivery，跨机分发给孩子端收件箱）不再需要——Web 与
 *     服务端同源，服务端本就是唯一真源（fire-and-forget 环节整体省略）；
 *   - parent:uploadMaterial 的系统文件选择框换成浏览器 <input type=file multiple>（pickFiles）。
 * 签名逐条摘自 electron/preload.ts。
 */
import { http, httpBinary, uploadMultipart, getStoredToken, encodeMaterialId } from "../core/server-fetch";
import { dbQuery, dbExec } from "./db";
import { pickFiles } from "./backup";

/** 与 electron/lib/kb-sqlite.ts normalizeTopicKey 一致：剥路径段与 .md 后缀。 */
function normalizeTopicKey(raw: string): string {
  const seg = String(raw || "").split("/")[0].trim();
  return seg.replace(/\.md$/i, "");
}

// ==================== 服务端材料列表（SPLIT 方案 A：无本地缓存，全走服务端） ====================

interface MaterialMetaRemote {
  id: string;
  path: string;
  type: string;
  size: number;
  updated_at: string;
}

/** 对齐 parent-library.ts materialsListRemote：GET /materials/list。 */
async function materialsListRemote(): Promise<MaterialMetaRemote[]> {
  const data = await http<{ materials?: MaterialMetaRemote[] }>("/materials/list");
  return data.materials ?? [];
}

// ==================== 家长库课程行（对齐 rowToParentCourse） ====================

/** 渲染层消费的课程结构（对齐 kb-sqlite.ts CourseItem；mastery/firstLearned 已下线恒空串）。 */
export interface ParentCourseItem {
  topic: string;
  title: string;
  sortOrder: number;
  status: string;
  mastery: string;
  firstLearned: string;
  lastReview: string;
  reviewCount: number;
  material: string;
  sendMaterial: string;
  tags: string;
  lessonMethod: string;
  htmlPath: string;
  teachingCopy: string;
  assessRubric: string;
}

function rowToParentCourse(r: Record<string, unknown>): ParentCourseItem {
  return {
    topic: String(r.topic),
    title: String(r.title),
    sortOrder: Number(r.sort_order) || 0,
    status: String(r.status ?? "⬜"),
    mastery: "", // 2026-09-10：掌握度已不存列（改看服务端 course_status）
    firstLearned: "", // 已下线
    lastReview: String(r.last_review ?? ""),
    reviewCount: Number(r.review_count) || 0,
    material: String(r.material ?? ""),
    sendMaterial: String(r.send_material ?? ""),
    tags: String(r.tags ?? ""),
    lessonMethod: String(r.lesson_method ?? ""),
    htmlPath: String(r.html_path ?? ""),
    teachingCopy: String(r.teaching_copy ?? ""),
    assessRubric: String(r.assess_rubric ?? ""),
  };
}

// ==================== 家长库主题（对齐 listParentTopics / upsertParentTopic） ====================

/** 渲染层消费的主题结构（对齐 parent-library.ts ParentTopic）。 */
export interface ParentTopic {
  name: string;
  topicKey: string;
  method: string;
  assessMethod: string;
  rules: Record<string, string>;
  learned: number;
  total: number;
  htmlCount: number;
}

export const parentDomain = {
  /** parentListTopics: () => Promise<{ success; data?: ParentTopic[]; error? }>（topics+progress 来自服务端 parent_lib，html 计数来自 /materials/list） */
  parentListTopics: async (): Promise<{ success: boolean; data?: ParentTopic[]; error?: string }> => {
    try {
      const [topics, progress, materials] = await Promise.all([
        dbQuery<Array<{ name: string; topic_key: string; method: string; assess_method: string; rules_json: string }>>(
          "parent_lib.topics.list",
          {}
        ).catch(() => []),
        dbQuery<Array<{ topic: string; learned: number; total: number }>>("parent_lib.progress.list", {}).catch(() => []),
        materialsListRemote().catch(() => [] as MaterialMetaRemote[]),
      ]);
      const aggMap = new Map((progress ?? []).map((a) => [a.topic, a]));
      const data: ParentTopic[] = (topics ?? []).map((r) => {
        let rules: Record<string, string> = {};
        try {
          rules = JSON.parse(r.rules_json || "{}");
        } catch {
          rules = {};
        }
        const topicDir = r.topic_key;
        const a = aggMap.get(topicDir);
        const prefix = `${topicDir}/`;
        // 对齐 Electron：仅统计主题目录顶层 html/htm（子目录不计）
        const htmlCount = (materials ?? []).filter(
          (m) =>
            m.path.startsWith(prefix) &&
            !m.path.slice(prefix.length).includes("/") &&
            /\.(html|htm)$/i.test(m.path)
        ).length;
        return {
          name: r.name,
          topicKey: r.topic_key,
          method: r.method,
          assessMethod: r.assess_method ?? "",
          rules,
          learned: Number(a?.learned) || 0,
          total: Number(a?.total) || 0,
          htmlCount,
        };
      });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentListCourses: (topicDir) => Promise<{ success; data?: ParentCourseItem[]; error? }>（parent_lib.courses.list） */
  parentListCourses: async (topicDir: string): Promise<{ success: boolean; data?: ParentCourseItem[]; error?: string }> => {
    try {
      const rows = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", { topic: topicDir });
      return { success: true, data: (rows ?? []).map(rowToParentCourse) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentGetTags: () => Promise<{ success; data?: ParentTagDef[]; error? }>（parent_lib.tags.list） */
  parentGetTags: async (): Promise<{ success: boolean; data?: Array<{ tag: string; dimension: string; criteria: string }>; error?: string }> => {
    try {
      const rows = await dbQuery<Array<{ tag: string; dimension: string; criteria: string }>>(
        "parent_lib.tags.list",
        { tag: "" }
      ).catch(() => []);
      return { success: true, data: rows ?? [] };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentUpsertTag: (tag, dimension?, criteria?) => Promise<{ success; error? }>（parent_lib.tags.upsert，INSERT OR REPLACE 语义） */
  parentUpsertTag: async (tag: string, dimension?: string, criteria?: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await dbExec("parent_lib.tags.upsert", { tag, dimension: dimension || "", criteria: criteria || "" });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentUpsertTopic: (topic) => Promise<{ success; data?: { topics; courses }; error? }>
   * 对齐 upsertParentTopic：topics 按 name 覆盖；courses 内容字段覆盖、进度字段一律 ⬜/空（进度属于孩子）。
   */
  parentUpsertTopic: async (
    topic: {
      name: string;
      topicKey: string;
      method: string;
      assessMethod?: string;
      progress?: string;
      rules?: Record<string, string>;
      courses?: Array<{
        title: string;
        sortOrder?: number;
        material?: string;
        sendMaterial?: string;
        tags?: string;
        lessonMethod?: string;
        htmlPath?: string;
        teachingCopy?: string;
        assessRubric?: string;
      }>;
    }
  ): Promise<{ success: boolean; data?: { topics: number; courses: number }; error?: string }> => {
    try {
      await dbExec("parent_lib.topics.upsert", {
        name: topic.name,
        topic_key: normalizeTopicKey(topic.topicKey),
        method: topic.method,
        assess_method: topic.assessMethod ?? "",
        progress: topic.progress || "",
        rules_json: JSON.stringify(topic.rules || {}),
      });
      for (const c of topic.courses || []) {
        await dbExec("parent_lib.courses.upsert", {
          topic: topic.topicKey,
          title: c.title,
          sort_order: c.sortOrder ?? 0,
          status: "⬜",
          last_review: "",
          review_count: 0,
          material: c.material ?? "",
          send_material: c.sendMaterial ?? "",
          tags: c.tags ?? "",
          lesson_method: c.lessonMethod ?? "",
          html_path: c.htmlPath ?? "",
          teaching_copy: c.teachingCopy ?? "",
          assess_rubric: c.assessRubric ?? "",
        });
      }
      const rows = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", {
        topic: topic.topicKey,
      }).catch(() => []);
      return { success: true, data: { topics: 1, courses: (rows ?? []).length } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentAllocate: (childId, topicDir) => Promise<{ success; data?: { copied; existing }; error? }>
   * 对齐 allocateTopicToChild（快照拷贝）：家长库 topics 行 + courses 内容字段拷进孩子 kb；
   * 主题级 method 不快照（真源家长库）；孩子已有课程行仅补内容字段、进度保留。
   */
  parentAllocate: async (
    childId: string,
    topicDir: string
  ): Promise<{ success: boolean; data?: { copied: number; existing: number }; error?: string }> => {
    try {
      const [topics, pCourses, cCourses] = await Promise.all([
        dbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>("parent_lib.topics.list", {}).catch(() => []),
        dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", { topic: topicDir }).catch(() => []),
        dbQuery<Array<Record<string, unknown>>>("kb.courses.list", { child_id: childId, topic: topicDir }).catch(() => []),
      ]);
      const topicRow =
        (topics ?? []).find((t) => t.topic_key === topicDir) ||
        (topics ?? []).find((t) => String(t.topic_key).includes(topicDir));
      if (topicRow) {
        await dbExec("kb.topics.upsert", {
          child_id: childId,
          name: topicRow.name,
          topic_key: topicRow.topic_key,
          // 主题级教学方法不快照（真源家长库，孩子端经服务端实时读）
          method: "",
          progress: "",
          rules_json: topicRow.rules_json || "{}",
        });
      }
      const existingMap = new Map((cCourses ?? []).map((c) => [String(c.title), c]));
      let copied = 0;
      let existing = 0;
      for (const c of pCourses ?? []) {
        const cur = existingMap.get(String(c.title));
        const base = {
          child_id: childId,
          topic: topicDir,
          title: String(c.title),
          sort_order: Number(c.sort_order) || 0,
          material: String(c.material ?? ""),
          send_material: String(c.send_material ?? ""),
          tags: String(c.tags ?? ""),
          lesson_method: String(c.lesson_method ?? ""),
          html_path: String(c.html_path ?? ""),
          teaching_copy: String(c.teaching_copy ?? ""),
        };
        if (cur) {
          // 已存在（孩子有进度）：内容字段补齐，进度保留
          existing++;
          await dbExec("kb.courses.upsert", {
            ...base,
            status: String(cur.status ?? "⬜"),
            last_review: String(cur.last_review ?? ""),
            review_count: Number(cur.review_count) || 0,
          });
        } else {
          copied++;
          await dbExec("kb.courses.upsert", {
            ...base,
            status: "⬜",
            last_review: "",
            review_count: 0,
          });
        }
      }
      return { success: true, data: { copied, existing } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentListChildTopics: (childId) => Promise<{ success; data?: {name;topicKey;daily;type}[]; error? }>（kb.topics.list） */
  parentListChildTopics: async (
    childId: string
  ): Promise<{ success: boolean; data?: Array<{ name: string; topicKey: string; daily: string; type: string }>; error?: string }> => {
    try {
      const rows = await dbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>(
        "kb.topics.list",
        { child_id: childId }
      ).catch(() => []);
      const data = (rows ?? []).map((r) => {
        let parsed: { daily?: string; type?: string } = {};
        try {
          parsed = JSON.parse(r.rules_json || "{}");
        } catch {
          parsed = {};
        }
        return { name: r.name, topicKey: r.topic_key, daily: parsed.daily || "", type: parsed.type || "" };
      });
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentSetChildTopicDaily: (childId, topicDir, daily, type) => Promise<{ success; data?: boolean; error? }>（kb.topics.list → 合并 rules_json → kb.topics.upsert） */
  parentSetChildTopicDaily: async (
    childId: string,
    topicDir: string,
    daily: string,
    type: string
  ): Promise<{ success: boolean; data?: boolean; error?: string }> => {
    try {
      const topics = await dbQuery<Array<{ name: string; topic_key: string; rules_json: string }>>(
        "kb.topics.list",
        { child_id: childId }
      ).catch(() => []);
      const row =
        (topics ?? []).find((t) => t.topic_key === topicDir) ||
        (topics ?? []).find((t) => String(t.topic_key).includes(topicDir));
      if (!row) return { success: true, data: false };
      let parsed: { daily?: string; type?: string; [k: string]: unknown } = {};
      try {
        parsed = JSON.parse(row.rules_json || "{}");
      } catch {
        parsed = {};
      }
      parsed.daily = daily;
      parsed.type = type;
      await dbExec("kb.topics.upsert", {
        child_id: childId,
        name: row.name,
        topic_key: row.topic_key,
        method: "",
        progress: "",
        rules_json: JSON.stringify(parsed),
      });
      return { success: true, data: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentDeallocate: (childId, topicDir) => Promise<{ success; data?: { removed }; error? }>（kb.topics.deallocate，保留 courses 与进度） */
  parentDeallocate: async (
    childId: string,
    topicDir: string
  ): Promise<{ success: boolean; data?: { removed: number }; error?: string }> => {
    try {
      const r = await dbExec<{ removed: number }>("kb.topics.deallocate", {
        child_id: childId,
        topic_key: topicDir,
      });
      return { success: true, data: r };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentUpsertCourse: (topicDir, course) => Promise<{ success; error? }>
   * 对齐 upsertParentCourse：只覆盖传入的非空内容字段（先读旧值合并，COALESCE 语义），进度字段保留。
   */
  parentUpsertCourse: async (
    topicDir: string,
    c: {
      title: string;
      sortOrder?: number;
      material?: string;
      sendMaterial?: string;
      tags?: string;
      lessonMethod?: string;
      htmlPath?: string;
      teachingCopy?: string;
      assessRubric?: string;
    }
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      let existing: Record<string, unknown> | undefined;
      try {
        const rows = await dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", { topic: topicDir });
        existing = (rows ?? []).find((r) => r.title === c.title);
      } catch {
        /* 读旧值失败：按空合并（该操作本就会失败） */
      }
      const merged = {
        topic: topicDir,
        title: c.title,
        sort_order: c.sortOrder ?? (Number(existing?.sort_order) || 0),
        status: String(existing?.status ?? "⬜"),
        last_review: String(existing?.last_review ?? ""),
        review_count: Number(existing?.review_count) || 0,
        material: c.material ?? String(existing?.material ?? ""),
        send_material: c.sendMaterial ?? String(existing?.send_material ?? ""),
        tags: c.tags ?? String(existing?.tags ?? ""),
        lesson_method: c.lessonMethod ?? String(existing?.lesson_method ?? ""),
        html_path: c.htmlPath ?? String(existing?.html_path ?? ""),
        teaching_copy: c.teachingCopy ?? String(existing?.teaching_copy ?? ""),
        assess_rubric: c.assessRubric ?? String(existing?.assess_rubric ?? ""),
      };
      await dbExec("parent_lib.courses.upsert", merged);
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentDeleteCourse: (topicDir, title) => Promise<{ success; data?: boolean; error? }>（parent_lib.courses.delete） */
  parentDeleteCourse: async (topicDir: string, title: string): Promise<{ success: boolean; data?: boolean; error?: string }> => {
    try {
      const r = await dbExec<{ ok: boolean }>("parent_lib.courses.delete", { topic: topicDir, title });
      return { success: true, data: !!r?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentMoveCourse: (topicDir, title, direction) => Promise<{ success; data?: boolean; error? }>（parent_lib.courses.move） */
  parentMoveCourse: async (
    topicDir: string,
    title: string,
    direction: -1 | 1
  ): Promise<{ success: boolean; data?: boolean; error?: string }> => {
    try {
      const r = await dbExec<{ ok: boolean }>("parent_lib.courses.move", { topic: topicDir, title, direction });
      return { success: true, data: !!r?.ok };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentReadMaterial: (relPath) => Promise<{ success; data?: { found; format; content; fileUrl; error? }; error? }>
   * 对齐 readParentMaterial（SPLIT 方案 A）：归一化相对路径（剥 materials/ 前缀与穿越段）→
   * html 走 doc 网关（服务端已完成「跟随占位跳转 + 相对资源改写为 content 绝对 URL + 注桥」，
   * 文本可直接 srcDoc/iframe 渲染）；md/其它走 content 路由取原始文本。失败经 data.error 显式
   * 暴露（M8-E：禁止静默降级），通道层仍 {success:true, data}（与 ipc 一致）。
   */
  parentReadMaterial: async (
    relPath: string
  ): Promise<{
    success: boolean;
    data?: { found: boolean; format: "html" | "md" | "other"; content: string; fileUrl: string; error?: string };
    error?: string;
  }> => {
    // 归一化（对齐 path.posix.normalize + 过滤空段：.. 弹栈）
    const clean = String(relPath || "")
      .replace(/\\/g, "/")
      .replace(/^materials\//, "");
    const segs: string[] = [];
    for (const s of clean.split("/")) {
      if (!s || s === ".") continue;
      if (s === "..") {
        segs.pop();
        continue;
      }
      segs.push(s);
    }
    const norm = segs.join("/");
    if (!norm) return { success: true, data: { found: false, format: "other", content: "", fileUrl: "" } };
    const ext = norm.slice(norm.lastIndexOf(".") + 1).toLowerCase();
    const isHtml = ext === "html" || ext === "htm";
    const isMd = ext === "md";
    try {
      let content: string;
      if (isHtml) {
        // 目录前缀 page 路由（2026-09-16，替代 doc/:id 网关）：html 携带 <base href=.../p/<token>/<dir>/ >
        // 使 JS 运行期动态拼接的相对媒体路径（'emma/x.mp4'）在 srcDoc 预览中也能正确解析播放；
        // 静态 src/href 仍由服务端改写为 content 绝对 URL（双保险）。带头时头优先（http() 自动带）。
        const token = encodeURIComponent(getStoredToken());
        const pathSegs = norm.split("/").map((s) => encodeURIComponent(s)).join("/");
        const res = await http<Response>(
          `/materials/p/${token}/${pathSegs}?doc=1`,
          { raw: true }
        );
        content = await res.text();
      } else {
        const buf = await httpBinary(`/materials/content/${encodeMaterialId(norm)}`);
        content = new TextDecoder("utf-8").decode(buf);
      }
      return {
        success: true,
        data: { found: true, format: isHtml ? "html" : isMd ? "md" : "other", content, fileUrl: "" },
      };
    } catch (err) {
      return {
        success: true,
        data: {
          found: false,
          format: "other",
          content: "",
          fileUrl: "",
          error: err instanceof Error ? err.message : "材料获取失败",
        },
      };
    }
  },

  /** parentListMaterials: (topicDir) => Promise<{ success; data?: string[]; error? }>（/materials/list 过滤顶层文件，对齐 listParentMaterials） */
  parentListMaterials: async (topicDir: string): Promise<{ success: boolean; data?: string[]; error?: string }> => {
    try {
      const all = await materialsListRemote().catch(() => [] as MaterialMetaRemote[]);
      const prefix = `${topicDir}/`;
      const data = (all ?? [])
        .filter((m) => m.path.startsWith(prefix) && !m.path.slice(prefix.length).includes("/"))
        .map((m) => m.path.slice(prefix.length))
        .sort();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentUploadMaterial: (topicDir, subDir?) => Promise<{ success; data?: { files: {name; relPath}[] }; error? }>
   * 对齐 parent:uploadMaterial + copyMaterialIntoParent：<input type=file multiple> 选文件 →
   * POST /materials/upload（topic + 可选 subDir）；未指定 subDir 时媒体文件进 media/ 子目录。
   * 取消/未选文件 → {success:true, data:{files:[]}}（与 Electron 取消分支一致）。
   */
  parentUploadMaterial: async (
    topicDir: string,
    subDir?: string
  ): Promise<{ success: boolean; data?: { files: Array<{ name: string; relPath: string }> }; error?: string }> => {
    try {
      // 与 ipc 弹框 filters 同一扩展名白名单
      const files = await pickFiles({
        multiple: true,
        accept: ".html,.htm,.md,.pdf,.jpg,.jpeg,.png,.webp,.mp3,.mp4,.webm,.ogg,.wav,.m4a,.aac,.flac",
      });
      if (files.length === 0) return { success: true, data: { files: [] } };
      // 上传的媒体扩展名（进 media/ 子目录；对齐 parent-library.ts MEDIA_EXTS）
      const MEDIA_EXTS = new Set([".mp3", ".mp4", ".webm", ".ogg", ".wav", ".m4a", ".aac", ".flac"]);
      const out: Array<{ name: string; relPath: string }> = [];
      for (const f of files) {
        const dot = f.name.lastIndexOf(".");
        const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : "";
        const mediaSubDir = subDir || (MEDIA_EXTS.has(ext) ? "media" : "");
        const r = await uploadMultipart<{ material?: { path?: string } }>("/materials/upload", f, {
          topic: topicDir,
          ...(mediaSubDir ? { subDir: mediaSubDir } : {}),
        });
        out.push({ name: f.name, relPath: r.material?.path ?? "" });
      }
      return { success: true, data: { files: out } };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * parentListTopicMaterials: (topicDir) => Promise<{ success; data?: ParentMaterialNode[]; error? }>
   * 对齐 listParentTopicMaterials：/materials/list 全量 → 过滤 `<topic>/` → 客户端组树（目录在前排序）。
   */
  parentListTopicMaterials: async (
    topicDir: string
  ): Promise<{ success: boolean; data?: ParentMaterialNode[]; error?: string }> => {
    try {
      const all = await materialsListRemote().catch(() => [] as MaterialMetaRemote[]);
      const prefix = `${topicDir}/`;
      const rels = (all ?? [])
        .filter((m) => m.path.startsWith(prefix))
        .map((m) => m.path.slice(prefix.length))
        .sort();
      const root: ParentMaterialNode[] = [];
      for (const rel of rels) {
        const parts = rel.split("/");
        let cur: ParentMaterialNode[] = root;
        let curRel = "";
        for (let i = 0; i < parts.length; i++) {
          const seg = parts[i];
          const isLast = i === parts.length - 1;
          curRel = curRel ? `${curRel}/${seg}` : seg;
          let node = cur.find((n) => n.name === seg && (isLast ? !n.isDir : n.isDir));
          if (!node) {
            node = {
              name: seg,
              relPath: curRel,
              isDir: !isLast,
              ext: isLast ? (dotExt(seg) || undefined) : undefined,
              children: isLast ? undefined : [],
            };
            cur.push(node);
          }
          if (!isLast && node.children) cur = node.children;
        }
      }
      const sortNodes = (nodes: ParentMaterialNode[]): void => {
        nodes.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        for (const n of nodes) if (n.children) sortNodes(n.children);
      };
      sortNodes(root);
      return { success: true, data: root };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** parentDeleteMaterial: (topicDir, relPath) => Promise<{ success; error? }>（DELETE /materials/:id，id=base64url(`<topic>/<relPath>`)） */
  parentDeleteMaterial: async (topicDir: string, relPath: string): Promise<{ success: boolean; error?: string }> => {
    try {
      const rel = `${topicDir}/${relPath}`;
      await http(`/materials/${encodeMaterialId(rel)}`, { method: "DELETE" });
      return { success: true };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

/** 学习资料树节点（对齐 parent-library.ts ParentMaterialNode；relPath 相对 materials/<topicDir>/）。 */
export interface ParentMaterialNode {
  name: string;
  relPath: string;
  isDir: boolean;
  ext?: string;
  children?: ParentMaterialNode[];
}

/** 小写扩展名（含点）；无扩展名返回空串。 */
function dotExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

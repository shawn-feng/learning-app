/**
 * learning 域（Phase 3 实现）：孩子学习进度汇总/单主题明细/单课学习总结 + 家长「教学内容」
 * 文件读写（learning:list/read/write，Electron 读孩子本机 learning/ 目录）。
 *
 * 精读结论（ipc-handlers learning:* → electron/lib/learning-summary.ts）：
 *   - learning:summary = fetchProgressRemote（kb.topics.list + kb.progress.list 远程预取）+
 *     getLearningSummary（**纯内存聚合**）→ Web 直接把同一聚合逻辑跑在远程结果上（无本地缓存层）；
 *   - learning:topic = getTopicProgress：kb.progress.list 聚合行 + kb.courses.list 每课 items；
 *   - learning:courseSummary = getCourseDailySummary：kb.daily_entries.query {block:"学习"} 按
 *     chapterKey（标题章节课时键，逐行移植 kb-sqlite.ts:845）过滤；
 *   - progress:get / learning:list|read|write 数据源是孩子**本机目录**文件
 *     （study-topics.md / learning/…），服务端无对应端点 → Web 返回与「目录不存在」等价的空
 *     结构（getProgress {}；learning:list {success,rootFiles:[],topics:[]}；learning:read
 *     {success,content:""}——与 Electron fs 不存在分支一致）或显式失败（learning:write 无处
 *     可写，显式不支持）。
 * 签名逐条摘自 electron/preload.ts。
 */
import { dbQuery } from "./db";

// ==================== 类型（对齐 learning-summary.ts） ====================

export interface TopicSummary {
  name: string;
  topicKey: string;
  learned: number;
  total: number;
  percent: number;
  next: string;
  updated: string;
  type: string;
}

export interface LearningSummary {
  topics: TopicSummary[];
  totals: {
    learned: number;
    total: number;
    percent: number;
    topicCount: number;
    completedCount: number;
  };
}

interface TopicsRow {
  name: string;
  topic_key: string;
  method: string;
  progress: string;
  rules_json: string;
}
interface ProgressRow {
  topic: string;
  total: number;
  learned: number;
  next: string;
  updated: string;
}

/** 每课进度条目（对齐 CourseItem）。 */
interface CourseItem {
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
}

/** 单主题进度明细（对齐 TopicDetail）。 */
interface TopicProgressDetail {
  topic: string;
  learned: number;
  total: number;
  next: string;
  updated: string;
  items: CourseItem[];
}

function percent(learned: number, total: number): number {
  if (!total) return 0;
  return Math.round((learned / total) * 1000) / 10;
}

/** 逐行移植 kb-sqlite.ts chapterKey：标题章节课时键（剥离主题名/括注后取「第 x 章/课」主体）。 */
function chapterKey(title: string, topicName: string): string {
  const norm = title.replace(topicName, "").replace(/·/g, "");
  const parens = [...norm.matchAll(/[（(]([^）)]*)[）)]/g)].map((m) => m[1]);
  const main = norm.replace(/[（(][^）)]*[）)]/g, "");
  for (const seg of [...parens, main]) {
    const hit = /.+?篇第[^章]*章/.exec(seg) || /.+?第[^章课]*[章课]/.exec(seg);
    if (hit) return hit[0];
  }
  return norm.replace(/[·（）()\s]/g, "");
}

/** 对齐 getLearningSummary 的纯聚合（输入 = 服务端远程行）。 */
function buildLearningSummary(topics: TopicsRow[], progress: ProgressRow[]): LearningSummary {
  const list: TopicSummary[] = topics.map((t) => {
    const dirName = t.topic_key;
    const p = progress.find((x) => x.topic === dirName);
    const learned = Number(p?.learned) || 0;
    const total = Number(p?.total) || 0;
    let rules: Record<string, string> = {};
    try {
      rules = JSON.parse(t.rules_json || "{}");
    } catch {
      rules = {};
    }
    return {
      name: t.name,
      topicKey: t.topic_key,
      learned,
      total,
      percent: percent(learned, total),
      next: p?.next ?? "",
      updated: p?.updated ?? "",
      type: rules.type || "",
    };
  });
  const totalLearned = list.reduce((s, t) => s + t.learned, 0);
  const totalAll = list.reduce((s, t) => s + t.total, 0);
  const completedCount = list.filter((t) => t.total > 0 && t.learned >= t.total).length;
  return {
    topics: list,
    totals: {
      learned: totalLearned,
      total: totalAll,
      percent: percent(totalLearned, totalAll),
      topicCount: list.length,
      completedCount,
    },
  };
}

export const learningDomain = {
  /**
   * getProgress: (childId) => Promise<Record<string, unknown>>（progress:get）。
   * Electron 读孩子本机 study-topics.md/study-rules.md/daily-logs/life-events.md；这些为本地
   * 工作文件（服务端无端点）→ Web 返回空对象（与「文件都不存在」分支一致）。渲染层当前无消费点。
   */
  getProgress: async (_childId: string): Promise<Record<string, unknown>> => ({}),

  /** learningSummary: (childId) => Promise<{ success; data?: LearningSummary; error? }>（远程取数 + 同构聚合） */
  learningSummary: async (childId: string): Promise<{ success: boolean; data?: LearningSummary; error?: string }> => {
    try {
      const [topics, progress] = await Promise.all([
        dbQuery<TopicsRow[]>("kb.topics.list", { child_id: childId }),
        dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId }),
      ]);
      return { success: true, data: buildLearningSummary(topics ?? [], progress ?? []) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** learningTopic: (childId, topic) => Promise<{ success; data?: TopicProgressDetail | null; error? }>（kb.progress.list + kb.courses.list） */
  learningTopic: async (
    childId: string,
    topic: string
  ): Promise<{ success: boolean; data?: TopicProgressDetail | null; error?: string }> => {
    try {
      const [progress, courses] = await Promise.all([
        dbQuery<ProgressRow[]>("kb.progress.list", { child_id: childId }),
        dbQuery<Array<Record<string, unknown>>>("kb.courses.list", { child_id: childId, topic }),
      ]);
      const p = (progress ?? []).find((x) => x.topic === topic);
      if (!p) return { success: true, data: null };
      return {
        success: true,
        data: {
          topic: p.topic,
          learned: Number(p.learned) || 0,
          total: Number(p.total) || 0,
          next: p.next ?? "",
          updated: p.updated ?? "",
          items: (courses ?? []).map((c) => ({
            topic: String(c.topic),
            title: String(c.title),
            sortOrder: Number(c.sort_order) || 0,
            status: String(c.status),
            mastery: "", // 2026-09-10：引导掌握度已下线
            firstLearned: "", // 已下线
            lastReview: String(c.last_review),
            reviewCount: Number(c.review_count) || 0,
            material: String(c.material),
            sendMaterial: String(c.send_material),
            tags: String(c.tags),
          })),
        },
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** learningCourseSummary: (childId, topicName, title) => Promise<{ success; data?: CourseDailySummary[]; error? }>（kb.daily_entries.query + chapterKey 过滤） */
  learningCourseSummary: async (
    childId: string,
    topicName: string,
    title: string
  ): Promise<{ success: boolean; data?: Array<{ date: string; title: string; raw: string; tags: string }>; error?: string }> => {
    try {
      const rows = await dbQuery<Array<{ date: string; title: string; raw: string; tags: string }>>(
        "kb.daily_entries.query",
        { child_id: childId, block: "学习" }
      );
      const courseKey = chapterKey(title, topicName);
      return {
        success: true,
        data: (rows ?? [])
          .filter((r) => chapterKey(r.title, topicName) === courseKey)
          .map((r) => ({ date: r.date, title: r.title, raw: r.raw, tags: r.tags })),
      };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /**
   * learningList: (childId) => Promise<{ success; rootFiles; topics }>（learning:list）。
   * Electron 列孩子本机 learning/ 目录；服务端无对应端点 → 返回与「目录不存在」一致的空结构
   * （消费方 TopicEditor.tsx 据此渲染空列表，容错）。
   */
  learningList: async (
    _childId: string
  ): Promise<{ success: boolean; rootFiles: string[]; topics: Array<{ topic: string; files: string[]; subdirs: string[] }> }> => ({
    success: true,
    rootFiles: [],
    topics: [],
  }),

  /** learningRead: (childId, relPath) => Promise<{ success; content }>（Web 无本机文件可读 → 与「文件不存在」分支一致返回空内容） */
  learningRead: async (_childId: string, _relPath: string): Promise<{ success: boolean; content: string }> => ({
    success: true,
    content: "",
  }),

  /** learningWrite: (childId, relPath, content) => Promise<{ success:false; error }>（无服务端端点、无处落盘，显式不支持而非假成功） */
  learningWrite: async (_childId: string, _relPath: string, _content: string): Promise<{ success: boolean; error?: string }> => ({
    success: false,
    error: "Web 版暂不支持写入学习目录（该目录为桌面端本地文件；教学内容请通过课程/资料管理维护）",
  }),
};

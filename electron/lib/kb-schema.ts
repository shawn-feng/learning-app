/**
 * 知识库数据文件的 schema 白名单（单一真源）。
 *
 * 依据 LEARNING-DATA-SPEC.md 5.4：kb 工具（custom-tools.ts）与 lint 脚本共享本文件，
 * 避免「工具校验一套、lint 查一套」的漂移。字段/区块的文档定义见 SPEC 第三章。
 */

/** daily 固定 4 区块 */
export const DAILY_BLOCKS = ["学习", "生活", "问答", "任务"] as const;

/** daily 各区块合法字段（`- 键：值` 格式）
 *  学习区块除 SPEC 模板字段外，扩展 recording 实际主流字段（按主题不同：论语用 原文/道理应用，汉字宫用 汉字 等）。
 *  白名单外的字段名：kb 工具（L2）拒绝、lint（L4）记为 warning——字段集合可随 recording 模板演进扩充。 */
export const DAILY_FIELDS: Record<string, readonly string[]> = {
  学习: [
    // SPEC 3.1 模板字段
    "课程名", "考核", "掌握度", "难点", "错题", "孩子表现",
    // recording 实际主流字段（2026-07 起）
    "主题", "考核结果", "知识点", "汉字", "原文", "备注", "亮点",
    "学习时间", "首次学习", "复习次数", "上次复习", "类型", "道理应用",
    "时间", "测验结果", "珊珊举例", "步骤一", "步骤二", "步骤三",
    "读音考核", "吟诵考核", "原文吟诵✅", "白话翻译✅", "阅读理解", "逐词拆解",
    "新识", "拆字", "金句", "出处", "释义", "故事", "应用", "结果", "状态",
    "内容", "表现", "学习内容", "学习方式", "测验方式", "里程碑", "重点词",
    "朗读", "排序", "形式", "方式", "说明", "关联", "复习方式",
    "提出问题", "珊珊提问", "珊珊联想", "珊珊理解", "珊珊联系已学", "珊珊纠正",
    "珊珊反馈", "珊珊状态", "珊珊观察", "孩子反应", "复习背诵", "额外讨论",
    "讨论", "新增", "日期", "章节", "成绩", "范围", "文章",
    // method.md 各主题记录模板字段
    "单元", "生字", "拼音考核",
  ],
  生活: ["标签", "概要", "备注"],
  问答: ["孩子的疑问", "引导过程", "结论"],
  任务: ["需求", "过程", "产物", "状态"],
};

/** 进度文件条目合法字段（`键:: 值` 格式，含 recording 实际使用的 首次学习/上次复习） */
export const PROGRESS_FIELDS = ["状态", "掌握度", "复习次数", "最近复习", "首次学习", "上次复习", "tags"] as const;

/** 进度文件 frontmatter 合法键 */
export const PROGRESS_FRONTMATTER = ["learned", "total", "next", "updated"] as const;

/** 进度文件条目状态取值约束 */
export const PROGRESS_STATUS_VALUES = ["⬜", "✅"] as const;

/** 月索引（life/inquiries/tasks）行合法字段 */
export const INDEX_FIELDS = ["summary", "type", "tags", "status", "关联"] as const;

/** tags 倒排文件的固定区块 */
export const TAG_BLOCKS = ["关联知识点", "关联生活事件"] as const;

/** tags/taxonomy.md frontmatter 合法键 */
export const TAXONOMY_FRONTMATTER = ["dimensions", "updated"] as const;

/**
 * 根据文件路径判定数据文件类型。
 * 返回 "daily" | "progress" | "index" | "tags" | "topics" | "rules" | null（非数据文件/内容文件）。
 */
export function detectDataFileKind(file: string): "daily" | "progress" | "index" | "tags" | "topics" | "rules" | null {
  if (file.startsWith("daily/")) return "daily";
  if (file === "learning/topics.md") return "topics";
  if (file === "learning/rules.md") return "rules";
  // learning/{topic}/{topic}.md —— 主题进度文件（文件名必须与目录名一致，method.md 等内容文件不匹配）
  if (/^learning\/([^/]+)\/\1\.md$/.test(file)) return "progress";
  if (/^(life|inquiries|tasks)\//.test(file)) return "index";
  if (file.startsWith("tags/")) return "tags";
  return null;
}

/** 某数据文件类型 + 区块的合法字段集合；无法判定的返回 null（不校验） */
export function legalFieldsFor(kind: NonNullable<ReturnType<typeof detectDataFileKind>>, block?: string): readonly string[] | null {
  switch (kind) {
    case "daily":
      return block ? DAILY_FIELDS[block] ?? null : Object.values(DAILY_FIELDS).flat();
    case "progress":
      return PROGRESS_FIELDS;
    case "index":
      return INDEX_FIELDS;
    case "tags":
      return null; // tags 倒排的「关联知识点/生活事件」为自由文本行，不做字段校验
    default:
      return null;
  }
}

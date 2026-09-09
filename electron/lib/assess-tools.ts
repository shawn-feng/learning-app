/**
 * 考核内容结构化 v2 家长 agent 工具（ISSUE-067 步骤2）。
 * 数据经 serverFetch 落服务端家长库（权威库）；写作纪律同 assess-guide 的新结构化入口：
 * - 类别 = 该主题考核类别（背诵/朗读/句意白话/道理/字词/典故…，behavior 决定评测或口述）；
 * - 背诵/朗读类题目 answer=标准原文（逐字发音评测 refText），scoring 可为空；
 * - 文字题每题=题干+参考答案+评分维度(可含特殊情况)；题库题可跨课复用。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { listChildren } from "./child-auth";
import {
  listTopicCategories,
  saveAssessCategory,
  getCourseAssess,
  saveCourseAssess,
  saveChildMethodSpec,
} from "./assess-admin";

export const assessCategoriesListTool = defineTool({
  name: "assess_categories_list",
  label: "查看主题考核类别",
  description:
    "返回某主题（topicKey 如 lunyu）的考核类别清单（类别名/类别id/默认behavior）。注意：判题以**题目级 behavior**为准（2026-09-10），类别 behavior 只是该类别下新建题目未指定时的默认继承。写考核内容前先看该主题有哪些类别。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key，如 lunyu / english" }),
  }),
  execute: async (_tc, params) => {
    const { topic, categories } = await listTopicCategories(String(params.topicKey || "").trim());
    const text = categories.length
      ? `主题 ${topic} 的考核类别：\n` +
        categories.map((c) => `- ${c.name}（id=${c.id}，behavior=${c.behavior}）`).join("\n")
      : `主题 ${topic} 还没有考核类别——请先用「添加考核类别」创建。`;
    return { content: [{ type: "text" as const, text }] };
  },
});

export const assessCategoryCreateTool = defineTool({
  name: "assess_category_create",
  label: "添加/确保考核类别",
  description:
    "在主题下添加一个考核类别（幂等：同名已存在则直接返回）。behavior 只是该类下新题未指定时的默认继承——判题以题目级 behavior 为准：speech_recite（背诵：整句发音评测、不显示原文、置首题）、speech_read（朗读跟读）、generic（口述主观题，默认）。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    name: Type.String({ description: "类别名，如 背诵 / 句意白话 / 道理 / 字词" }),
    behavior: Type.Optional(Type.String({ description: "speech_recite|speech_read|generic" })),
  }),
  execute: async (_tc, params) => {
    // 服务端同名幂等：不存在则创建，已存在则返回既有行（behavior 仅在新建时生效）
    const { category } = await saveAssessCategory(
      String(params.topicKey).trim(),
      String(params.name).trim(),
      String(params.behavior || "generic")
    );
    return {
      content: [{ type: "text" as const, text: `类别「${category.name}」（id=${category.id}，behavior=${category.behavior}）已就绪。` }],
    };
  },
});

export const assessCourseGetTool = defineTool({
  name: "assess_course_get",
  label: "查看课程考核内容",
  description:
    "查看某门课（topicKey + 课程标题）结构化考核内容：挂了哪些类别、每题题干/答案/评分，用于核对与写作前阅读。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    courseTitle: Type.String({ description: "课程标题，须与课程名册一致" }),
  }),
  execute: async (_tc, params) => {
    const { course } = await getCourseAssess(String(params.topicKey || "").trim(), String(params.courseTitle || "").trim());
    if (!course.structured) {
      return { content: [{ type: "text" as const, text: `课程「${course.title}」目前没有结构化考核内容（可走旧 rubric 整文）。` }] };
    }
    const lines = [`课程「${course.title}」（topic=${course.topic}）结构化考核内容：`];
    for (const it of course.items) {
      lines.push(`\n【${it.categoryName}】${it.overview ? `（概述：${it.overview}）` : ""}`);
      for (const q of it.questions) {
        const tag = q.behavior && q.behavior !== "generic" ? `[${q.behavior}]` : "";
        lines.push(`- 题${tag}(${q.pointMax}分): ${q.stem}`);
        if (q.answer) lines.push(`  答案：${q.answer}`);
        if (q.scoring) lines.push(`  评分标准：${String(q.scoring).slice(0, 300)}`);
        if (q.note) lines.push(`  备注：${q.note}`);
        if (q.knowledgeSummary) lines.push(`  知识点概要：${q.knowledgeSummary}`);
      }
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

export const assessContentSaveTool = defineTool({
  name: "assess_content_save",
  label: "保存课程考核内容",
  description:
    "整课保存某门课的考核内容（事务替换旧挂载）。payloadJson 为 JSON：{\"items\":[{ \"categoryName\":\"背诵\", \"overview\":\"该课该类别说明(可选)\", \"questions\":[ {\"stem\":\"背诵本章原文\",\"answer\":\"<标准原文>\",\"behavior\":\"speech_recite\",\"note\":\"备注(可选)\",\"knowledgeSummary\":\"知识点概要(可选)\"} ] }]}。\n" +
    "每道题可带 behavior（题级判定，2026-09-10 起）——speech_recite 背诵评测（answer=标准原文、不显示原文、置首题）、speech_read 朗读跟读、generic 口述主观题；不写则默认继承该类别的 behavior。" +
    "文字题每题必填 stem+answer（参考答案/得分要点），scoring 建议 JSON：{\"dims\":[{\"dim\":\"维度\",\"points\":\"得分点\",\"score\":分,\"note\":\"说明\"}],\"special\":[\"特殊情况\"]}，也可写人话；" +
    "note=备注、knowledgeSummary=知识点概要均可空（供向量检索）。引用已有题库题给 {\"questionId\":\"...\"}。\n" +
    "内容要对应真实课程材料（不编造原文）；写前先 assess_course_get / parent_library_courses 核对。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    courseTitle: Type.String({ description: "课程标题（须与课程名册完全一致）" }),
    payloadJson: Type.String({ description: "上述结构的内容 JSON 字符串" }),
  }),
  execute: async (_tc, params) => {
    let payload: { items?: Array<Record<string, unknown>> };
    try {
      payload = JSON.parse(String(params.payloadJson || "{}"));
    } catch (e) {
      return { content: [{ type: "text" as const, text: `payloadJson 不是合法 JSON：${String((e as Error).message || e)}` }] };
    }
    if (!Array.isArray(payload?.items)) {
      return { content: [{ type: "text" as const, text: 'payloadJson 需含 "items": [...]' }] };
    }
    const topic = String(params.topicKey || "").trim();
    const title = String(params.courseTitle || "").trim();
    const items = payload.items.map((it) => ({
      categoryId: it.categoryId != null ? String(it.categoryId) : undefined,
      categoryName: it.categoryName != null ? String(it.categoryName) : undefined,
      behavior: it.behavior != null ? String(it.behavior) : undefined,
      overview: it.overview != null ? String(it.overview) : undefined,
      questions: Array.isArray(it.questions) ? (it.questions as Array<Record<string, unknown>>) : [],
    }));
    try {
      const r = await saveCourseAssess(topic, title, items);
      return {
        content: [
          {
            type: "text" as const,
            text: `已保存「${title}」考核内容：${r.categories} 个类别，新建题 ${r.questionsCreated}，复用题 ${r.questionsLinked}。`,
          },
        ],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `保存失败：${String((e as Error).message || e)}` }] };
    }
  },
});

export const assessMethodSetTool = defineTool({
  name: "assess_method_set",
  label: "设置孩子的考核方法",
  description:
    "为主题下某个孩子设置考核方法：考哪些类别各几题(requireText)、不考哪些(excludeText)。如：requireText=\"背诵:1,句意白话:1,道理:1\"，excludeText=\"字词,典故\"。类别名用该主题已建类别；不存在的类别会报错。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    childName: Type.String({ description: "孩子显示名" }),
    requireText: Type.Optional(Type.String({ description: '类别名:题数，逗号分隔，如 "背诵:1,句意白话:1"' })),
    excludeText: Type.Optional(Type.String({ description: "不考的类别名，逗号分隔，如 字词,典故" })),
    recitePass: Type.Optional(Type.Number({ description: "背诵通过线(0-100)，默认 90" })),
  }),
  execute: async (_tc, params) => {
    const children = await listChildren().catch(() => []);
    const child = children.find((c: any) => c.name === params.childName || c.childName === params.childName);
    if (!child) {
      const names = children.map((c: any) => c.name || c.childName).join("、");
      return {
        content: [{ type: "text" as const, text: `找不到孩子「${params.childName}」${names ? `（现有：${names}）` : ""}` }],
      };
    }
    const require: Record<string, number> = {};
    for (const seg of String(params.requireText || "")
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [name, cnt] = seg.split(/[:：]/);
      if (!name) continue;
      require[name.trim()] = Math.max(1, Number(cnt) || 1);
    }
    const exclude = String(params.excludeText || "")
      .split(/[,，;；]/)
      .map((s) => s.trim())
      .filter(Boolean);
    const r = await saveChildMethodSpec(String(params.topicKey || "").trim(), String((child as any).childId || child.id), {
      require: Object.keys(require).length ? require : undefined,
      exclude: exclude.length ? exclude : undefined,
      recitePass: params.recitePass,
    });
    return {
      content: [{ type: "text" as const, text: `已保存「${params.childName}」在 ${params.topicKey} 的考核方法（${(r.spec as any)?.perChild ? "见返回" : ""}）。` }],
    };
  },
});

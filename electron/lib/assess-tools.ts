/**
 * 考核内容结构化家长 agent 工具（知识点制）。
 * 数据经 serverFetch 落服务端家长库（权威库）；写作纪律见 assess-guide 的新规范：
 * - 每课的考核要点 = 该课知识点（name + detail 详细描述）；课程挂知识点、知识点挂题目；
 * - 背诵/朗读题 answer=标准原文（逐字发音评测 refText），scoring 可为空，behavior 由题级指定；
 * - 文字题每题=题干+参考答案+评分维度(可含特殊情况)；题库题可跨课复用。
 */
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { listChildren } from "./child-auth";
import {
  listTopicKnowledgePoints,
  getCourseAssess,
  saveCourseAssess,
  saveChildMethodSpec,
  type AssessSaveItem,
} from "./assess-admin";

export const assessKnowledgePointsListTool = defineTool({
  name: "assess_knowledge_points_list",
  label: "查看主题知识点",
  description:
    "返回某主题（topicKey 如 lunyu）下全部课程的知识点清单（知识点名/详情/所属课程/id），可按 courseTitle 过滤只看一门课。知识点=该课的考核要点（detail 为详细描述）。写考核内容或设考核方法前先看。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key，如 lunyu / english" }),
    courseTitle: Type.Optional(Type.String({ description: "可选，只看这一门课的知识点" })),
  }),
  execute: async (_tc, params) => {
    const { topic, knowledgePoints } = await listTopicKnowledgePoints(String(params.topicKey || "").trim());
    const courseFilter = String(params.courseTitle || "").trim();
    const rows = courseFilter ? knowledgePoints.filter((k) => k.courseTitle === courseFilter) : knowledgePoints;
    if (!rows.length) {
      return {
        content: [{
          type: "text" as const,
          text: courseFilter
            ? `课程「${courseFilter}」（topic=${topic}）还没有知识点——保存考核内容时会随知识点一起创建（knowledgePoint + detail）。`
            : `主题 ${topic} 还没有知识点——保存考核内容时会随知识点一起创建（knowledgePoint + detail）。`,
        }],
      };
    }
    const lines = [`主题 ${topic}${courseFilter ? ` · 课程「${courseFilter}」` : ""} 的知识点：`];
    for (const k of rows) {
      lines.push(`- ${k.name}（id=${k.id}，课程：${k.courseTitle}）`);
      if (k.detail) lines.push(`  详情：${k.detail.slice(0, 200)}`);
    }
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  },
});

export const assessCourseGetTool = defineTool({
  name: "assess_course_get",
  label: "查看课程考核内容",
  description:
    "查看某门课（topicKey + 课程标题）结构化考核内容：挂了哪些知识点（含详情）、每题题干/答案/评分/选项，用于核对与写作前阅读。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    courseTitle: Type.String({ description: "课程标题，须与课程名册一致" }),
  }),
  execute: async (_tc, params) => {
    const { course } = await getCourseAssess(String(params.topicKey || "").trim(), String(params.courseTitle || "").trim());
    if (!course.structured) {
      return { content: [{ type: "text" as const, text: `课程「${course.title}」目前没有结构化考核内容（考核时将按该课知识点详情由 AI 出题）。` }] };
    }
    const lines = [`课程「${course.title}」（topic=${course.topic}）结构化考核内容：`];
    for (const it of course.items) {
      lines.push(`\n【知识点：${it.knowledgePointName}】${it.detail ? `（详情：${it.detail}）` : ""}${it.overview ? `（说明：${it.overview}）` : ""}`);
      for (const q of it.questions) {
        const tag = q.behavior && q.behavior !== "generic" ? `[${q.behavior}]` : "";
        lines.push(`- 题${tag}(${q.pointMax}分): ${q.stem}`);
        if ((q as any).options?.length)
          lines.push(`  选项：${(q as any).options.map((o: { key: string; text: string }) => `${o.key}.${o.text}`).join("  ")}（孩子看选项口头作答，判分按正确项）`);
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
    "整课保存某门课的考核内容（事务替换旧挂载）。payloadJson 为 JSON：{\"items\":[{ \"knowledgePoint\":\"知识点名\", \"detail\":\"知识点详情(强烈建议填：该知识点教什么、考核期望答到什么)\", \"overview\":\"本课补充说明(可选)\", \"questions\":[ {\"stem\":\"背诵本章原文\",\"answer\":\"<标准原文>\",\"behavior\":\"speech_recite\",\"note\":\"备注(可选)\"} ] }]}。\n" +
    "每个 item=一个知识点+挂在其下的题目；知识点名课内不存在会自动创建（同名复用），给 detail 会写入/更新详情。也可用 \"knowledgePointId\" 引用已有知识点。\n" +
    "每道题可带 behavior（题级判定）——speech_recite 背诵评测（answer=标准原文、不显示原文、置首题）、speech_read 朗读跟读、generic 口述主观题（默认）；" +
    "选择题可带 options:[{key:\"A\",text:\"…\"},…]（孩子看选项口头作答，判分按正确项自动对照，不进 LLM；answer 填正确项内容，可不填 scoring）。" +
    "文字题每题必填 stem+answer（参考答案/得分要点），scoring 建议 JSON：{\"dims\":[{\"dim\":\"维度\",\"points\":\"得分点\",\"score\":分,\"note\":\"说明\"}],\"special\":[\"特殊情况\"]}，也可写人话；" +
    "note=备注（可空）。引用已有题库题给 {\"questionId\":\"...\"}。\n" +
    "知识点名要用该课真实覆盖的知识点（先 assess_knowledge_points_list 看现有名称，**同名复用、不要同义造新名**）。\n" +
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
      knowledgePointId: it.knowledgePointId != null ? String(it.knowledgePointId) : undefined,
      knowledgePoint: it.knowledgePoint != null ? String(it.knowledgePoint) : undefined,
      detail: it.detail != null ? String(it.detail) : undefined,
      overview: it.overview != null ? String(it.overview) : undefined,
      questions: (Array.isArray(it.questions) ? it.questions : []) as AssessSaveItem["questions"],
    }));
    try {
      const r = await saveCourseAssess(topic, title, items);
      return {
        content: [
          {
            type: "text" as const,
            text: `已保存「${title}」考核内容：${r.knowledgePoints} 个知识点，新建题 ${r.questionsCreated}，复用题 ${r.questionsLinked}。`,
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
    "为主题下某个孩子设置考核方法：考哪些知识点各几题(requireText)、不考哪些(excludeText)。如：requireText=\"本章原文背诵:1,三章句意与道理:1\"，excludeText=\"通假字,典故\"。键用知识点名（或 uuid，先 assess_knowledge_points_list 查）；不存在的知识点会报错。",
  parameters: Type.Object({
    topicKey: Type.String({ description: "主题 topic_key" }),
    childName: Type.String({ description: "孩子显示名" }),
    requireText: Type.Optional(Type.String({ description: '知识点名:题数，逗号分隔，如 "本章原文背诵:1,三章句意与道理:1"' })),
    excludeText: Type.Optional(Type.String({ description: "不考的知识点名，逗号分隔，如 通假字,典故" })),
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

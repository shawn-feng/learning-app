/**
 * 会话常驻提示词里的「数据库元信息块」。
 *
 * 历史（ISSUE-144 P6 之前）：本模块还导出 `buildDataChannelBlocks`——把家长库/孩子库的
 * 表、列、关系、命名路径、Tier 2 灵活实体压成一份紧凑清单注入家长会话的 system prompt，
 * 目的是"读场景零 describe"（模型凭清单直接写 `parent_db_read` 查询）。
 * 2026-09-25 通用数据 API 整组退场，那段清单连同 `parent-data` 会话一并删除——
 * **家长侧不再有"自己查表"的入口**，问题该用哪把工具由场景技能给出（`load_skill` 按需加载）。
 *
 * 现在只剩孩子侧的能力清单（ISSUE-142 起同款做法：说"哪个问题用哪个工具"，不说表名）。
 */
import { listMistakes } from "../db/mistakes.js";

/** 孩子 agent 自己视角的元信息块。
 *  ISSUE-142（2026-09-23）起**不再暴露表/列清单**：孩子侧已无通用读写通道（通用三工具撤掉），
 *  改为「我能查到什么 —— 哪个问题用哪个工具」的能力清单，与三个专用只读工具一一对应，
 *  避免提示词教模型去查一个不存在的表入口。
 *  childId 传入时附带 open 状态错题摘要（ISSUE-114 复习触达：AI 老师在对话里自然掺入）。 */
export function buildChildSelfBlock(dataDir: string, parentId: string, childId?: string): string {
  let mistakeLines: string[] = [];
  if (childId) {
    try {
      const rows = listMistakes(dataDir, parentId, childId, { status: "open", limit: 8 });
      const KIND_ZH: Record<string, string> = { wrong_question: "错题", unknown_word: "生字词", weak_point: "薄弱点" };
      mistakeLines = rows.map((r) => {
        const day = String(r.last_seen).slice(5, 10);
        return `- [${KIND_ZH[r.kind] ?? r.kind}] ${r.content}${r.count > 1 ? `（${r.count} 次，最近 ${day}）` : `（${day}）`}`;
      });
    } catch {
      /* 读不到不阻塞 prompt 组装 */
    }
  }
  return [
    "【我能查到什么（都要先查再答，不要凭印象）】",
    "- 今天（或某天）要做什么：child_study_plan_list / child_exam_plan_list / child_life_plan_list",
    "- 我的积分（余额 / 每天结算与档位 / 每笔为什么加或扣 / 加分规则）：child_points_report",
    "- 我学得怎么样（主题进度 / 每课掌握程度 / 最近考核得分率 / 每次学习结果）：child_mastery_report",
    "- 考核考得怎么样（最近几场 / 某一场的逐题结果、每课概要、知识点）：child_exam_result",
    "- 课程、主题、每日记录、进度、标签定义：kb_query；每日记录写入与课程字段更新：kb_insert / kb_update",
    "- 我的错题本（记录 / 查看 / 标掌握）：child_mistake_log",
    "- 家长给的教学方法、课程资料、考核要点：parent_content",
    ...(mistakeLines.length
      ? [
          "【错题本 · 待复习】（教学时在合适课时自然掺入复习；孩子说会了先小题验证再 child_mistake_log action=master）",
          ...mistakeLines,
        ]
      : []),
  ].join("\n");
}

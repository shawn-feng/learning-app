/**
 * 服务端孩子 agent 的 system prompt（P1 版本，最小但真实可用）。
 *
 * 说明（重要）：完整行为规范（家长可编辑的 AGENTS 用户版本）在服务端已有真源
 * （`settings` 的 agents 表 / routes/agents），P3 迁移孩子 agent 时会整体接入；
 * P1 阶段先用本文件这份「能跑通全链路」的 prompt，重点是打通会话/工具/流式，不追求话术完整。
 *
 * 设计原则（沿用客户端 prompt 的既有约定）：
 * - 时间/身份等易变信息放在 prompt 里显式给出，避免模型靠猜；
 * - 工作区路径与「数据只能走工具」说清楚，防止模型试图直接改 sqlite；
 * - 不写「不要做 X」的禁令堆，而写「为什么」——便于模型在边界情形下自行判断。
 */
import type { CorePaths } from "@pi/agent-core";

export interface ChildPromptInput {
  paths: CorePaths;
  parentId: string;
  childId: string;
  childName: string;
  /** 今天（YYYY-MM-DD，服务端本地时区） */
  today: string;
  /** 当前时间（HH:mm） */
  now: string;
  /** 家长下发的额外行为规范（P3 接入 AGENTS 真源；P1 为空串） */
  agentRules?: string;
}

export function buildServerChildPrompt(input: ChildPromptInput): string {
  const workspace = input.paths.childWorkspaceDir(input.parentId, input.childId);
  return `你是「学习伙伴」，${input.childName} 的学习陪伴老师。你通过对话陪孩子学习、解答问题、按需产出学习材料。

## 当前上下文
- 孩子：${input.childName}（childId=${input.childId}）
- 今天：${input.today}，现在 ${input.now}
- 你的工作区：${workspace}（read/write/edit/ls 只能在此目录内操作）

## 数据规则（为什么这样设计）
孩子的学习记录、进度、标签、每日记录都存在服务端结构化数据库里，是家长与孩子回看的唯一真源；直接改文件会绕过校验与审计，所以数据读写一律走工具：
- 写入/更新记录：kb_insert、kb_update
- 查询记录与进度：kb_query
- 产出文件（如生成的 html 学习材料、练习题）：write/edit 写入工作区，再由系统登记

## 教学风格
- 面向孩子，语言简短、鼓励、具体；一次只推进一小步，先问再讲。
- 孩子答错时先肯定尝试，再引导他自己发现（不直接给答案）。
- 不闲聊无关话题；孩子跑题时温和拉回学习。

${input.agentRules ? `## 家长设定的额外规范\n${input.agentRules}\n` : ""}`;
}

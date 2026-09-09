/**
 * 课程考核内容编写规范（ISSUE-066）：家长 agent 写每课「考核内容」(courses.assess_rubric)
 * 与主题「考核方法」(topics.assess_method) 时遵循的完整规范 + 示例。
 *
 * - 真源：本模块常量 COURSE_ASSESS_GUIDE_MD（随代码版本走，打包进 asar）。
 * - 运行副本：ensureAssessGuideFile() 在家长会话创建前幂等写到 data/.pi/agent/assess-rubric-guide.md，
 *   家长 agent 的 cwd=data/，用 read 相对路径 `.pi/agent/assess-rubric-guide.md` 即可细读。
 * - 为什么 agent 必须按本规范写：孩子学习考核（v3 全主观题语音作答）的出题与判分都锚定 rubric；
 *   背诵/跟读题的「标准原文」由系统用固定句式从 rubric 提取（见文件内「背诵句式约定」），
 *   不按句式写则该课不会出背诵评测题、发音评测链路取不到原文。
 *
 * 同步提醒：本文件的引擎侧消费方是 electron/lib/exam-engine.ts（出题/判分），
 * 改背诵句式或结构约定前务必核对 RECITATION_MARK_RE 与 GENERATION_PER_COURSE_RULES。
 */

import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./config";

export const ASSESS_GUIDE_FILENAME = "assess-rubric-guide.md";

/** 完整规范文档（agent 起草 rubric/assess_method 前用 read 细读）。 */
export const COURSE_ASSESS_GUIDE_MD = `# 课程考核内容与考核方法编写规范（家长 agent 专用）

学习考核（v3：全主观题语音作答 + 背诵发音评测）的**出题与判分都锚定**家长库里的两块内容，这两块由你（家长 agent）负责编写，与家长端「考核要点」编辑器同源：

- 每课**考核内容 rubric**（courses.assess_rubric）：期望孩子学到并答到的内容，出题覆盖它、判分对照它。
- 每主题**考核方法 assess_method**（topics.assess_method）：按孩子区分题目构成与不考范围（可选；不写则按通用规则出题）。

## 一、每课「考核内容 rubric」结构（三部分骨架）

按以下三段 markdown 写（完整、具体，避免空话）：

\`\`\`markdown
一、考核知识点
（列出本课要考核的知识点，按类别组织，如：原文背诵 / 重点字词读音与释义 / 句意与白话翻译 / 道理与生活应用 / 相关典故背景。每类写清具体要求与范围。）

二、现成题目
（可直接放进考卷的题目。选择题和问答题都行，系统会把选择题改造成口述题：保留题干、去掉 A/B/C/D 选项让孩子口头作答。每题写清题干；选择题须带选项。）
- 例 1（选择题，会被改造成口述题）：下面哪句是「学而不思则罔」的下一句？A. 思而不学则殆 B. 见贤思齐焉 C. 不亦乐乎
- 例 2（问答题）：用自己的话说说「温故而知新，可以为师矣」是什么意思？
- （不必每题都写；已有的好题可优先复用，其余由系统按知识点现出。）

三、评分标准
（给判分 agent 的锚：答到什么程度算满分/半分/不给分。例如：能用自己的话准确说出句意=满分；只说出大意缺关键点=一半；完全答非所问=0 分。字词类：读准字音并说出常用义=满分。）
\`\`\`

## 二、背诵句式约定（★必守，关系到发音评测）

若本课要求背诵原文，**必须**在「一、考核知识点」里写一行固定句式：

\`\`\`markdown
- 原文背诵：能正确流利背诵“<要背的原文>”
\`\`\`

要求：
- 行首是「- 原文背诵：」，**原文必须放在中文弯引号“ ”（或英文引号 "）内**，系统按此行从引号里提取标准原文做逐字发音评测——不按此句式（如漏引号、用「」书名号）则该课**不会出背诵评测题**。
- 引号内只放要背的原文本身，不要夹带解释（例如：- 原文背诵：能正确流利背诵“学而时习之，不亦说乎？有朋自远方来，不亦乐乎？”）。
- 一课有多段要背就写多行（系统自动按行提取并去重）。
- 背诵题由系统自动出并评分，**不要在 rubric 里或让系统另出“请背出原文”的题**（会重复）。

## 三、每主题「考核方法 assess_method」写法（可选）

主题级方法用于按孩子区分考核构成。**有多孩子时按孩子分段**，系统只按「本次考核孩子」的段落出题；方法里明确“不考…”的，一律不出。

\`\`\`markdown
【闻闻】
题量：每课 3 题。题型：句意白话 + 道理应用 + 背诵。范围：背诵只考“学而”篇，不考字词读音。

【珊珊】
题量：每课 2 题。题型：字词读音释义 + 句意。范围：不考核背诵（口齿不清暂缓）。
\`\`\`

（单孩子家庭可省略孩子名段，直接写规则。）

## 四、写作纪律

1. 写 rubric 前先用 parent_transcribe_media / parent_read_image 对准该课真实资料内容（P3），**不要编造原文与知识点**——尤其「原文背诵」引号里的原文必须逐字与该课材料一致。
2. rubric 三部分缺一不可（知识点→题目→评分标准）；题目与知识点要能对得上。
3. 原文与教学内容（html/音视频）冲突时以资料原文为准。
4. 保存：每课 rubric 用 **parent_course_save** 传 \`assessRubric\`；主题方法用 **parent_topic_save** 传 \`assessMethod\`（或建主题时 courses 每项带 \`assessRubric\`）。更新只覆盖传入字段，其余保留。
5. 写完后向家长汇报哪几课已配考核内容、哪些还没配（提醒可继续补）。
`;

/**
 * 幂等把规范文档写到 agent 可读位置 data/.pi/agent/<ASSESS_GUIDE_FILENAME>。
 * 每次家长会话创建前调用（家长会话是单例缓存，实际每个 app 生命周期只写 1~2 次）；
 * 写后返回绝对路径。
 */
export function ensureAssessGuideFile(): string {
  const dir = path.join(getDataDir(), ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, ASSESS_GUIDE_FILENAME);
  try {
    const old = fs.readFileSync(target, "utf-8");
    if (old === COURSE_ASSESS_GUIDE_MD) return target; // 已是最新，跳过写
  } catch {
    /* 不存在 → 写入 */
  }
  fs.writeFileSync(target, COURSE_ASSESS_GUIDE_MD, "utf-8");
  return target;
}

/**
 * 课程考核内容编写规范（结构化 v2，2026-09-09）：家长 agent 用 assess_* 工具为课程
 * 写「类别→题目(题干+答案+评分)」结构化考核内容、为孩子设考核方法时的完整规范 + 示例。
 *
 * - 真源：本模块常量 COURSE_ASSESS_GUIDE_MD（随代码版本走，打包进 asar）。
 * - 运行副本：ensureAssessGuideFile() 在家长会话创建前幂等写到 data/.pi/agent/assess-rubric-guide.md，
 *   家长 agent 的 cwd=data/，用 read 相对路径 `.pi/agent/assess-rubric-guide.md` 即可细读。
 * - v2：新内容一律结构化（题库/类别/关系表，服务端权威库），旧 rubric 三段 markdown 仅存量未迁移课
 *   兼容（引擎对新结构化课程直出题，不再按正则抓背诵原文；旧课仍走 assess_rubric 整文路径）。
 */

import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./config";

export const ASSESS_GUIDE_FILENAME = "assess-rubric-guide.md";

/** 完整规范文档（agent 起草 rubric/assess_method 前用 read 细读）。 */
export const COURSE_ASSESS_GUIDE_MD = `# 课程考核内容编写规范（家长 agent 专用 · 结构化 v2）

**核心变化（2026-09-09 v2）**：考核内容已结构化——主题建「考核类别」，每课按类别挂「题目（题干+参考答案+评分标准）」，题库题可跨课复用；课程已结构化后考核**直接抽题（不再逐课 LLM 现出题）**。
你写内容用 **assess_* 工具**；旧字段 \`courses.assess_rubric\`（三段 markdown rubric）与 \`topics.assess_method\`（散文）**仅存量未迁移课程兼容**，新课/新内容一律走结构化，不要再写旧三段式。

## 0. 用什么工具

| 工具 | 用途 |
|---|---|
| assess_categories_list | 看主题现有考核类别（含 behavior） |
| assess_category_create | 加类别：背诵=speech_recite / 朗读=speech_read / 其余=generic（口述题） |
| assess_course_get | 看某课已挂内容（题干/答案/评分） |
| assess_content_save | **整课保存考核内容（主入口，事务替换）** |
| assess_method_set | 设置某孩子的考核方法（考哪些类别各几题/不考哪些/背诵通过线） |
| parent_library_courses / parent_library_topics | 写前核对课程标题与主题（课程名以此为准，不要编造） |

## 1. 内容模型（一句话）

主题决定「有哪些类别」（背诵/句意白话/道理/字词/典故…）；课程决定「挂了哪些类别的哪些题」；同类别多题=例题池，考核时随机抽 1。

类别 behavior 决定引擎行为：speech_recite/speech_read 走**发音评测**，其余 generic 走**口述主观题判分**。（2026-09-10：behavior 为**题级字段**（题库表 question_bank.behavior），判题以题目为准——同一类别下可同时有背诵题与口述题；类别 behavior 仅作创建题时的默认继承。）

## 2. 背诵/朗读类（★）

- 类别：背诵 = speech_recite（系统出背诵题：**不显示原文**、发音评测、置该课首题、通过线取该孩子方法 recitePass，默认 90）；朗读 = speech_read（显示原文跟读）。
- 题目固定写法：\`stem\`=背诵/朗读任务描述（如"背诵本章原文"）、**\`answer\`=要背/读的标准原文（整段、逐字，评测 refText）**、scoring 可省略；\`behavior\` 建议显式给 "speech_recite"/"speech_read"（不写则继承该类别默认行为，判题以题目级 behavior 为准）。
- 不要再写旧句式「- 原文背诵：…“…”」，也不要在文字题里另出"背出原文"的题（会与系统背诵题重复）。

## 3. 文字口述题（generic）

每题三要素：
- \`stem\`：题干（无选项；要引原文就在题干里给出）
- \`answer\`：参考答案/得分要点（判分锚定）
- \`scoring\`：评分标准，建议 JSON 字符串：{"dims":[{"dim":"维度","points":"得分点","score":分值,"note":"说明"}],"special":["特殊情况"]}；写人话也可，越具体判分越准。
- \`pointMax\` 默认 10。

## 4. 整课保存示例（assess_content_save 的 payloadJson）

{"items":[
  {"categoryName":"背诵","overview":"能正确流利背诵本章原文，逐字评测，90 分通过","questions":[{"stem":"背诵本章原文","answer":"子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？"}]},
  {"categoryName":"句意白话","questions":[{"stem":"请用自己的话讲一讲这三句话分别是什么意思，并举例。","answer":"三句白话要点…","scoring":"{\\"dims\\":[{\\"dim\\":\\"三句意思\\",\\"points\\":\\"复习→快乐/朋友来→快乐/不愠→君子\\",\\"score\\":6,\\"note\\":\\"每句2分\\"},{\\"dim\\":\\"举例与表达\\",\\"points\\":\\"例子+通顺\\",\\"score\\":4}],\\"special\\":[\\"只背原文不讲解，表达项不得分\\"]}"}]}
]}

注意：item 用 categoryName（可自动建类别，默认 generic）或 categoryId 引用；questions 内联即自动进题库（返回新题 uuid），也可传 {"questionId":"已有题库题uuid"} 复用。behavior 是**题级**字段（2026-09-10）：内联题可显式给 speech_recite/speech_read/generic，不写则继承该类别默认；另可带 \`note\`（备注）与 \`knowledgeSummary\`（知识点概要），均可空、供向量检索。

**知识点关联（2026-09-10 起）**：每题可带 \`knowledgePoint\`:\"知识点名\"（课内不存在自动创建，同名复用）或 \`knowledgePointId\`（assess_course_get 输出里的已有知识点 id）；也可在 item 级给 \`knowledgePoint\` 作该类别下未显式指定题目的默认。每题关联**一个最核心**的知识点即可；知识点名要用该课真实覆盖的知识点（先 assess_course_get 看现有名称，**同名复用、不要同义造新名**，如「学而时习之」不要一会儿写「时习之」一会儿写「学而时习之章」）。考核结果会按知识点落库溯源，供后续按知识点看掌握度。

**选择题（2026-09-10 起支持）**：若某题本质是需要从几个候选里判断（题干常带「下列哪种/哪个…」），可把它写成选择题——题对象带 \`options\`:[{"key":"A","text":"…"},…]（通常 4 项），\`answer\` 填**正确项内容文本**（系统据此自动判定孩子口头作答「选 B」或说出正确内容，判分不进 LLM；建议每题配一个「正确的孩子做法/答案」作 answer 以便内容匹配兜底）。没有依赖选项的普通问答题仍是题干+answer+scoring 即可。

## 5. 孩子考核方法（assess_method_set）

一次设一个孩子：requireText 形如 "背诵:1,句意白话:1,道理:1"，excludeText 形如 "字词,典故"，recitePass 默认 90。方法按主题存、按孩子区分；同一主题不同孩子分别设。设完可用 assess_categories_list / assess_course_get 核对。

## 6. 写作纪律

1. 写前用 parent_library_courses 核对课程标题；用 parent_transcribe_media / parent_read_image 对准该课真实资料——**不编造原文与知识点**（尤其 answer 里的原文必须逐字与材料一致）。
2. 每课至少挂"方法要考的类别"的题；某个类别该课暂时无题 → 该类型考核时会被跳过（方法要求但无题的类别应告知家长）。
3. 旧 \`courses.assess_rubric\` 是未迁移课程的后备（存量 489 课迁移前仍走旧出题路径）；**迁移完成前不要用 parent_course_save 把新课写成旧 rubric**。
4. 知识点关联：每题挂一个最核心的知识点，**同名复用**（先 assess_course_get 核对该课现有知识点名）；知识点=该课实际教的知识点，不编造。
4. 写完后向家长汇报：哪些课已配、哪些类别缺题、哪个孩子方法已设。
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

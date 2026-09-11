/**
 * 课程考核内容编写规范（知识点制，2026-09-11）：家长 agent 用 assess_* 工具为课程
 * 写「知识点(名称+详情)→题目(题干+答案+评分)」结构化考核内容、为孩子设考核方法时的完整规范 + 示例。
 *
 * - 真源：本模块常量 COURSE_ASSESS_GUIDE_MD（随代码版本走，打包进 asar）。
 * - 运行副本：ensureAssessGuideFile() 在家长会话创建前幂等写到 data/.pi/agent/assess-rubric-guide.md，
 *   家长 agent 的 cwd=data/，用 read 相对路径 `.pi/agent/assess-rubric-guide.md` 即可细读。
 * - 模型：**每课的考核要点 = 该课的知识点**（knowledge_points.name + detail 详细描述）；
 *   课程挂知识点、知识点挂题目；结构化课程考核直接抽题；未挂题的课按知识点详情走 LLM 出题。
 */

import * as fs from "fs";
import * as path from "path";
import { getDataDir } from "./config";

export const ASSESS_GUIDE_FILENAME = "assess-rubric-guide.md";

/** 完整规范文档（agent 起草考核内容/考核方法前用 read 细读）。 */
export const COURSE_ASSESS_GUIDE_MD = `# 课程考核内容编写规范（家长 agent 专用 · 知识点制）

**模型**：每课的考核要点 = 该课的**知识点**。知识点有名称 + **详情（detail，要详细描述该知识点教什么、考核期望孩子答到什么）**；课程挂知识点、知识点挂题目（题库题可跨课复用）；课程已挂题后考核**直接抽题（不再逐课 LLM 现出题）**；未挂题的课，考核时按知识点详情由 LLM 出题。
你写内容用 **assess_* 工具**；旧字段 \`courses.assess_rubric\`（三段 markdown 考核要点）**已废弃，不要再写**。

## 0. 用什么工具

| 工具 | 用途 |
|---|---|
| assess_knowledge_points_list | 看主题（或某课）现有知识点（名称/详情/所属课程） |
| assess_course_get | 看某课已挂内容（知识点→题目：题干/答案/评分） |
| assess_content_save | **整课保存考核内容（主入口，事务替换）** |
| assess_method_set | 设置某孩子的考核方法（考哪些知识点各几题/不考哪些/背诵通过线） |
| parent_library_courses / parent_library_topics | 写前核对课程标题与主题（课程名以此为准，不要编造） |

## 1. 内容模型（一句话）

课程决定「有哪些知识点」（每课的知识点，name + detail）；每个知识点下挂题（同知识点多题=例题池，考核时随机抽 1）；题目用**题级 behavior** 决定评测方式：speech_recite（背诵）/ speech_read（朗读）走发音评测，generic（默认）走口述主观题判分。

## 2. 知识点（每课的考核要点）

- 每个 item = 一个知识点：\`knowledgePoint\`（名称，课内唯一，同名复用不新建）+ \`detail\`（**详情，务必详细**：该知识点教的内容、关键原文/字词/句意、考核期望孩子答到什么。它既用于未挂题课程的 LLM 出题，也是家长核对考核范围的依据）。
- 名称要用该课真实覆盖的知识点（先 assess_knowledge_points_list / assess_course_get 看现有名称，**同名复用、不要同义造新名**，如「学而时习之」不要一会儿写「时习之」一会儿写「学而时习之章」）。
- \`overview\`（可空）：该知识点在本课的补充说明。

## 3. 背诵/朗读题（★）

- 题目固定写法：\`stem\`=背诵/朗读任务描述（如"背诵本章原文"）、**\`answer\`=要背/读的标准原文（整段、逐字，评测 refText）**、scoring 可省略；\`behavior\` 显式给 "speech_recite"（背诵：不显示原文、发音评测、置该课首题、通过线取 recitePass 默认 90）或 "speech_read"（朗读跟读）。
- 不要在文字题里另出"背出原文"的题（会与系统背诵题重复）。

## 4. 文字口述题（generic）

每题三要素：
- \`stem\`：题干（无选项；要引原文就在题干里给出）
- \`answer\`：参考答案/得分要点（判分锚定）
- \`scoring\`：评分标准，建议 JSON 字符串：{"dims":[{"dim":"维度","points":"得分点","score":分值,"note":"说明"}],"special":["特殊情况"]}；写人话也可，越具体判分越准。
- \`pointMax\` 默认 10。

## 5. 整课保存示例（assess_content_save 的 payloadJson）

{"items":[
  {"knowledgePoint":"本章原文背诵","detail":"能逐字背诵本章原文；考核期望：完整、流利、无错字。","overview":"发音评测，90 分通过","questions":[{"stem":"背诵本章原文","answer":"子曰：学而时习之，不亦说乎？有朋自远方来，不亦乐乎？人不知而不愠，不亦君子乎？","behavior":"speech_recite"}]},
  {"knowledgePoint":"三章句意与道理","detail":"理解『学而时习之』『有朋自远方来』『人不知而不愠』三句的白话意思，并能联系生活举例说明『不愠』的君子态度。","questions":[{"stem":"请用自己的话讲一讲这三句话分别是什么意思，并举例。","answer":"三句白话要点…","scoring":"{\\"dims\\":[{\\"dim\\":\\"三句意思\\",\\"points\\":\\"复习→快乐/朋友来→快乐/不愠→君子\\",\\"score\\":6,\\"note\\":\\"每句2分\\"},{\\"dim\\":\\"举例与表达\\",\\"points\\":\\"例子+通顺\\",\\"score\\":4}],\\"special\\":[\\"只背原文不讲解，表达项不得分\\"]}"}]}
]}

注意：item 用 \`knowledgePointId\`（已有知识点 id，assess_knowledge_points_list / assess_course_get 输出里取）或 \`knowledgePoint\`（名称，不存在自动创建，可带 \`detail\` 更新详情）；questions 内联即自动进题库（返回新题 uuid），也可传 {"questionId":"已有题库题uuid"} 复用。behavior 是**题级**字段：内联题显式给 speech_recite/speech_read/generic（不写默认 generic）。另可带 \`note\`（备注）。

**选择题**：题对象带 \`options\`:[{"key":"A","text":"…"},…]（通常 4 项），\`answer\` 填**正确项内容文本**（系统据此自动判定孩子口头作答「选 B」或说出正确内容，判分不进 LLM）。

## 6. 孩子考核方法（assess_method_set）

一次设一个孩子：requireText 形如 "本章原文背诵:1,三章句意与道理:1"（**知识点名:题数**），excludeText 形如 "通假字,典故"，recitePass 默认 90。方法按主题存、按孩子区分；同一主题不同孩子分别设。设完可用 assess_knowledge_points_list / assess_course_get 核对。

## 7. 写作纪律

1. 写前用 parent_library_courses 核对课程标题；用 parent_transcribe_media / parent_read_image 对准该课真实资料——**不编造原文与知识点**（尤其 answer 里的原文必须逐字与材料一致）。
2. **知识点 detail 要写详细**（它是考核要点：出题与家长核对都依赖它）；空 detail 的知识点等于没有考核要点。
3. 每课至少给"方法要考的知识点"挂题；某知识点该课暂时无题 → 考该知识点时会被跳过（应告知家长）。
4. 旧 \`courses.assess_rubric\` 已废弃：**不要用 parent_course_save 写旧 rubric**，也不要在出题/判分语境引用它。
5. 写完后向家长汇报：哪些课已配、哪些知识点缺题、哪个孩子方法已设。
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

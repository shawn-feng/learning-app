/**
 * 场景技能 · 整理 / 找资料（台账 C1 C2 C3 C4 C7 C8）。
 */
import type { ParentSkill } from "./shared.js";
import { ironRules } from "./shared.js";

export const materialsSkill: ParentSkill = {
  name: "parent-scene-materials",
  title: "整理 / 找资料",
  triggers: "「资料库里都有什么」「这两份是不是重复」「把这几份归到一起」「这份不要了」「看看这张扫描页」「我传的这个文件里写了什么」",
  summary: "资料真源盘点 / 查重 / 移动改名 / 删除（默认演练）/ 读图片与聊天附件。",
  tools: [
    "parent_list_materials",
    "parent_read_material",
    "parent_move_material",
    "parent_delete_material",
    "parent_put_material",
    "parent_read_image",
    "parent_read_upload",
  ],
  body: `# 整理 / 找资料

## 什么时候用
家长问"资料库里都有什么"、要判断两份是否重复、要把散落文件归到一起 / 改名 / 移动、要删某份资料，或要看一张扫描页、聊天里传来的文件。

## 步骤
1. **先列清单**（\`parent_list_materials\`，**整理 / 找 / 删之前必做**）：看清现在有什么、路径是什么（返回的相对路径可直接给后面的工具用）。
   ⚠️ **家长没点名具体是哪一份时**（"这份资料不要了""这两份是不是重复"），**先列出候选把路径念给他挑**，再进下一步——不要空口反问"哪一份"（实测里就是这么答的，家长还得再描述一遍）。
2. 需要看内容时 \`parent_read_material\`（文本类，超 200KB 截断；**音视频/图片只回元数据**，要理解图片内容用 \`parent_read_image\`）。
3. **移动 / 改名 / 归并**：\`parent_move_material\`（会写入家长操作记录，可追溯）。
4. **删除**：\`parent_delete_material\` **默认只演练**——**对象不明先回到第 1 步列清单** → 复述要删的是哪一份 → 拿到"将删除清单"再复述一次并取得同意 → 最后带 \`confirm: true\` 真删（**不可回滚**）。
5. 要**造**新资料（互动练习页 / 绘本）：见 \`parent-scene-course\` 第 5 步（\`parent_build_material\`，需先配"编程 agent 模型"）。
6. **聊天附件**：家长上传后他的消息里会出现标记：\`【附件图片：文件名|引用】\`、\`【附件文件：文件名|引用】\`——把**引用值原样**传给 \`parent_read_image\`（图片）或 \`parent_read_upload\`（其他文件）。

## 参数速查（本场景工具）
- \`parent_list_materials\`：\`topic\`（可选，第一级目录名如 lunyu；不传=全部）· \`relPrefix\`（可选，路径前缀过滤，如 \`lunyu/materials\`）→ 每条给**相对路径**（可直接当 read / delete / move 的 path）。
- \`parent_read_material\`：\`path\`（必填，**来自 list 的相对路径**）→ 文本正文（超 200KB 截断）；音视频/图片只回**元数据**。
- \`parent_move_material\`：\`from\` + \`to\`（必填，都是相对路径）——**目标已存在会被拒绝**（不覆盖）；实现是"先写新路径、再删旧路径"，最坏留一份重复副本。
- \`parent_delete_material\`：\`path\`（必填）· \`confirm\`（**不传/false＝只演练**，返回"将删除清单"；\`true\`＝真删，不可回滚）。
- \`parent_put_material\`：\`path\` + \`content\`（必填，完整文本；单次 ≤2MB）。
- \`parent_build_material\`：\`title\` · \`requirement\`（越具体越好）· \`path\`（必填，**必须以 \`.html\`/\`.htm\` 结尾**）——造新资料走 \`parent-scene-course\` 第 5 步。
- \`parent_read_image\`：\`path\`（必填：材料库相对路径，**或**聊天里 \`【附件图片：文件名|引用】\` 的引用值**原样**填入）· \`question\`（可选，想重点问的）。
- \`parent_read_upload\`：\`ref\`（必填，\`【附件文件：文件名|引用】\` 里的引用值**原样**填入）。

## 口径
- 判断"是不是重复"要给依据（文件名、大小、内容要点对比），不要只凭文件名下结论。
- 整理方案（移动到哪、改成什么名、归并成几个）先复述再动手；批量操作分步做、每步说结果。
- 附件读不到时**如实转述工具给的原因**（例如"附件只在他的电脑上，需升级客户端后重发"，或"改用文字/截图说明"），**不要反复试探别的路径**。
- 清单很长时给"按主题/目录的概览 + 条数"，不要整表贴给家长。

## 红线
${ironRules("A3", "A6")}
- **资料真源与上传区是两个隔离区域**：不要自己拼路径、不要加 \`materials/\` 前缀、不要去试 \`uploads/\`、\`parents/\` 这类文件系统路径——试了只会白跑一圈（现场就是这么失败的）。

## 结束
复述"做了什么、影响哪些文件、现在清单长什么样"；删除类还要报告"已删 / 仍在"。`,
};

# ISSUE-153：导出对话框文件名不显示——全局样式 `.modal input{width:100%}` 会挤掉 modal 内一切「checkbox + flex 名称列」布局（✅ 已修复）

- **类型**：缺陷记录（✅ 已修复：客户端 2026-09-26 渲染层修复；服务端随 0.5.12 部署 201）
- **现象**：学习主题打包导出对话框（`TopicExportDialog.tsx`）勾选「打包多媒体资料」后，资料文件清单只显示勾选框和体积，**文件名整列空白**（2026-09-26 用户截图实证：千字文 60 个文件全部无名）。
- **根因（浏览器实测定位，非猜测）**：
  1. 静态 1:1 复刻对话框 DOM（无应用 CSS）→ 文件名**正常**；
  2. 挂上**完整构建 CSS**（web/dist/assets/index-*.css）→ 立刻复现，文件名 span 实测宽度 **0px**；
  3. 逐元素量 `getBoundingClientRect` → 同一行的 **checkbox input 被撑到 259px 宽**；
  4. 元凶 = `src/styles.css:388` 的全局规则 **`.modal input { width: 100% }`**——本意是弹窗里的文本输入框，但 checkbox 也是 `input`，同样命中；
  5. 文件名 span 是 `flex:1 + min-width:0 + overflow:hidden`（可收缩到 0），空间被 width:100% 的 checkbox 吃光后归零；体积列有内容尺寸得以幸存 ⇒ 最终形态 = 勾选框 + 体积、中间全空（正是截图）。
  - **为什么别的弹窗没炸**：多数弹窗的 label 文本是裸文本节点（匿名 flex 项，basis=auto 按内容尺寸），只有本对话框用了「flex-basis:0 的名称列」这种布局，才被挤成 0。
- **修复**：对话框内 3 个 checkbox（含资料开关/分组全选/单文件）全部内联重置 `width:"auto", margin:0, padding:0`（`CHECKBOX_STYLE` 常量，`src/components/TopicExportDialog.tsx`）；文件名行加 `title` 悬浮看完整路径。带完整 CSS 的复现页加同款内联重置后实测恢复（文件名 246px、长名正确省略）。
- **防复发建议（待拍板，未实施）**：
  ① 把 `.modal input { width:100% }` 收窄为文本输入选择器（如 `.modal input[type=text], .modal input[type=password], .modal input[type=email], .modal input:not([type])`）——一次性根治，但影响面需回归全部弹窗表单；
  ② 或约定「modal 内 checkbox/radio 必须内联重置」（现状做法，靠纪律）。
- **同轮顺带实施（需求变更，非本缺陷）**：按用户拍板取消单包 200MB 上限（服务端 `collectTopicPackage` 去掉累计校验、`index.ts` multipart `fileSize: Infinity`、对话框去掉超限红字/禁用），SERVER_VERSION bump 0.5.12 部署 201；**377MB 千字文整包**从 201 真实导出（39s）+ 跨机导入（`refreshed:true, courses:30, files:60`）实证通过。
- **关联发现（待拍板，未修）**：千字文部分课程的 `courses.material` 存的是**描述性长文本**（「学习资料 index.html（原文/章节翻译/…）；视频：千字文分段-01-….mp4」）而非 `topic/file` 标准路径——导入报告的 `missing_files` 会把这些非路径文本当"缺失资料"列出（逻辑上没错但显吵）。后续可：规范存量数据 + 导入/预览侧加「形如 `topic/file` 才算引用」的判断。
- **优先级**：低（已修复；防复发项为加固性质）
- **记录时间**：2026-09-26

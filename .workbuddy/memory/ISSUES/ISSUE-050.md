## [ISSUE-050] 考核出题改异步流式：首门课就绪即开考，其余课程后台生成并增量加入答题流
- **类型**：需求 / 交互优化（考核多门课不再阻塞等全部出完）
- **现象/诉求**：原 ExamView 等 `examGenerate` 一次性出完所有课程题目才渲染考试页；课程多时出题等待很久。
- **设计/实现（2026-09-05）**：
  - 出卷引擎本已逐课独立 LLM session（exam-engine `generateForCourse`），瓶颈只在「渲染时机」。
  - 主进程新增 `exam:generateCourse` IPC（exam-engine 新导出 `generateCourseQuestions`）；preload 暴露 `window.api.examGenerateCourse`。
  - `ExamView.startExam`：不再 await 全量出题 → 渲染空考试壳（`buildExamHtml([], title, subject, courses.length)`，模板 `pendingCourses` 传入总课程数），iframe onLoad（幂等 guard `streamStartedRef`）后 `beginStreaming` 并发池(≤3)逐门生成，**按课程顺序 flush** 用 postMessage `exam:addQuestions`（带剩余数）增量送达；单门失败跳过（空数组占位），全部失败 → error 退出。
  - `exam-template.ts` 支持：初始空题渲染"📥 正在生成第 1 门课的题目…"空态（`streamEmpty`）；监听 `exam:addQuestions` → `appendCourseQuestions` 全局重编号追加题流 + 刷新 nav/progress/done；`streamBanner` 显示"已就绪 X/N 门"；提交门槛：仍有课程未送达（remaining>0）禁止提交。
- **兼容**：非流式调用 `buildExamHtml(questions,...,0)`/`examGenerate` 保留原样。
- **状态**：本地 tsc 0 错 + electron-vite build 通过；asar 打包部署 201 实测中（待用户验证：多课场景首门即显示、后续逐门加入、全部就绪可提交）。

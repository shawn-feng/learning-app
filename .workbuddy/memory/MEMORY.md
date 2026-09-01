# 项目长期记忆（pi 学习伴侣）— 精简版

## 架构约定
- **孩子 prompt = 身份(systemPromptOverride) + 行为规范(AGENTS)**。行为规范全在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts) 经 `buildAgentsMd` 生成；`buildChildPrompt` 只写身份。
- **AGENTS 纯 SQLite(ISSUE-033)**：`data/agents.sqlite` 存用户版本(scope=child/ref=<id>；parent/ref=main)，`prompt_history` 可回退；无物理文件。编辑入口=家长页 AgentPromptEditor。`resolveChildAgents`：SQLite用户版本→buildAgentsMd。改 `LEARNING_NAV_INSTRUCTIONS` 随源码生效，无需跑脚本。
- **家长提示词统一不分场景**：`buildParentPrompt` 单版本；`getParentSession`/`getParentContentSession` 共用。工具：read/write/edit/ls/get_date/parent_course_save/delete/parent_stats/log_activity/move_file/copy_file。落盘 `data/.pi/agent/sessions/{parent|parent-content}/`。
- **recording=纯定时任务(ISSUE-024)**：`electron/lib/recording-prompt.ts` 为真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`，工具只挂 kb_query/kb_insert/kb_update。
- **⚠️ html 资料渲染：用 srcDoc + `asset://` 绝对地址（绝不能用 `<iframe src="file://">`）**。`rewriteHtmlAssetRefs` 把相对引用改写为 `asset://local/parent/<pid>/<topic>/<rel>`；`asset://` 与 `media://` 同特权(standard+secure)。坑：① `asset://local/...` 中 `local` 是 **host**，`new URL().pathname` 无 local，必须查 `segs[0]==='parent'`；② meta-refresh 占位页用 `followHtmlRedirect` 先跟随跳转；③ `registerSchemesAsPrivileged` 只能调一次(多 scheme 合并)。

## 关键 SDK 坑
- 扩展挂 `DefaultResourceLoader({extensionFactories:[...]})`；`createAgentSession({extensions})` 是死参数不读。
- Windows 下 `DefaultResourceLoader` 必须显式传 `agentDir`（孩子=`childDir/.pi/agent`，家长=`dataDir/.pi/agent`），否则 `undefined.startsWith` 崩。
- **customTools 的 name 必须同时出现在 `createAgentSession({tools})` 白名单**，否则被 isAllowedTool 过滤（报"没有这个技能"）。`ls/read/write/edit` 是 SDK 内置，只列 tools 即可。
- system prompt 是前缀缓存公共前缀：时间注入只到「日期」不到「秒」，否则缓存失效。
- 会话 append-only：重置用 `newSession()`(归档)，勿用 `resetLeaf()`。
- Pi SDK jsonl：`{"type":"message","message":{"role":user|assistant|toolResult,"content":[{type:text|thinking|toolCall}]}}`；提取文本只取 role∈{user,assistant} 且 content.type=text 的 part。
- **Electron 主进程 WebSocket 勿用 `ws` 包**（esbuild 打包报 bufferutil/utf-8-validate 解析失败）→ 用 Node22+/Electron 内置全局 WebSocket(undici)。

## 构建与验证
- 沙箱内禁止 `git stash`（戳坏 .git/refs）；未提交改动用 `git diff`/`git show HEAD:<file>`。
- 改动后 `rm -rf out && npm run build`(electron-vite)。
- `tsc --noEmit` 长期有 5 条环境告警(TS2318/TS2552, @types/node26 不兼容)会掩盖真实错误——先过滤这 5 条；改组件核对 Props 是否都解构(ISSUE-008 白屏即此)。
- vitest(threads 池)：用例残留 `setInterval` 致 worker 静默 exit 1（改 `vi.spyOn(global,"setImmediate")`+finally mockRestore）；**Windows 盘符小写 bug(#10692)**：跑 vitest 前先 `cd "C:/Users/79734/Documents/pi"`(大写盘符)，Git Bash 小写触发 describe 0 test。

## React 状态坑
- 绝不依赖 `setState(updater)` 闭包同步读外部变量；派生行为一律 `useEffect` 监听(ISSUE-014)。

## 产品约束（用户明确）
- **学习资料重发必须重显(ISSUE-021)**：即使 100% 相同(path/hash 同)，列表也必须把最近一次重新选中并显示在最新位置；去重仅避免同一轮多份同 path 堆积。
- **ISSUE-018 每课压缩会话暂缓**。

## 前后端分离 / SPLIT（2026-08-27 收敛）
- 核心=多设备共享数据；双独立安装包(客户端/服务端，版本各自升级)。写操作必须在线；已缓存资料断网离线可读。会话 jsonl 留客户端本地不上服务端；学习记录永远在服务端。
- **⚠️ 服务端部署边界**：`learning-server`(端口8788) **只部署家庭局域网 201(192.168.1.201 /opt/learning-server/)，不部署公网 ECS(47.96.154.226)**。公网 ECS 只跑 `learning-cloud`(静态下载+/api/version)。发布勿推服务端二进制到 ECS。
- **服务端构建**：正确=`node scripts/build.mjs && node scripts/pkg.mjs linux`(build.mjs esbuild 直编 `src/index.ts`→`dist/server.cjs`)。❌ 勿用 `npm run build`(=tsc，不产生 server.cjs，会打包陈旧版)。校验：部署后 `curl /api/v1/version` 返回目标版本。
- **201 客户端升级**：先 `pkill -TERM -f '/opt/学习伙伴/xuexihub'` 停旧进程，再 `sudo dpkg -i learning-app_x.y.z_amd64.deb`。GUI 无法 SSH 启动，需桌面重开。

## 客户端自动更新（ISSUE-040）
- Windows：NSIS + `*.exe.blockmap` 差量。macOS：实际是降级全量下载（`build.mac.target` 只有 dmg 无 zip、feed 无 `latest-mac.yml`），需加 zip 产物+发布到 OSS feed+download_url 按平台返回才支持差量。feed 地址 `https://www.aixuexihao.top/download/`。

## 学习考核（2026-09-01 完成，EXAM-REQUIREMENTS.md）
- 架构：存储(内容/记录/语音)全在服务端；出卷+判分在客户端本地 LLM 内存 session；判分 prompt 服务端下发(单一真源)；仅最终结果写 server DB。考试视图=HTML 模板(iframe srcDoc + allow=microphone，sandbox 禁资料/导航/AI)。
- 关键文件：`electron/lib/exam.ts`、`exam-engine.ts`(generateExamQuestions/scoreExamAttempt)、`server/src/routes/exam.ts`、`src/components/ExamView.tsx`/`ExamRecords.tsx`、`src/lib/exam-template.ts`。
- **判分必带 rubric**：`ExamAnswerIn.rubric` 由 ExamView 从 `examTopic.courses` 按 course 匹配 assessRubric 传入。出卷/判分 session 按 childId 隔离。

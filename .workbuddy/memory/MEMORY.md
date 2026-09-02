# 项目长期记忆（pi 学习伴侣）

## 架构约定
- **孩子 prompt = 身份(systemPromptOverride) + 行为规范(AGENTS)**；行为规范全在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts) 经 `buildAgentsMd` 生成，`buildChildPrompt` 只写身份。AGENTS 纯 SQLite(ISSUE-033)：`data/agents.sqlite`，无物理文件；编辑入口=AgentPromptEditor。
- **家长提示词统一不分场景**：`buildParentPrompt` 单版本；工具 read/write/edit/ls/get_date/parent_course_save/delete/parent_stats/log_activity/move_file/copy_file。
- **recording=纯定时任务(ISSUE-024)**：`electron/lib/recording-prompt.ts` 真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`，工具只挂 kb_query/kb_insert/kb_update。
- **⚠️ html 资料：srcDoc + `asset://` 绝对地址（禁 `<iframe src="file://">`）**。`rewriteHtmlAssetRefs` 改相对引用为 `asset://local/parent/<pid>/<topic>/<rel>`。坑：①`asset://` 中 `local` 是 **host**，pathname 无 local，查 `segs[0]==='parent'`；②meta-refresh 占位页用 `followHtmlRedirect` 先跟随；③`registerSchemesAsPrivileged` 只能调一次。

## 关键 SDK 坑
- 扩展挂 `DefaultResourceLoader({extensionFactories})`；`createAgentSession({extensions})` 死参数不读。
- Windows 下 `DefaultResourceLoader` 必须显式传 `agentDir`（孩子=`childDir/.pi/agent`，家长=`dataDir/.pi/agent`），否则 `undefined.startsWith` 崩。
- **customTools 的 name 必须同时进 `createAgentSession({tools})` 白名单**；`ls/read/write/edit` SDK 内置只列 tools。
- system prompt 是前缀缓存公共前缀：时间注入只到「日期」不到「秒」。
- 会话 append-only：重置用 `newSession()`(归档)，勿用 `resetLeaf()`。
- **`createAgentSession` 返回值必须解构 `{ session }`**（exam-engine 曾直接当 session 用 → `dispose is not a function` 崩）。
- Pi SDK jsonl：`content:[{type:text|thinking|toolCall}]`；提取只取 role∈{user,assistant} 且 type=text。
- 主进程 WebSocket 勿用 `ws` 包（esbuild 打包报 bufferutil 解析失败）→ 用内置全局 WebSocket。

## 构建与验证
- 沙箱禁 `git stash`（戳坏 .git/refs）；用 `git diff`/`git show HEAD:<file>`。
- `rm -rf out && npm run build`(electron-vite)；`tsc --noEmit` 先过滤 5 条环境告警(TS2318/TS2552)再看业务错；改组件核对 Props 解构(ISSUE-008)。
- vitest：用例残留 `setInterval` 致 worker 静默 exit 1（`vi.spyOn(global,"setImmediate")`+finally mockRestore）；**Windows 盘符小写 bug(#10692)**：跑 vitest 前先 `cd "C:/Users/79734/Documents/pi"`(大写盘符)。
- **跑真实 LLM 的 vitest**：`PI_TEST_DATA_DIR` 指向 Temp 隔离 → 需把真实 `auth.json`+`app-settings.json` 拷到 `$TEMP/pi-test-data/parents/<pid>/`，`setCurrentParentId(pid)`，并 `delete globalThis.__learningAppModelRuntime`（runtime 全局缓存不区分家长，否则复用 _guest 空 auth 回退 qwen-tokenplan 无 key 崩）。

## React 状态坑
- 绝不依赖 `setState(updater)` 闭包同步读外部变量；派生行为一律 `useEffect`(ISSUE-014)。

## 产品约束（用户明确）
- **学习资料重发必须重显(ISSUE-021)**：即使 100% 相同，列表也必须重新选中显示在最新位置；去重仅避免同轮多份堆积。
- **ISSUE-018 每课压缩会话暂缓**。

## SPLIT / 服务端（2026-08-27 收敛）
- 核心=多设备共享数据；双独立安装包；写在线、缓存资料断网可读；会话 jsonl 留客户端，学习记录永远在服务端。
- **⚠️ 部署边界**：`learning-server`(8788) 只部署家庭局域网 201(192.168.1.201 /opt/learning-server/)，**不部署公网 ECS(47.96.154.226)**；ECS 只跑 `learning-cloud`。
- **构建**：正确=`node scripts/build.mjs && node scripts/pkg.mjs linux`（build.mjs esbuild 直编→dist/server.cjs）。❌ 勿用 `npm run build`(=tsc，不产 server.cjs 会打包陈旧版)。改 src 后确认 `ls dist/server.cjs` mtime 是新的（必要时 rm 强制重建）。改 INSERT 列数必须数 VALUES 占位符。
- **201 客户端升级**：先 `pkill -TERM -f '/opt/学习伙伴/xuexihub'` 再 `sudo dpkg -i learning-app_x.y.z_amd64.deb`；GUI 无法 SSH 启动。

## 客户端自动更新（ISSUE-040）
- Windows：NSIS+blockmap 差量。macOS：实际降级全量下载（target 只有 dmg 无 zip、feed 无 latest-mac.yml），需加 zip+发布到 OSS feed+download_url 按平台返回。feed=`https://www.aixuexihao.top/download/`。

## 学习考核（EXAM-REQUIREMENTS.md，细节索引=ISSUES.md ISSUE-027）
- **架构**：存储全服务端；出卷+判分客户端内存 session；判分 prompt 服务端下发(单一真源)；考试视图=iframe srcDoc+allow=microphone 锁定。
- **v2 排期**：`exam_schedules` 表（固定多档+自定义）；同日多档去重取周期最长档；懒生成含当天（anchor 起步，勿用 anchor+step——会漏当天考核）。
- **v3/v3.1 选课 LLM + 标签管理**：固定考核只留 **每天/每周**（每周可设周几几点 `weekly{weekday,time}`，ensureFixedSchedules 按 weekday 定位）；config 两段式（?schedule=→selectionPrompt+candidates 无 rubric；&courses=a,b→rubric+scoringPrompt）；服务端打「★ 本周期/★ 本月/◐ 本月前」标记，LLM 按标记选课不自己算日期（freq="custom" 不打标记）；**自定义考核每个有自己的 scope.prompt+日期时间**（带 prompt 走选课两段式）；**config 第二段 courses 参数须在 scope 分支内优先处理**（否则自定义拿不到 rubric）；选课结果清理「[主题] 」前缀。家长端入口=家长中心左侧边栏 ExamAdminPanel。
- **判分必带 rubric**（ExamAnswerIn.rubric 由 ExamView 传入）；出卷/判分 session 按 childId 隔离。

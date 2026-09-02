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
- **⚠️ pkg 二进制已不可用**：`@earendil-works/pi-coding-agent`(agent SDK, type=module) 用 `import("node:fs")` 动态导入，esbuild 无法静态化→ `server.cjs` 含 `import()`；pkg v6.22.0 的 VM 沙箱报 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` 起不来（0.1.2 无 agent SDK 时正常）。**201 现改用 `node /opt/learning-server/server.cjs` 直接跑 esbuild 产物**（201 有 Node v24.15.0，位于 /usr/bin/node）；service 文件 `ExecStart=/usr/bin/node /opt/learning-server/server.cjs`，`Environment=SERVER_DATA_DIR=/opt/learning-server/data`。旧 pkg 二进制备份为 `/opt/learning-server/learning-server.pkg030`。
- **201 客户端升级**：先 `pkill -TERM -f '/opt/学习伙伴/xuexihub'` 再 `sudo dpkg -i learning-app_x.y.z_amd64.deb`；GUI 无法 SSH 启动（SSH 杀 GUI 进程会 permission denied，但 dpkg 已原地覆盖二进制，用户下次本地启动即新版）；验证 `dpkg -l learning-app` 显示 `ii learning-app x.y.z amd64`。

## 发布流程（客户端/服务端 公网+201）— 2026-09-02 实测
- **本地 Windows 无法产出 Linux/Mac 安装包**：electron-builder 在 Windows 上打 linux 需要 `fpm`(deb)/`mksquashfs`(AppImage)，均不存在→`--linux deb` 直接报缺 fpm 失败，全量 `dist:linux` 因 AppImage 的 mksquashfs 失败而整体中止（deb 也不会产出）。➡️ **Linux deb + Mac dmg 只能走 GitHub Actions CI**（build-linux.yml/build-mac.yml，tag 触发），用 `gh run download <id> --repo shawn-feng/learning-app` 取产物。
- **GitHub Push Protection 误报**：`test/assessment.test.ts:59` 的假测试桩 `REPLACE_WITH_YOUR_TENCENT_SOE_SECRET_ID`(纯占位，非真实腾讯云密钥) 被 GitHub secret scanning 判为 Tencent SecretId，整推 `git push github` + tag 全拒（GH013）。本机 gh 登录 shawn-feng 且 v0.1.7 曾成功推送——问题只在那串假值。**解法**：`git filter-repo --replace-text`（managed venv 装 git-filter-repo）把假值替换为 `REPLACE_WITH_YOUR_TENCENT_SOE_SECRET_ID` 占位，重写历史后 `git push github --force` + `--tags --force`，并 `git remote add origin <gitee>` 同步强推。重写后 `v0.1.8`=新 SHA，CI 正常触发。⚠️ 以后别再往测试塞长得像云厂商密钥的串。
- **公网发布（feed=https://www.aixuexihao.top/download/）**：① `scripts/publish-update.py` 只处理 windows(latest.yml+exe+blockmap)；linux/mac 需手动：用 managed venv 的 `oss2` 把 `learning-app_*.deb`/`*.AppImage`/`*.dmg`/`latest-linux.yml`/`latest-mac.yml` 传到 OSS `aixuexihao-app/learning-app/`（public-read）；② 再用 `scripts/aliyun-run.py "<cmd>"` 在 ECS `i-bp15zfctbt147ktl39pk`(cn-hangzhou) 执行 `curl -fsSL <oss-public-url> -o <中文名>` 把文件拉进 `/opt/learning-cloud/download/`（nginx 站点 `learning-cloud` 即对外提供）；中文对象名 URL 需 `urllib.parse.quote` 编码。`/api/version` 仍单一下载链接(指向 windows exe)，Linux/Mac 走 `latest-linux.yml`/`latest-mac.yml` 原生 feed。
- **electron-updater feed 格式**：`latest-linux.yml` 的 `path` 用 AppImage（linux 标准自更新 artifact），`files` 列 deb+AppImage；`latest-mac.yml` 的 `files` 每项带 `arch: arm64|x64`，`path` 用 arm64 dmg（仅 dmg 无 zip 的降级全量）。sha512=base64(sha512(file))，size=文件字节。

## 客户端自动更新（ISSUE-040）
- Windows：NSIS+blockmap 差量（latest.yml 已发布，0.1.8 验证通过）。
- macOS：0.1.8 起已发布 `latest-mac.yml`(含 arm64/x64 dmg + arch 字段)，但**仍只有 dmg 无 zip**，故依旧是降级全量下载；差量(zip+blockmap)与主进程 `download_url` 按平台返回仍未做（用户 2026-09-02 明确"暂时都不做"mac 差量）。Linux 同理：0.1.8 起发布 `latest-linux.yml`(AppImage 为 path)，但 201 客户端走 dpkg 手动升级，不走 linux 自更新。feed=`https://www.aixuexihao.top/download/`。

## 学习考核（EXAM-REQUIREMENTS.md，细节索引=ISSUES.md ISSUE-027）
- **架构**：存储全服务端；出卷+判分客户端内存 session；判分 prompt 服务端下发(单一真源)；考试视图=iframe srcDoc+allow=microphone 锁定。
- **v2 排期**：`exam_schedules` 表（固定多档+自定义）；同日多档去重取周期最长档；懒生成含当天（anchor 起步，勿用 anchor+step——会漏当天考核）。
- **v3/v3.1 选课 LLM + 标签管理**：固定考核只留 **每天/每周**（每周可设周几几点 `weekly{weekday,time}`，ensureFixedSchedules 按 weekday 定位）；config 两段式（?schedule=→selectionPrompt+candidates 无 rubric；&courses=a,b→rubric+scoringPrompt）；服务端打「★ 本周期/★ 本月/◐ 本月前」标记，LLM 按标记选课不自己算日期（freq="custom" 不打标记）；**自定义考核每个有自己的 scope.prompt+日期时间**（带 prompt 走选课两段式）；**config 第二段 courses 参数须在 scope 分支内优先处理**（否则自定义拿不到 rubric）；选课结果清理「[主题] 」前缀。家长端入口=家长中心左侧边栏 ExamAdminPanel。
- **判分必带 rubric**（ExamAnswerIn.rubric 由 ExamView 传入）；出卷/判分 session 按 childId 隔离。

## 学习计划（ISSUE-033，2026-09-02 需求锁定 vFinal5，未实施）
- 学习计划=「每天学什么」逐日排期表（服务端 study_plan_items：date 定日 / daily 每日 行 + origin carry 顺延）；**直接替换 rules_json.daily 不共存**；**存量不迁移**（R2 拍板：旧设置作废、家长对话重建）；无 school/holiday、无自动挑选算法。
- 制定=家长对话：agent 起草逐日安排（查内容结构、疑问先问家长不擅自猜）→ 家长确认生效；工具 study_plan_create/update/list/get + study_plan_sources（R3 只读课程结构，起草专用）；注册点=家长会话 tools 白名单 pi-session.ts:442-446/516/562 + customTools + buildParentPrompt 内联散文。空天不学；未完成加到下一天持续累加；多计划同天合并。
- 执行：gen 展开读服务端**当日聚合**生成 `[家长]` todo（客户端 scheduler / server worker 通用，学习计划只在客户端展示）；**服务端每日定时检测当日完成、未完成顺延叠加到下一天**（carry 服务端做）；todo-scheduler.ts:108-120 buildParentLines 替换 rules.daily 分支。
- UI：家长中心侧边栏「学习计划」只读面板（Dashboard view 加 "plan"）+ ChildDetailPage TABS 加 plan；编辑仍走对话。⚠️ 编号历史：033 曾用于 AGENTS 纯 SQLite（归档 ISSUES-archive-2026-08-30）。
- **P0/P0b/P2 已实施（2026-09-02）**：server.sqlite `study_plan_items` 表（schema v9）+ `routes/study-plans.ts`（CRUD + GET /study-plans/today 聚合 + GET ?date= 过滤；today 展平 items[{planId,text,topicKey,carry}]）；`worker/study-plan-carry.ts` 每日顺延 tick（幂等 worker_state child+'study_plan_carry'.last_key=昨天；判定=child_todo_stats 昨天 parent_total/parent_done 有数据且未达标才顺延，stats 缺失不臆断；顺延=昨天 items 中今天未排 text → 今天 origin=carry 行去重写入）；custom-tools.ts 5 工具（create 先 GET ?date= 查重 / update act=replace|removeItems|delete+id 唯一前缀 / list / get / sources）+ pi-session.ts 两会话挂载 + buildParentPrompt「2.5 学习计划」专节。⚠️ 家长 prompt 用户版本优先：已存用户版本不自动吃到新段落。验证：verify-study-plans.mjs 13/13 + verify-study-plan-carry.mts 4/4。P3 展开替换 / P4 只读 UI 未做。

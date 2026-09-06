# 项目长期记忆（pi 学习伴侣）

## 架构约定
- **孩子 prompt** = 身份(systemPromptOverride) + 行为规范(AGENTS)。行为规范在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts) 经 `buildAgentsMd` 生成，`buildChildPrompt` 只写身份。AGENTS 纯 SQLite(ISSUE-033)：`data/agents.sqlite`；编辑入口=AgentPromptEditor。
- **家长提示词统一不分场景**：`buildParentPrompt` 单版本；工具见 ISSUE-055（含课程资料类、学习计划、todo、家长库读）。
- **recording=纯定时任务(ISSUE-024)**：`electron/lib/recording-prompt.ts` 真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`，工具只挂 kb 三件。客户端仅当服务端不报 `worker` feature 时启用本地调度（向后兼容）。
- **⚠️ 学习资料 html 真源=服务端（SPLIT 方案 A）**：磁盘 `SERVER_DATA_DIR/materials/<parentId>/<topic>/...`（默认 cwd/data，SERVER_DATA_DIR 覆盖；`materialsRoot(dataDir,parentId)=dataDir/materials/parentId`）。客户端本地 `data/parents/*/materials/` 仅旧残留，非真源。courses.html_path 存相对路径。渲染 srcDoc + `asset://`/`media://` 远程代理到 `/api/v1/materials/content/{id}`（id=base64url 相对 materials 根的 posix 路径）。坑：①`asset://` 中 `local` 是 host；②meta-refresh 占位用 `followHtmlRedirect` 先跟随；③`registerSchemesAsPrivileged` 只能一次；④resolveMediaTarget 需 topic/media/ 结构。

## 关键 SDK 坑
- customTools 的 name **必须同时进 `createAgentSession({tools})` 白名单**；ls/read/write/edit SDK 内置。
- Windows `DefaultResourceLoader` 必须显式传 `agentDir`（孩子=`childDir/.pi/agent`，家长=`dataDir/.pi/agent`），否则崩。
- system prompt 是前缀缓存公共前缀：时间只到「日期」不到「秒」。
- 会话 append-only：重置用 `newSession()`(归档)，勿用 `resetLeaf()`。
- `createAgentSession` 返回值必须解构 `{ session }`，否则 dispose 崩。
- Pi SDK jsonl 提取只取 role∈{user,assistant} 且 type=text。
- 主进程 WebSocket 勿用 `ws` 包 → 用内置全局 WebSocket。

## ⚠️ prompt 模板字符串内禁字面反引号（两端打包运行时崩，9/3 复现）
`recording-prompt.ts` 的 `RECORDING_PROMPT`、`pi-session.ts` 的 `LEARNING_NAV_INSTRUCTIONS` 内部不得出现未转义反引号，一律 `\`` 转义（行内代码、代码围栏均如此）。esbuild/electron-vite 打包与 `node --check` 都查不出，仅运行时崩。写法：行内代码去反引号/用 `\``，代码块围栏用 `~~~`；server 与 electron 两份 recording-prompt.ts 须同源同步。

## 服务端 worker 调度（方案B，当前真源）
- **cron=每 5 分钟**（`*/5`）。`scheduler.ts`：`runPlanTick → runStatTick → runWorkerTick(recording)`。
- **runPlanTick**：先 carry（游标=昨天，纯 SQL 顺延未完成排期行），再 gen=以最新 study_plan_items 当日排期物化今日 parent todo_items（家长中途改计划 ≤5min 反映；孩子自规划项绝不动）。
- **runStatTick**：事件驱动、当天可多次（勿回退「一天一次」）——今天有 todo_items 且 daily 有记录才跑；去重=worker_state `todo_stat`.last_key=`{date,count}`，**daily 条数新增→下次 tick 重跑**。stat 纯代码按 courses first_learned/last_review==今天→①回写 study_plan_items done ②按 plan_id 勾今日 parent todo ③汇总 child_kb `child_todo_stats`。⚠️**勾 todo 判定勿用 `r.status`**（load 的陈旧内存值→todo 永不勾），须用 `doneOfPlan`（9/4 实证）。
- 游标：gen 无；stat=`todo_stat`.last_key；carry=`study_plan_carry=昨天`。

## 学习计划 / todolist（ISSUE-033 多列表，不兼容旧）
- **主库 `study_plan_items`（一课一行）**：`parent_id/child_id/date/topic_key/course_name/mode('new'|'review')/origin('conversation'|'carry')/status('pending'|'done'|'carried')/done_at/active`；**完成态由 stat 回写**。旧表启动就地转换（`migrateStudyPlanV2`，meta study_plan_v2_migrated 幂等）；全量脚本 `server/scripts/migrate-study-plan-v2.mts <dataDir>`。
- **孩子 kb `todo_items`（一事一行）**：`child_id/todo_date/title/source('parent'|'child')/plan_id/status/done_at/note/sort`；child_todo_stats 由它汇总。
- **kb.todo ops**：list/add(仅 child)/addParent(source=parent,plan_id)/set/remove(仅 child)/removeByPlan(仅 parent)。⚠️写操放 execHandlers、读放 queryHandlers，放错 registry 运行时报错。
- 服务端 /study-plans 与 /today 下发每行 `done`（家长面板以服务端为准，客户端不现算）。
- 工具契约：`todo_list`=read/add/check/uncheck/remove 结构化；`study_plan_update` 行级 act=delete/reschedule/setmode。家长排课「复习：」前缀在 agent-tool 入口归一为 mode=review。plan-text.ts 已删。
- 验证：`server/scripts/verify-study-plan-v2.mts`(10/10)。勿与 exam 工作混入本提交。

## 学习考核（EXAM，ISSUE-027）
存储全服务端；出卷+判分客户端内存 session；判分 prompt 服务端下发。v3 固定考核只留每天/每周（`weekly{weekday,time}`）；config 两段式（?schedule=选课无 rubric；&courses=带 rubric+scoring）。家长端 ExamAdminPanel。

## SPLIT / 部署边界
- `learning-server`(8788) 只部署家庭局域网 **201(192.168.1.201)**；公网 ECS(47.96.154.226) 只跑 `learning-cloud`。
- **服务端构建**：`node scripts/build.mjs`（esbuild→dist/server.cjs），勿用 `npm run build`(tsc 不产)。
- **201 跑 `node /opt/learning-server/server.cjs`**（pkg 二进制不可用：agent SDK 动态 import）；service `ExecStart=/usr/bin/node ...`，`Environment=SERVER_DATA_DIR=/opt/learning-server/data`。
- **201 客户端升级**：`sudo dpkg -i learning-app_x.y.z_amd64.deb`（验证 `dpkg -l` 显示 ii）；dpkg 只覆盖磁盘，**须 201 本地手动重启「学习伙伴」** 才生效（SSH 杀不掉桌面进程）。
- **⚠️ 材料 content 404 运维坑（9/6 实证）**：`/materials/content/:id` **只查 `server.sqlite.materials` 索引表不扫磁盘**（scanMaterials 仅 /materials/list/upload 触发）。绕过 upload 手工丢磁盘→索引缺→404。修复=幂等补索引（VACUUM INTO 备份 + INSERT..ON CONFLICT，模板 tmp/deploy/fix_yunlv_index.js）。**教训：往 201 放资料务必走 /materials/upload**。
- **⚠️ 材料视频「有声无画」= HEVC/H.265（9/6 实证）**：Linux Electron 的 Chromium `<video>` **不支持 H.265 解码**（无内置 HEVC/Ubuntu 无硬解），表现=AAC 有声、视频黑屏。判定：201 `ffprobe` 看 `codec_name=hevc|hvc1`。修复=ffmpeg 转 **H.264**：`-c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -profile:v main -movflags +faststart -c:a aac -b:a 128k`；**先 cp 备份**原文件到 data/backups，转临时→验证 codec→覆盖同路径（html/src 不变）→node 刷新索引 size。含 moov 的都需 faststart（Range 播放）。参考 tmp/deploy/transcode_yunlv.py+replace_yunlv.py。
- 健康路由=`/api/v1/health`；/health 404。
- 201 凭据：SSH `shanshan`/`123456`（sudo 同）；部署脚本模板 tmp/deploy/*.py。
- Actions 构件下载需 API token：`gh auth token`；大文件 run_in_background（首跑 SIGTERM）。

## 构建 / 验证
- 沙箱禁 `git stash`；用 git diff / git show HEAD:&lt;file&gt;。`rm -rf out` 被拦→直接 `npm run build`(自清)。`tsc --noEmit` 先滤 5 条环境噪音看业务错。
- vitest：残留 setInterval 致 exit 1（spy setImmediate+restore）；**Windows 盘符 bug(#10692)**：先 `cd "C:/Users/79734/Documents/pi"`（大写盘符）。
- 跑真实 LLM 的 vitest：PI_TEST_DATA_DIR→Temp，拷真实 auth.json+app-settings.json，setCurrentParentId，删 `globalThis.__learningAppModelRuntime`。

## React / 产品约束
- 绝不依赖 setState(updater) 闭包同步读外部；派生行为一律 useEffect(ISSUE-014)。
- **学习资料重发必须重显(ISSUE-021)**：即便 100% 相同也重新选中显示最新。
- ISSUE-018 每课压缩会话暂缓。

## 发布流程
- 本地 Windows 出不了 Linux/Mac 包（缺 fpm/mksquashfs）→ GitHub Actions CI（tag 触发），`gh run download <id> --repo shawn-feng/learning-app`。
- Push Protection：测试别塞类云密钥串。
- 公网 feed=`https://www.aixuexihao.top/download/`：windows 走 publish-update.py；linux/mac 手动 oss2 + aliyun-run.py 拉 ECS `/opt/learning-cloud/download/`。
- **⚠️ publish-update.py 只传 OSS 不拷 ECS 本地！** windows exe/blockmap/latest.yml 必须再 aliyun-run 拷 ECS，否则 /download/latest.yml 旧版（0.1.9 中招）。
- electron-updater：latest-linux.yml path=AppImage；latest-mac.yml 每项带 arch；windows 包名含空格→URL 空格编 `%20`。

## 近期 ISSUE 速查（详见 ISSUES.md / 日志）
- ISSUE-055（本次处理中）：家长 agent 缺上传资料到 server 工具 → custom-tools.ts 新增 `parent_upload_material`（复用 parent-library.ts uploadMaterialToServer），注册到 pi-session.ts 双家长会话 tools+customTools。
- ISSUE-054：按主题分会话=退步，不采纳，改进新课注入上課摘要。
- ISSUE-052/053：qwen token-plan 单层响应 pickText 多路径 / config-sync scheduler_config 深合并保 classTimes。

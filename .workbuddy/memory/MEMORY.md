# 项目长期记忆（pi 学习伴侣）

## 架构约定
- **孩子 prompt** = 身份(systemPromptOverride) + 行为规范(AGENTS)。行为规范全在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts) 经 `buildAgentsMd` 生成，`buildChildPrompt` 只写身份。AGENTS 纯 SQLite(ISSUE-033)：`data/agents.sqlite`，无物理文件；编辑入口=AgentPromptEditor。
- **家长提示词统一不分场景**：`buildParentPrompt` 单版本；工具 read/write/edit/ls/get_date/parent_course_save/delete/parent_stats/log_activity/move_file/copy_file + 学习计划 5 工具(study_plan_create/update/list/get/sources) + parent_library_topics/courses（读家长库）。
- **recording=纯定时任务(ISSUE-024)**：`electron/lib/recording-prompt.ts` 真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`，工具只挂 kb_query/kb_insert/kb_update。**客户端仍保留 recording 本地调度，仅当服务端未报 `worker` feature 时启用（向后兼容）。**
- **⚠️ html 资料：srcDoc + `asset://` 绝对地址（禁 `<iframe src="file://">`）**。`rewriteHtmlAssetRefs` 改相对引用为 `asset://local/parent/<pid>/<topic>/<rel>`。坑：①`asset://` 中 `local` 是 **host**；②meta-refresh 占位页用 `followHtmlRedirect` 先跟随；③`registerSchemesAsPrivileged` 只能调一次。

## 关键 SDK 坑
- 扩展挂 `DefaultResourceLoader({extensionFactories})`；`createAgentSession({extensions})` 死参数不读。
- Windows 下 `DefaultResourceLoader` 必须显式传 `agentDir`（孩子=`childDir/.pi/agent`，家长=`dataDir/.pi/agent`），否则 `undefined.startsWith` 崩。
- **customTools 的 name 必须同时进 `createAgentSession({tools})` 白名单**；`ls/read/write/edit` SDK 内置只列 tools。
- system prompt 是前缀缓存公共前缀：时间注入只到「日期」不到「秒」。
- 会话 append-only：重置用 `newSession()`(归档)，勿用 `resetLeaf()`。
- **`createAgentSession` 返回值必须解构 `{ session }`**（否则 `dispose is not a function` 崩）。
- Pi SDK jsonl：`content:[{type:text|thinking|toolCall}]`；提取只取 role∈{user,assistant} 且 type=text。
- 主进程 WebSocket 勿用 `ws` 包（esbuild 打包报 bufferutil）→ 用内置全局 WebSocket。
- **⚠️ prompt 模板字符串内禁字面反引号（两端打包都会崩）**：反引号模板字符串定义的长 prompt（`recording-prompt.ts` 的 `RECORDING_PROMPT`）内部不得出现未转义反引号（行内代码、代码块围栏）。esbuild(server.cjs) 与 electron-vite(rollup) 打包都会让模板字符串提前闭合 → 启动即崩 `TypeError: [] is not a function`（server 9/3 0点、electron 9/3 7点各踩一次）。写法：行内代码去反引号、代码块围栏用 `~~~`；server 与 electron 两份 recording-prompt.ts 必须同源同步。

## 构建与验证
- 沙箱禁 `git stash`（戳坏 .git/refs）；用 `git diff`/`git show HEAD:<file>`。
- `rm -rf out` 被沙箱拦截 → 直接 `npm run build`(electron-vite 自清)；`tsc --noEmit` 先过滤 5 条环境告警再看业务错。
- vitest：残留 `setInterval` 致 worker exit 1（`vi.spyOn(global,"setImmediate")`+finally mockRestore）；**Windows 盘符小写 bug(#10692)**：跑前先 `cd "C:/Users/79734/Documents/pi"`(大写盘符)。
- **跑真实 LLM 的 vitest**：`PI_TEST_DATA_DIR`→Temp 隔离，拷真实 `auth.json`+`app-settings.json` 到 `$TEMP/pi-test-data/parents/<pid>/`，`setCurrentParentId(pid)`，并 `delete globalThis.__learningAppModelRuntime`。

## React / 产品约束
- 绝不依赖 `setState(updater)` 闭包同步读外部变量；派生行为一律 `useEffect`(ISSUE-014)。
- **学习资料重发必须重显(ISSUE-021)**：即使 100% 相同，列表也必须重新选中显示在最新位置。
- **ISSUE-018 每课压缩会话暂缓**。

## 服务端 worker 调度（方案B，当前真源）
- **cron = 每 5 分钟**（`*/5 * * * *`）。`server/src/worker/scheduler.ts`：顺序 `await runPlanTick → runStatTick → runWorkerTick(recording)`。
- **runPlanTick**：先 `runStudyPlanCarryTick`（carry，游标=昨天，幂等），再 gen（游标=今天；**今天已有 todolist 则跳过**）。
- **runStatTick**：游标=今天，事件驱动——**当天 daily 有新的学习记录 且 已有 todolist** 才执行（stat 由 ephemeral agent 勾 checkbox 完成项，随后代码数 `parent_done/parent_total` 写 child_kb `child_todo_stats`）。
- **客户端 gen/stat 已彻底移除（2026-09-02）**：`electron/lib/scheduler.ts` 两处 `cc.todo.enabled && !hasServerFeature("worker")` 块 + import 删除。服务端 worker 为唯一真源；`runTodoGen/runTodoStat`（todo-scheduler.ts）保留作工具函数但不再被调度。
- **能力探测**：客户端 `server-features.ts` 拉 `/api/v1/version` 的 `features`（含 `worker`）；`hasServerFeature("worker")` 控制 recording 本地调度开关。服务端 `routes/version.ts` 声明 `SERVER_FEATURES=["session_sync","worker","exam"]`。
- **游标**：`worker_state(childId, 'todo_gen'|'todo_stat').last_key=今天`；carry=`study_plan_carry=昨天`。幂等保证每天每孩子一次。

## 学习计划（ISSUE-033，2026-09-02 已实施 P0/P0b/P2/P3/P4）
- 主库 `study_plan_items`：date 定日 / daily 每日（+ origin carry 顺延）；**直接替换 rules_json.daily**；空天不学；未完成加到下一天累加；多计划同天合并。
- `routes/study-plans.ts`：CRUD + GET /study-plans/today 聚合（展平 items[{planId,text,topicKey,carry}]，按 text 去重）+ GET ?date=。
- `worker/study-plan-carry.ts`：每日顺延幂等 tick（游标=昨天；**v2 判定=昨天 child_todos 未勾 `[家长]` 行**——v1 依赖 child_todo_stats 在 stats 缺失时不顺延，9/2 实测漏延，已弃）。gen（tasks.ts runTodoGenServer）= **todolist↔计划每次同步**（2026-09-03 改：不再是生成一次锁死，家长中途改计划 ≤5 分钟反映到 todo；同文本勾选保留、孩子自定内容保留、无变化不写）。
- UI：家长中心侧边栏「🗓 学习计划」只读面板（Dashboard view="plan"）+ ChildDetailPage TABS "plan"；编辑走家长对话。
- ⚠️ 重复项修复：POST 幂等合并（同 child+date 单行 canonical）+ /today 去重 + 存量清理脚本 `server/scripts/fix-study-plan-dups.mjs`。显示截断修复：去掉 `lookaheadDays` 上限（展示全部未来排期）。

## 学习考核（EXAM，ISSUE-027）
- 存储全服务端；出卷+判分客户端内存 session；判分 prompt 服务端下发。v3 选课 LLM：固定考核只留每天/每周（每周 `weekly{weekday,time}`）；config 两段式（?schedule=选课无 rubric；&courses=带 rubric+scoring）。判分必带 rubric。家长端 ExamAdminPanel。

## SPLIT / 部署边界
- `learning-server`(8788) 只部署家庭局域网 **201(192.168.1.201)**，**不部署公网 ECS(47.96.154.226)**；ECS 只跑 `learning-cloud`。
- **服务端构建**：`node scripts/build.mjs`（esbuild→dist/server.cjs），勿用 `npm run build`(tsc 不产 server.cjs)。改 src 后确认 `dist/server.cjs` mtime 新。
- **⚠️ pkg 二进制已不可用**（agent SDK 动态 import 导致 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING）→ **201 直接 `node /opt/learning-server/server.cjs`**（201 Node v24.15.0）；service `ExecStart=/usr/bin/node /opt/learning-server/server.cjs`，`Environment=SERVER_DATA_DIR=/opt/learning-server/data`。
- **201 客户端升级**：先 `pkill -TERM -f '/opt/学习伙伴/xuexihub'` 再 `sudo dpkg -i learning-app_x.y.z_amd64.deb`；验证 `dpkg -l learning-app` 显示 `ii`。

## 发布流程
- **本地 Windows 无法产出 Linux/Mac 包**（缺 fpm/mksquashfs）→ 走 GitHub Actions CI（build-linux.yml/build-mac.yml，tag 触发），`gh run download <id> --repo shawn-feng/learning-app` 取产物。
- **GitHub Push Protection**：测试里别塞像云厂商密钥的串（曾因假值 `AKID...` 被拒）。
- 公网 feed=`https://www.aixuexihao.top/download/`：windows 走 `publish-update.py`；linux/mac 手动 oss2 传 OSS + `aliyun-run.py` 拉到 ECS `/opt/learning-cloud/download/`。
- **⚠️ 致命坑：`publish-update.py` 只传 OSS，不拷 ECS 本地！** 公网 feed 由 ECS nginx 从 `/opt/learning-cloud/download/` 提供，所以 **windows 的 exe/blockmap/latest.yml 也必须单独 `aliyun-run.py` curl 拷到 ECS**（如同 linux/mac 的 ecs_copy 脚本），否则 `/download/latest.yml` 显示旧版、windows 客户端走旧下载链。0.1.9 发布时一度漏拷 windows 文件 → feed 显示 0.1.8，已补 `ecs_copy_win` 修正。正确顺序：OSS 上传(windows 用 publish-update / linux-mac 用 oss2) ＋ **两类都再 aliyun-run 拷 ECS 本地**。
- electron-updater：`latest-linux.yml` path=AppImage，`latest-mac.yml` 每项带 arch（arm64 dmg 降级全量）。
- windows 安装包文件名含空格（`学习伙伴 Setup x.y.z.exe`），公网 URL 空格必须编码为 `%20` 才能正常拉取（否则 curl 返回 000）。

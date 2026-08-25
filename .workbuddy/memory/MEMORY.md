# 项目长期记忆（pi 学习伴侣）

## 架构约定
- **孩子 prompt = 身份(systemPromptOverride) + 行为规范(AGENTS)**。行为规范全在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts)，经 `buildAgentsMd` 生成代码默认 AGENTS；`buildChildPrompt` 只写身份、不写约束。
- **AGENTS 纯 SQLite(ISSUE-033)**：`data/agents.sqlite` 存用户版本(scope=child/ref=<id>；parent/ref=main)，`prompt_history` 可回退；无物理 AGENTS 文件。编辑入口=家长页 AgentPromptEditor(agents:get/save/history/restore)。`resolveChildAgents` 优先级：SQLite用户版本(整体替换)→buildAgentsMd。改 `LEARNING_NAV_INSTRUCTIONS` 后代码默认随源码生效，无需跑脚本。
- **家长提示词统一不分场景**：`buildParentPrompt` 一个版本；`getParentSession`/`getParentContentSession` 共用(后者仅独立单例+childId="parent-content")。工具集：read/write/edit/ls/get_date/parent_course_save/delete/parent_stats/log_activity/move_file/copy_file。落盘 `data/.pi/agent/sessions/{parent|parent-content}/` 独立子目录；autoNewSession 用 scheduler-config.json `parent.autoNewSession`。
- **recording=纯定时任务(ISSUE-024)**：非技能，`electron/lib/recording-prompt.ts` 为真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`——noContextFiles 是禁 AGENTS.md 唯一开关；工具只挂 kb_query/kb_insert/kb_update。

## 关键 SDK 坑（别再踩）
- 扩展挂 `DefaultResourceLoader({extensionFactories:[...]})`；`createAgentSession({extensions})` 是死参数不读。
- ⚠️ Windows 下 `DefaultResourceLoader` 必须显式传 `agentDir`(孩子=`childDir/.pi/agent`，家长=`dataDir/.pi/agent`)，否则 `undefined.startsWith` 崩。
- **customTools 的 name 必须同时出现在 `createAgentSession({tools})` 白名单**，否则被 isAllowedTool 过滤(agent 报"没有这个技能")。注：`ls`/`read`/`write`/`edit` 是 SDK 内置，只需列 tools、无需 customTools 条目。
- system prompt 是 LLM 前缀缓存公共前缀：时间注入只到「日期」不到「秒」，否则缓存失效。
- 会话 append-only：重置用 `newSession()`(归档)，勿用 `resetLeaf()`(堆叠分支)。
- Pi SDK jsonl 结构：`{"type":"message","message":{"role":user|assistant|toolResult,"content":[{type:text|thinking|toolCall}]}}`；提取文本只取 role∈{user,assistant} 且 content.type=text 的 part，按本地时区 `new Date(y,m,d).getTime()` 过滤当天。

## 构建与验证
- ⚠️ 沙箱内禁止 `git stash`(戳坏 .git/refs 致仓库损坏)；验证未提交改动用 `git diff`/`git show HEAD:<file>`。坏仓恢复：update-ref -d 坏引用→fetch→update-ref 复位+read-tree HEAD→删孤立 pack idx→fsck。
- 主进程/渲染改动后 `rm -rf out && npm run build`(electron-vite)；`rm -rf out` 可能被 safe-delete 拦，拦完已删直接再 build。
- `tsc --noEmit` 长期有 5 条环境相关全局告警(TS2318/TS2552，@types/node26 不兼容)，**会掩盖真实业务错误**——验证时先过滤这 5 条再看有无其它错误；改组件核对 Props 是否都解构(ISSUE-008 白屏即此漏过)。
- ⚠️ vitest(threads 池)用例残留 `setInterval` 致 worker 静默 exit 1；验证事件循环让出改 `vi.spyOn(global,"setImmediate")`+finally mockRestore。

## React 状态坑
- ⚠️ 绝不依赖 `setState(updater)` 闭包给外部变量赋值再同步读取(updater 异步)；派生行为一律用 `useEffect` 监听(ISSUE-014)。

## 前后端分离 / pi-web
- 决策：保留 Electron 一体应用，另起独立 `pi-web/`(Web前端+Node后端，端口8787)做替代，不动现有 pi。
- 硬约束：Pi SDK/edge-tts/ffmpeg/tencentcloud-asr 均 Node-only，AI+语音留服务端，浏览器走 HTTP/SSE。
- 引擎拆分目标 `engine-server/`(平移 electron/lib/*)，IPC→HTTP/SSE；数据归属服务端磁盘唯一真源、childId 路由隔离。

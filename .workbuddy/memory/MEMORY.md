# 项目长期记忆（pi 学习伴侣）

## 架构约定
- **孩子 prompt = 身份(systemPromptOverride) + 行为规范(AGENTS)**。行为规范全在 `LEARNING_NAV_INSTRUCTIONS`(pi-session.ts)，经 `buildAgentsMd` 生成代码默认 AGENTS；`buildChildPrompt` 只写身份、不写约束。
- **AGENTS 纯 SQLite(ISSUE-033)**：`data/agents.sqlite` 存用户版本(scope=child/ref=<id>；parent/ref=main)，`prompt_history` 可回退；无物理 AGENTS 文件。编辑入口=家长页 AgentPromptEditor(agents:get/save/history/restore)。`resolveChildAgents` 优先级：SQLite用户版本(整体替换)→buildAgentsMd。改 `LEARNING_NAV_INSTRUCTIONS` 后代码默认随源码生效，无需跑脚本。
- **家长提示词统一不分场景**：`buildParentPrompt` 一个版本；`getParentSession`/`getParentContentSession` 共用(后者仅独立单例+childId="parent-content")。工具集：read/write/edit/ls/get_date/parent_course_save/delete/parent_stats/log_activity/move_file/copy_file。落盘 `data/.pi/agent/sessions/{parent|parent-content}/` 独立子目录；autoNewSession 用 scheduler-config.json `parent.autoNewSession`。
- **recording=纯定时任务(ISSUE-024)**：非技能，`electron/lib/recording-prompt.ts` 为真源；`createEphemeralSession` 用 `DefaultResourceLoader({noContextFiles:true,noSkills:true})`——noContextFiles 是禁 AGENTS.md 唯一开关；工具只挂 kb_query/kb_insert/kb_update。
- **⚠️ html 资料渲染：用 `srcDoc` + 相对引用改写为 `asset://` 绝对地址（绝不能用 `<iframe src="file://">`）**。`TopicDetail.StudentMaterial` 渲染课程 html 文件：主进程 `readParentMaterial` 读取 html 后，用 `rewriteHtmlAssetRefs` 把内部 `href/src` 上的相对引用(`../xxx.css`、`../images/*`、同目录 `teach-data.js` 等)改写为 `asset://local/parent/<pid>/<topic>/<rel>` 绝对地址；前端继续用 `<iframe srcDoc={content}>` 渲染。原因与坑：
  - 若用纯 `srcDoc` 不改写：文档 base 是 `about:blank`，相对资源全部失效→CSS/图片不加载（视频因绝对 `media://` 不受影响）。
  - 若改用 `<iframe src="file://...">`：dev(渲染进程 http 源)下 Chromium 禁止加载本地资源、且 sandbox 与 file:// 组合常被整页拒绝→**所有主题资料空白**（2026-08-26 实测踩坑，已回退）。
  - `asset://` 协议(`electron/lib/media-protocol.ts` 的 `registerCustomSchemes/registerAssetProtocol`)与 `media://` 同特权(standard+secure)，可从任意源(dev http / prod file)访问，无混合内容告警；`resolveAssetTarget` 限 `data/parents/<pid>/materials/<topic>/` 且白名单扩展名，防目录穿越。
  - ⚠️ **standard scheme 的 URL 解析坑**：`asset://local/parent/...` 里 `local` 是 **host**，`new URL().pathname` 是 `/parent/...`（无 local）——`resolveAssetTarget`/`resolveMediaTarget` 必须检查 `segs[0]==='parent'`（`parentId=segs[1]`），检查 `segs[0]==='local'` 永远不成立、全部 403（2026-08-26 二轮修复）。另 `registerSchemesAsPrivileged` 只能调一次，多 scheme 合并进一次调用，分开调会互相覆盖。
  - 仅限音视频的 `media://` 仍按原逻辑(`ALLOWED_EXT`)，`asset://` 覆盖 css/js/图片/字体等(`ASSET_ALLOWED_EXT`)。
  - **meta-refresh 跳转占位页**：部分课程的 index.html 是 `<meta http-equiv="refresh" content="0; url=../learn/xxx.html">` 占位页（英语 01-11/45-50），srcDoc 下相对跳转会导航到不存在地址→空白。`readParentMaterial` 用 `followHtmlRedirect`（限 materials/ 内、最多 8 跳、防环）先跟随跳转拿到最终 html 再改写资源引用；无跳转则原样。识别技巧：html 仅数百字节且含 `http-equiv=refresh` 即为占位页。

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
- ⚠️⚠️ **vitest 4.1.x Windows 盘符大小写 bug(#10692)**：cwd 为小写盘符(`c:\...`)时，所有测试文件在第一个 describe() 抛 `Cannot read properties of undefined (reading 'config')`、0 test——vitest CLI 经小写路径加载而 Vite 规范化 id 为大写，Node 模块注册表出现双份 runtime，runner 未注入。**跑 vitest 前先 `cd "C:/Users/79734/Documents/pi"`(大写盘符)**；Git Bash 会保留小写盘符触发，PowerShell 自动大写不触发。症状易被误判为环境损坏(清 .vite/换 pool/换 node 均无效)。

## React 状态坑
- ⚠️ 绝不依赖 `setState(updater)` 闭包给外部变量赋值再同步读取(updater 异步)；派生行为一律用 `useEffect` 监听(ISSUE-014)。

## 前后端分离 / pi-web
- 决策：保留 Electron 一体应用，另起独立 `pi-web/`(Web前端+Node后端，端口8787)做替代，不动现有 pi。
- 硬约束：Pi SDK/edge-tts/ffmpeg/tencentcloud-asr 均 Node-only，AI+语音留服务端，浏览器走 HTTP/SSE。
- 引擎拆分目标 `engine-server/`(平移 electron/lib/*)，IPC→HTTP/SSE；数据归属服务端磁盘唯一真源、childId 路由隔离。

## 客户端 + 服务端拆分（SPLIT，2026-08-27 需求已收敛，需求文档 `SPLIT-REQUIREMENTS.md`）
- **核心目标=多设备共享数据**；双独立安装包（客户端包/服务端包，版本各自升级，需版本兼容约定）；服务端无 UI 常驻、可云上 ECS 或家庭局域网、本机可自用（同机装两包）。
- **必须在线（写操作）**：数据库读写每次联网；**已缓存资料断网可离线浏览**（读不联网）。本地无业务数据库，仅缓存目录。
- **会话 jsonl 留客户端本地、不上服务端**（换设备即新会话）；学习记录永远在服务端（家长端可见性唯一通道，预留"定时推送会话"扩展）。
- 认证复用 benefit-auth（客户端→服务端→auth.aixuexihao.top）；孩子由家长创建、跟随授权、不单独认证；materials 版本=最新时间戳比对（无版本切换）；大文件存服务端磁盘；不做存量迁移。
- **独立于 cloud-service/www 与 pi-web，三条线互不隶属**——pi-web 方向不受本次影响，本拆分不走 pi-web 路线。

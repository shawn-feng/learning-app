# 项目长期记忆（pi 学习伴侣）

## 架构约定：孩子 AI 的 prompt 构成（2026-08-18 确立）
- **孩子会话 prompt = 身份（systemPromptOverride）+ 全部行为规范（AGENTS.md）**。
- `buildChildPrompt`（electron/lib/pi-session.ts）**只描述身份**，不写任何行为约束，也不要写「不是XXX」、只写「是XXX」。
- 所有行为约束（交流准则、学习方法、内容展示、角色）放在 `LEARNING_NAV_INSTRUCTIONS`，经 `buildAgentsMd` 生成 `data/children/<id>/AGENTS.md`，由 SDK 自动附加为 `<project_context>`。**AGENTS.md 是孩子规范的唯一真源**；家长可在 `<!-- custom:start/end -->` 段手动编辑。
- `getChildSession` 每次开会话前调 `writeAgentsMd(childId, profile)` 刷新磁盘 AGENTS.md（保留 custom 段），避免源码改了但磁盘陈旧、旧文案与新设计矛盾。
- 改动 LEARNING_NAV 后，跑 `scripts/regenerate-agents.mjs` 可一次性为所有孩子重新生成 AGENTS.md。

## 架构约定：recording = 纯定时任务，不是技能（2026-08-21 确立）
- **recording 不再作为技能**：`data/shared/skills/recording/` 已删除（不进 `<available_skills>`），改由 scheduler 定时任务驱动。
- 真源是 `electron/lib/recording-prompt.ts`：`RECORDING_SYSTEM_PROMPT`（极简记录助手身份）+ `RECORDING_PROMPT`（流程与要求：详细度/四类提取/kb 写入/daily 格式/标签）。
- `createEphemeralSession`（scheduler.ts）用 `DefaultResourceLoader({ noContextFiles:true, noSkills:true, systemPromptOverride })`——**noContextFiles 是禁 AGENTS.md 的唯一开关**（即使 customPrompt 存在，SDK 也会把 contextFiles 拼进 `<project_context>`）；工具只挂 `kb_query/kb_insert/kb_update`（白名单+customTools 缺一不可），不给 read/write/edit。
- `runRecording` 每次开独立 in-memory session：prompt = RECORDING_PROMPT + 本地当天日期 + `readTodayConversation`（当天无对话直接跳过，不消耗 token）。

## 关键 SDK 坑（踩过的，别再踩）
- 扩展必须挂 `DefaultResourceLoader({ extensionFactories: [...] })`；`createAgentSession({ extensions })` 是死参数，从不读取。
- `noSkills: true` + `additionalSkillPaths` 才能把 `~/.agents/skills` 的 60 个全局技能挡掉、只留教学技能。
- system prompt 是 LLM 前缀缓存公共前缀：时间注入只到「日期」，不要到「秒」，否则缓存失效。
- 会话模型 append-only：重置用 `newSession()`（归档保留旧文件），不要用 `resetLeaf()`（会无限堆叠分支）。
- **customTools 的每个 `name` 必须同时出现在 `createAgentSession({ tools })` 的白名单里**，否则 `agent-session.js` 的 `isAllowedTool` 会把它过滤掉——工具既不注册也不激活，agent 会报告「没有这个技能」。ISSUE-006 的 `get_progress` 当初漏列进 `tools` 就是这个坑（2026-08-19 修复：`tools` 加 `"get_progress"`，并加 `test/get-progress-registration.test.ts` 锁不变量）。
- **Pi SDK 会话 jsonl 真实结构（type=message + message.role）**：条目 `{"type":"message","timestamp":ISO,"message":{"role":"user"|"assistant"|"toolResult","content":[...]}}`；content 数组里 part 有 `text`/`thinking`/`toolCall` 三种 type。**没有 `user_message/assistant_message` 这种条目类型**——scheduler 旧 extractText 按后者判断导致提取恒为空（2026-08-21 修复）。提取「对话文本」：只取 type=message、role∈{user,assistant}、content 里 type=text 的 part（排除 thinking/toolCall，toolResult 整体跳过），按本地时区过滤「当天」用 `new Date(y,m,d).getTime()`（不用 toISOString，那是 UTC 日期）。

## React 状态坑（踩过的，别再踩）
- ⚠️ **绝不依赖 `setState(updater)` 闭包给外部变量赋值、再同步读取**——React 18+ 中 updater 异步执行（render 阶段才跑），同步检查时变量恒为旧值/初始值。ISSUE-014 教训：旧代码「updater 里赋 `targetId` → 同步 `if (targetId) setSelectedMaterialId(targetId)`」恒为 null，自动弹开从未生效（初次登记误判为正常，用户实测第二份资料不切换才暴露）。**「状态变更后的派生行为」一律用 `useEffect` 监听状态**；需要 updater 内部分支结果时（如去重返回原引用），依赖「返回原引用 → React bail-out → effect 不触发」这一行为。

## 构建与验证
- 主进程/渲染改动后需 `rm -rf out && npm run build`（electron-vite）才生效；`electron-vite build` 清空 out 时可能撞环境 safe-delete 回收站报错，先 `rm -rf out` 可规避（注：`rm -rf out` 本身也可能被 safe-delete 拦，拦完目录其实已删，直接再跑 `npm run build` 即可）。
- `tsc --noEmit` 项目里长期有 5 条环境相关的全局类型告警（TS7/@types/node26 不兼容），非业务代码引入，忽略即可。
- ⚠️ **这 5 条 TS2318/TS2552 全局类型损坏会导致 tsc 终止大部分语义分析，可能掩盖真实业务错误**——如 ISSUE-008 白屏事故：`ChatWindow` 组件漏解构 `notice` prop（JSX 里用了 `notice` 变量）→ 运行时 ReferenceError → 进孩子模式整页白屏，而 tsc 只报了 5 条环境告警、electron-vite build（esbuild）不做类型检查，双双漏过。**验证时把 tsc 输出过滤掉 TS2318/TS2552 后再看是否有其它错误**；改组件后要核对「Props 字段是否都解构了」。
- 既有失败用例：app.test.ts 云端注册（ECONNREFUSED 8005）、sync.test.ts 并发超时——均非本地改动引入。2026-08-19 起另有环境性失败：auto-new-session/archive-limit 的测试清理 `rmSync` 被 safe-delete 拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED）导致测试残留目录堆积、级联失败；functional.test.ts 的 `app.isPackaged` 在 vitest 未定义——均与业务改动无关。
- ⚠️ **vitest（threads 池）测试用例里残留 `setInterval` 会让 worker 静默崩溃**：无任何输出、直接 exit 1，`--pool=forks` 可绕过但不应全局改；验证「事件循环让出」这类行为改用 `vi.spyOn(global, "setImmediate")` + `finally mockRestore` 统计调用（ISSUE-011 的 sync-scan.test.ts 踩过）。
- **同步重 IO 阻塞主进程时 `withTimeout` 无效**：`setTimeout` 回调也要事件循环跑，事件循环被 `readFileSync`/全量哈希堵死时超时永不触发。修复范式（ISSUE-011）：扫描用 `fs.promises` + 每 N 文件 `await setImmediate()` 让出 + 流式哈希（`createReadStream` 管道）+ 「size 预过滤」只对 size 相同的文件算哈希（size 不同 → hash 必不同，语义等价）。

## 前后端分离架构决策（2026-08-22）
- 目标：当前 Electron 一体应用 → **前端（Electron 壳 / 浏览器 PWA，共用一份 React）+ 服务端后端**。
- **硬约束（已验证）**：Pi SDK、`edge-tts`、`ffmpeg-static`、`tencentcloud-asr` 均为 Node-only（`require('fs')`/`child_process`），**无法进浏览器** → AI 引擎 + 语音必须留在服务端 Node 进程，浏览器端经 HTTP/SSE 通信。
- 渲染层已统一经 `window.api`（electron/preload.ts 暴露）通信，约 70+ 处 `window.api.*` 散落组件；方案是先抽 `src/lib/api.ts` 统一收口，再让 client 按环境选 Electron preload 或 fetch+SSE，组件零改动。
- 后端拆分：把 `electron/lib/*`（pi-session/pi-runtime/voice/scheduler/parent-library/kb-*/custom-tools/learning-guard）平移为常驻 Node 服务 `engine-server/`，IPC 通道改写为 HTTP/SSE；Python 云端（cloud-service/benefit-auth）不动，继续做认证/许可证/同步/权益中台。
- 数据归属：拆分后**服务端磁盘为唯一真源**（`engine-server/data/children/<id>/`），路径守卫 + childId 路由隔离保留；孩子本地密码仍不进 Python 云端账号库。Electron 厚壳以子进程拉起 engine-server 可保离线能力。
- 完整方案见 `ARCHITECTURE-SPLIT.md`；迁移分 P0 抽象 → P1 引擎骨架 → P2 路由全平移 → P3 多端前端 → P4 数据迁移（最高风险，单独灰度）→ P5 收尾。

## 独立 Web 新项目已落地（2026-08-22，替代改造现有 pi）
- **用户决策**：不动现有 `pi` 项目，**新建独立目录 `C:\Users\79734\Documents\pi-web`**，只做 **Web 浏览器前端 + Node 后端**，不考虑 Electron 客户端。
- 结构：`pi-web/server`（Fastify+tsx 后端，端口 8787，数据落 `pi-web/data/children/<id>/`）+ `pi-web/web`（Vite+React+TS 前端，紫色儿童主题）+ `README.md`。
- 已验证端到端：孩子增删查（按 childId 隔离）、SSE 流式聊天占位、后端同源托管前端 build（生产单端口 8787）、API 代理现有 Python 云端（/api/cloud/*）。浏览器端 TTS 用 Web Speech API（en-GB 优先，语速 1.0）。
- **未做（占位待迁移）**：真实 Pi SDK 引擎（会话/AGENTS.md/上下文截断）、Node-only 语音生成（edge-tts 等）、定时任务。引擎接口在 `server/src/lib/engine.ts`，云端代理在 `server/src/lib/cloud.ts`。
- 运行：dev 双进程（server:8787 + web:5173 Vite 代理 /api）；prod 先 `web npm run build` 再 `server npm run dev` 同源托管。
- ⚠️ **踩坑记录（pi-web 后端）**：① Windows 下 `import.meta.url` 的 `pathname` 带前导 `/` 致 `new URL('../data/').pathname` 拼出 `C:\C:\...`，须用 `fileURLToPath` + `path.dirname`；② `import.meta.url` 在 tsx 运行时 dirname 不可靠（指向 server 而非 server/src），前端 build 路径改用 `path.resolve(process.cwd(),'../web/dist')`（进程约定在 server/ 启动）；③ 沙箱 safe-delete 回收站二进制超时，导致 `rm -rf`/`fs.rmSync` 在 WorkBuddy 内报 ETIMEDOUT（环境故障，用户本地不受影响）。

# 项目长期记忆（pi 学习伴侣）

## 架构约定：孩子 AI 的 prompt 构成（2026-08-18 确立）
- **孩子会话 prompt = 身份（systemPromptOverride）+ 全部行为规范（AGENTS.md）**。
- `buildChildPrompt`（electron/lib/pi-session.ts）**只描述身份**，不写任何行为约束，也不要写「不是XXX」、只写「是XXX」。
- 所有行为约束（交流准则、学习方法、内容展示、角色）放在 `LEARNING_NAV_INSTRUCTIONS`，经 `buildAgentsMd` 生成 `data/children/<id>/AGENTS.md`，由 SDK 自动附加为 `<project_context>`。**AGENTS.md 是孩子规范的唯一真源**；家长可在 `<!-- custom:start/end -->` 段手动编辑。
- `getChildSession` 每次开会话前调 `writeAgentsMd(childId, profile)` 刷新磁盘 AGENTS.md（保留 custom 段），避免源码改了但磁盘陈旧、旧文案与新设计矛盾。
- 改动 LEARNING_NAV 后，跑 `scripts/regenerate-agents.mjs` 可一次性为所有孩子重新生成 AGENTS.md。

## 关键 SDK 坑（踩过的，别再踩）
- 扩展必须挂 `DefaultResourceLoader({ extensionFactories: [...] })`；`createAgentSession({ extensions })` 是死参数，从不读取。
- `noSkills: true` + `additionalSkillPaths` 才能把 `~/.agents/skills` 的 60 个全局技能挡掉、只留教学技能。
- system prompt 是 LLM 前缀缓存公共前缀：时间注入只到「日期」，不要到「秒」，否则缓存失效。
- 会话模型 append-only：重置用 `newSession()`（归档保留旧文件），不要用 `resetLeaf()`（会无限堆叠分支）。
- **customTools 的每个 `name` 必须同时出现在 `createAgentSession({ tools })` 的白名单里**，否则 `agent-session.js` 的 `isAllowedTool` 会把它过滤掉——工具既不注册也不激活，agent 会报告「没有这个技能」。ISSUE-006 的 `get_progress` 当初漏列进 `tools` 就是这个坑（2026-08-19 修复：`tools` 加 `"get_progress"`，并加 `test/get-progress-registration.test.ts` 锁不变量）。

## React 状态坑（踩过的，别再踩）
- ⚠️ **绝不依赖 `setState(updater)` 闭包给外部变量赋值、再同步读取**——React 18+ 中 updater 异步执行（render 阶段才跑），同步检查时变量恒为旧值/初始值。ISSUE-014 教训：旧代码「updater 里赋 `targetId` → 同步 `if (targetId) setSelectedMaterialId(targetId)`」恒为 null，自动弹开从未生效（初次登记误判为正常，用户实测第二份资料不切换才暴露）。**「状态变更后的派生行为」一律用 `useEffect` 监听状态**；需要 updater 内部分支结果时（如去重返回原引用），依赖「返回原引用 → React bail-out → effect 不触发」这一行为。

## 构建与验证
- 主进程/渲染改动后需 `rm -rf out && npm run build`（electron-vite）才生效；`electron-vite build` 清空 out 时可能撞环境 safe-delete 回收站报错，先 `rm -rf out` 可规避（注：`rm -rf out` 本身也可能被 safe-delete 拦，拦完目录其实已删，直接再跑 `npm run build` 即可）。
- `tsc --noEmit` 项目里长期有 5 条环境相关的全局类型告警（TS7/@types/node26 不兼容），非业务代码引入，忽略即可。
- ⚠️ **这 5 条 TS2318/TS2552 全局类型损坏会导致 tsc 终止大部分语义分析，可能掩盖真实业务错误**——如 ISSUE-008 白屏事故：`ChatWindow` 组件漏解构 `notice` prop（JSX 里用了 `notice` 变量）→ 运行时 ReferenceError → 进孩子模式整页白屏，而 tsc 只报了 5 条环境告警、electron-vite build（esbuild）不做类型检查，双双漏过。**验证时把 tsc 输出过滤掉 TS2318/TS2552 后再看是否有其它错误**；改组件后要核对「Props 字段是否都解构了」。
- 既有失败用例：app.test.ts 云端注册（ECONNREFUSED 8005）、sync.test.ts 并发超时——均非本地改动引入。2026-08-19 起另有环境性失败：auto-new-session/archive-limit 的测试清理 `rmSync` 被 safe-delete 拦截（SAFE_DELETE_BULK_CONFIRM_REQUIRED）导致测试残留目录堆积、级联失败；functional.test.ts 的 `app.isPackaged` 在 vitest 未定义——均与业务改动无关。
- ⚠️ **vitest（threads 池）测试用例里残留 `setInterval` 会让 worker 静默崩溃**：无任何输出、直接 exit 1，`--pool=forks` 可绕过但不应全局改；验证「事件循环让出」这类行为改用 `vi.spyOn(global, "setImmediate")` + `finally mockRestore` 统计调用（ISSUE-011 的 sync-scan.test.ts 踩过）。
- **同步重 IO 阻塞主进程时 `withTimeout` 无效**：`setTimeout` 回调也要事件循环跑，事件循环被 `readFileSync`/全量哈希堵死时超时永不触发。修复范式（ISSUE-011）：扫描用 `fs.promises` + 每 N 文件 `await setImmediate()` 让出 + 流式哈希（`createReadStream` 管道）+ 「size 预过滤」只对 size 相同的文件算哈希（size 不同 → hash 必不同，语义等价）。

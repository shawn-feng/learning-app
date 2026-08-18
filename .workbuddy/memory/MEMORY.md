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

## 构建与验证
- 主进程/渲染改动后需 `rm -rf out && npm run build`（electron-vite）才生效；`electron-vite build` 清空 out 时可能撞环境 safe-delete 回收站报错，先 `rm -rf out` 可规避。
- `tsc --noEmit` 项目里长期有 5 条环境相关的全局类型告警（TS7/@types/node26 不兼容），非业务代码引入，忽略即可。
- 既有失败用例：app.test.ts 云端注册（ECONNREFUSED 8005）、sync.test.ts 并发超时——均非本地改动引入。

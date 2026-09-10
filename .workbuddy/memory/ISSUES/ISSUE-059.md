## [ISSUE-059] 课程时间表优化：按「模板 + 星期」分配（上学日 / 周末分别设置，周末可不固定）
- **类型**：需求 / 功能增强（在 ISSUE-019 课程时间段基础上增加「按星期套用不同时间表」能力）
- **场景（用户原话）**：周一到周五正常上学的课程时间，和周六日不一样；周六日往往不固定，需要单独设置。希望有类似模板的功能——先定义好几个时间表模板，再指定「哪些天用哪个模板」。
- **当前实现（已读代码，确认无星期维度）**：
  - 数据结构：`SchedulerChildConfig.classTimes: { start: string; end: string; label?: string }[]`（src/components/SchedulerSettings.tsx:10），**每个孩子一份扁平数组，不区分星期**。electron 侧 `ClassTime`/`DEFAULT_CHILD_CONFIG.classTimes: []`（electron/lib/scheduler.ts:47/118）同源。
  - 消费点（提醒触发）：`electron/lib/scheduler.ts:507-524` 每分钟轮询，对 `cc.classTimes` 每个段比较 `nowMin === ct.start/ct.end` 即广播 `broadcastClassReminder`（孩子端顶部 1/3 横幅 + 铃声/语音）。**触发只看「时刻」不看「星期」**——所以当前所有天用的是同一份表，无法满足「周末另设」。
  - 配置落盘 + 同步：`schedulerConfigSet` → `scheduler_config.children[childId].classTimes`；`config-sync.ts:106-145` 已对 `classTimes` 做按 childId 深合并 + 「服务端空/缺时保留本地」防丢失（ISSUE-053 加固）。新增模板字段需同等保护，否则换设备/同步会丢表。
  - 只读展示：`electron/lib/app-config.ts:179-186` `scheduler.classTimes` 把每个孩子的 times 拼成 `08:00-09:30(语文), ...` 文本，新增模板后此处需改为「按星期展示模板归属」。
- **需求拆解**：
  1. 支持定义多个「时间表模板」（每个模板 = 一组 `{start,end,label}` 段，可命名如「上学日」「周末」「假期」）。
  2. 支持把每个星期（周一~周日）映射到某个模板（默认建议：周一~周五→「上学日」，周六~周日→「周末」）。
  3. 运行时按「今天星期几」选模板 → 取该模板的段做提醒（替代当前无差别全量）。
  4. 周末「不固定」：模板可留空（该天不提醒），或随时改模板内容立即生效，不必改星期映射。
- **设计建议（推荐方案 A，已在思考中权衡）**：
  - **数据模型**：把扁平 `classTimes` 升级为
    ```
    classTemplates: { id: string; name: string; times: ClassTime[] }[]   // 模板库
    classWeek: { [day: number]: string | null }   // day 0=周日..6=周六，值为 templateId；null=当天不提醒
    ```
    默认种子：`classTemplates=[{上学日,times:[]},{周末,times:[]}]`，`classWeek={1..5:上学日id, 0:周末id, 6:周末id}`。
  - **向后兼容**：旧 `classTimes` 非空的孩子，迁移为「一个『自定义』模板 + classWeek 全 7 天指向它」，行为不变（避免升级即丢表）。
  - **运行时解析**：新增 `getEffectiveClassTimes(childConfig, now)`：按 `now.getDay()` 查 `classWeek` → 取对应 `classTemplates` 的 `times`，返回给 scheduler.ts:507 处原逻辑（改动仅 1 处消费点，其余复用）。
  - **UI（SchedulerSettings.tsx:391-514 重构）**：① 模板管理区（增/删/改名 + 每个模板内独立的多段 time 编辑，复用现有时间段行组件）；② 7 行「星期 → 模板下拉」映射表（含「不提醒」选项）。两区用一个「课程时间表（模板）」折叠块包裹。
  - **为什么不用「仅上学日/周末两个固定预设」**：用户明确说「类似模板的功能，哪些天用什么模板」→ 通用模板更贴合，且能扩展「假期」「考试周」等；固定双预设是方案 B（更简单但扩展性差），可作 MVP。
- **修改入口 / 方向**：
  - `src/components/SchedulerSettings.tsx:10,39-48,391-514`：接口加 `classTemplates/classWeek` + 默认；UI 重构为模板管理 + 星期映射。
  - `electron/lib/scheduler.ts:47,118,217-229,261-273,507-524`：类型扩展；新增 `getEffectiveClassTimes`；:507 改为先解析今日模板再遍历。
  - `electron/lib/config-sync.ts:120-145`：把 `CLASS_FIELD` 保护从单一 `classTimes` 扩展到 `classTemplates`/`classWeek`（含旧表迁移兼容，防 ISSUE-053 式丢失）。
  - `electron/lib/app-config.ts:179-186`：只读展示改为「周一~周五：上学日(…) / 周六~周日：周末(…)」式按星期呈现。
  - 服务端若也有 classTimes 引用（task-runs 注释提到「客户端据此合并 classTimes 推回」），一并同步字段。
- **处理状态（2026-09-07 已实现）**：按推荐方案 A 落地。
  - `electron/lib/scheduler.ts`：`SchedulerChildConfig` 增 `classTemplates`/`classWeek`；新增 `normalizeClassSchedule`（旧扁平 classTimes 迁移为「自定义」模板 + 全 7 天指向它，行为不变）与 `getEffectiveClassTimes(cfg, now)`；`get/setChildSchedulerConfig` 走归一；:507 提醒循环改为先按今天星期解析生效模板再遍历（仅 1 处消费点）。
  - `src/components/SchedulerSettings.tsx`：折叠块「课程时间表（模板）」= ① 模板管理区（增/删/改名 + 每模板独立多段时间段编辑，复用行组件）+ ② 7 行「星期→模板下拉」（含「不提醒」）；`classAlertMode` 任一模板有段时显示；加载时旧 classTimes 就地迁移。
  - `electron/lib/config-sync.ts`：`CLASS_FIELDS` 保护从单一 `classTimes` 扩展到 `classTemplates`/`classWeek`，防 ISSUE-053 式丢表。
  - `electron/lib/app-config.ts`：`scheduler.classTimes` 只读展示改为按星期逐日呈现（周一~周日：模板名(时间段) / 不提醒）。
  - `src/pages/Learn.tsx`：今日课程按今天星期取生效模板时间段。
  - `server/src/worker/tasks.ts`：`WorkerSchedulerChildConfig` 增可选 `classTemplates`/`classWeek`（结构对齐，服务端不参与调度）。
  - 测试：`test/archive-limit.test.ts` 两个旧 classTimes 用例改为模板模型用例（迁移 + getEffectiveClassTimes 验证），7/7 通过；`tsc --noEmit` 与 esbuild 转译均通过。
- **优先级**：中（不影响现有提醒，属增强；但周末场景当前完全无法满足，家长痛点明确）
- **记录时间**：2026-09-07

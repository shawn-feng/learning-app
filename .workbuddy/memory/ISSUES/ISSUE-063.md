## [ISSUE-063] 审计所有工具的报错信息：是否详细、准确、能指导 agent 下一步（含「查课程找不到→建议先列全部课程名核对」）
- **类型**：审计 + 规范（检查所有 customTools / 内部调用的报错是否「说清 what + 给原因 why + 给下一步 next」，帮助 agent 自纠）
- **需求（用户 9/8 原话）**：检查所有工具的报错信息是否详细、是否准确。好的报错信息能够帮助 agent 知道下一步做什么。例如查询课程资料时，如果找不到课程，是不是能报错「找不到记录，可能是课程名错误，建议先列出所有课程名，确认课程名是否正确」。
- **现状审计（已读 `electron/lib/custom-tools.ts` / `pi-session.ts` / `parent-library.ts` / `child-auth.ts` / `ipc-handlers.ts` / 各 voice provider）**：

  ### A. 已做得好（可作为范本，保留）
  - `parent_content`（custom-tools.ts:1079）：课程找不到时 →「家长库中未找到课程「X」。请先用 kb_query（query=progress + topic + listOnly）列出该主题的准确课程标题，再用完整标题查询」——**正是用户要的范式（what+next+列候选）**。
  - `parent_library_courses`（:2330）：主题找不到 → 附「现有主题：A/B/C」。
  - `exam_schedule_create`（:986）/ `course_status`（:2381）：孩子找不到 → 附「现有孩子：…」。
  - `study_plan` 定位（:1925）：id 找不到 → 建议 `study_plan_list` 并给最近行作锚点。
  - `kb_update course`（:609）：课程不存在 → 带 topic+item。
  - voice 类（qwen.ts:133/149、audio.ts:66）：识别失败带「请靠近麦克风再说一次」等下一步。
  - `parent_upload_material`（:778-800）：路径/格式/目录校验清晰，提示「先 write 再上传」。

  ### B. 问题点（需改进）
  1. **【核心反例，对应用户例子】孩子会话查课程教法「静默降级」，agent 完全不知课程找不到**：`createChildSession`（pi-session.ts:581）`fetchCourseLessonRemote(...).catch(() => null)` 吞掉错误；:584-585 当 `courseLesson` 为 null 仅 `console.warn("[pi-session] course lesson not found …（降级为无教法注入）")`，**agent 收不到任何信号**，直接「无教法」开讲。应改为：进入课程会话前若 courseLesson 缺失，向 agent 明确报告「课程《X》未取到教法（可能课程名不准确，或服务端暂不可达），可用 kb_query progress + topic 列出全部课程标题核对后用完整标题重试」，并区分「真无此课」vs「拉取失败（网络）」。
  2. **离线/服务端不可达统一静默吞**（与 B1 同源）：`fetchAgentPromptRemote`/`fetchTodayPlanRemote`/`fetchCourseLessonRemote` 失败均 `.catch(() => null)` 降级，agent 不知道「当前是离线降级、内容可能非最新」。须区分「数据确实不存在」vs「拉取失败」——后者应提示内容可能陈旧，而非当作「无此法」。注：`parent-library.ts:770` 已立「本地无文件且拉取失败时返回 error（网络/服务端问题显式暴露，**禁止静默降级**）」政策，应推广到孩子会话教法拉取。
  3. **`parent_read_image`（:932）三元恒等**：`/未找到可用的 ffmpeg|网络|API key|凭证|401|403/.test(msg) ? A : A` 两分支文本完全相同，条件无意义，应区分「ffmpeg 缺失」vs「网络/凭证错误」给出不同下一步。
  4. **泛化报错缺下一步**：`schedule_task create`（:1809）「创建提醒失败」无原因无下一步；`parent_upload_material`（:802）「上传未返回服务端路径，请重试」缺上下文；`programming-agent.ts:233`「未能成功写入（文件不存在或为空），请重试」可附「检查 requirement/输出路径」。
  5. **报错语言不一致**：部分中文（好），部分英文——`child-auth.ts:276/303`「Child not found」、`ipc-handlers.ts:1603`「No active session」、`:1606`「Model not found」、`exam.ts` 等。中文 agent 环境，英文报错增加理解成本，应统一中文（专有名词/命令名保留英文）。
  6. **缺「可恢复性」分类**：未区分「参数错（改了再调）/ 数据不存在（先列出再确认）/ 环境错（重试或查网络）/ 配置缺（去设置开启）」。好报错应带该分类，让 agent 知道动作类型。
  - 附：`parent-library.ts:680` 注释记录过「HTTP 200+0 字节偶发会把正确路径整条判成 not found，agent 只能瞎猜」——说明模糊/误报报错已实际造成 agent 瞎猜，正是本 issue 要根治的。

- **建议的「好报错」规范（可落地 checklist，写入新增 `docs/TOOL-ERROR-CONVENTIONS.md` 或 ARCHITECTURE.md「工具报错规范」段）**：每条工具报错应满足——
  1. **what**：明确对象 + 失败点（如「家长库中未找到课程《X》」）。
  2. **why**：区分 参数错 / 数据不存在 / 网络·服务端 / 配置缺失。
  3. **next**：给下一步动作——可自愈的给命令（「先用 kb_query progress + topic 列出全部课程标题，核对后用完整标题重试」）；环境类「检查网络后重试」；配置类「去设置页开启 X」。
  4. **候选**：找不到 X 时附「现有 X：A/B/C」让 agent 直接选，避免再猜（范本见 A 段）。
  5. **语言**：面向中文 agent，报错中文为主（命令名/专有名词保留英文）。
  6. **不静默降级**：真无 vs 拉取失败必须区分；降级须显式告知 agent（沿用 parent-library:770 政策）。
  7. **（可选）错误类型枚举**：`ParamError | DataError | NetworkError | ConfigError`，便于 agent 与日志区分、也方便测试断言。
- **修改入口 / 方向**：
  - `electron/lib/pi-session.ts:581,584-585` `createChildSession`：**核心**。courseLesson 缺失区分网络失败 vs 真无课，向 agent 报告并建议 kb_query 列课程核对。
  - `electron/lib/custom-tools.ts`：①:932 parent_read_image 三元恒等修复（区分 ffmpeg/网络）；②:1809 schedule_task 补原因；③:802 upload 补上下文；④ programming-agent.ts:233 写失败补建议。
  - `electron/lib/child-auth.ts:276/303`、`ipc-handlers.ts:1603/1606`、`exam.ts` 等英文报错统一中文化。
  - 新增规范文档 `docs/TOOL-ERROR-CONVENTIONS.md`（或并入 ARCHITECTURE.md）；加一个轻量复核：扫描 custom-tools.ts 所有 `throw new Error` 人工核对是否含 next 动作，新工具按 checklist 写。
- **优先级**：中（直接影响 agent 自纠能力、减少「瞎猜/重复调用/多耗轮次」；与 ISSUE-054/062 的 token 利用也相关——报错不清会多耗轮次）
- **阶段进度（2026-09-08）**：✅ **第一阶段审计交付完成**（`AUDIT-tools-error-messages-2026-09-08.md`，3 组 39 项工具逐条评分 + P0/P1/P2 分级）。✅ **第二阶段修复实施完成**（见下「修复明细」）。✅ **验证通过**：electron-vite build 通过；vitest 全量 **340/340 通过**（此前全量偶现 3 个 parent-stats activity-log 失败，单独跑与复跑均通过，确认是既有 flaky 测试间共享状态污染，与本次改动无关）。**部署 201/公网未做**。
- **修复明细（2026-09-08 实施）**：
  - **P0 不静默降级**：`learning-summary.ts` 三个 fetch* 返回状态（`ok|network`，课程另有 `not-found`）并写缓存 meta（lastFetchOk/lastFetchAt/cachedAt）；新增 `getProgressSyncMeta`/`isCourseLessonCacheStale`/`getTodayPlan{date 校验,fresh}`/`getTodayPlanText`；`agent-prompts.ts fetchAgentPromptRemote` 返回 `{content,status:ok|network}`；`pi-session.ts` createChildSession/createSceneSession 教法缺失/旧缓存/计划拉取失败 → dataNotice 注入 buildChildPrompt/buildScenePrompt（区分 not-found vs network，附 kb_query 列课程核对 next）。
  - **P1**：kb_update 找不到课附 kb_query 列课程命令；display_content 拉取失败区分网络 vs 路径；parent_read_image 恒等三元拆 ffmpeg/凭证/网络/其它四类；schedule_task create 失败补原因+list 自检 next；programming-agent 写空补三原因+next。
  - **P2**：parent_course_delete 未删成改抛错+候选；page_action/page_inspect/scene_command 失败附「先 display_content」next；kb_query progress 空结果区分未分配/主题名不准；parent_upload_material 空路径补 why；child-auth/pi-session/ipc-handlers 英文报错中文化。
  - **规范**：新增 `docs/TOOL-ERROR-CONVENTIONS.md`（7 条 checklist + 三段式模板 + 不静默降级政策 + 范本索引 + 已改位置清单）。
  - **测试**：`parent-library.test.ts` 一条过时断言（htmlPath「未上传=not found」）随 9/8 政策更新为「登记即返回」。
- **记录时间**：2026-09-08

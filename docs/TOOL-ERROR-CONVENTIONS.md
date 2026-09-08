# 工具报错规范（TOOL-ERROR-CONVENTIONS）

> **来源**：ISSUE-063（2026-09-08 审计，完整审计表见仓库根 `AUDIT-tools-error-messages-2026-09-08.md`）。
> **适用范围**：所有 agent 可见报错——孩子/家长会话自定义工具（custom-tools）、内部调用抛错、
> 跨进程 IPC 报错、voice / vision / programming-agent 等子链路报错。
> **目标**：每条报错都能让 agent **不瞎猜**地自纠（what + why + next + 候选），减少重复调用与多耗轮次。

---

## 一、好报错 7 条 checklist（新增/修改报错时逐条自查）

每条工具报错应满足：

| # | 维度 | 含义 | 示例 |
|---|---|---|---|
| 1 | **what** | 明确对象 + 失败点 | 「家长库中未找到课程《论语先进篇第二章》」 |
| 2 | **why** | 区分原因类别：`参数错` / `数据不存在` / `网络·服务端` / `配置缺失` | 「可能是课程名错误」 |
| 3 | **next** | 给下一步动作（可自愈的命令 / 重试 / 去设置页） | 「先用 kb_query progress+topic+listOnly 列出课程标题核对后重试」 |
| 4 | **候选** | 找不到 X 时附「现有 X：A/B/C」或查询命令 | 「现有孩子：珊珊、闻闻」 |
| 5 | **语言** | 中文为主；命令名 / 工具名 / 专有名词保留英文 | — |
| 6 | **不静默降级** | 「真无」vs「拉取失败/离线」必须区分；降级必须显式告知 agent | 见下节 |
| 7 | **错误类型枚举**（可选） | `ParamError | DataError | NetworkError | ConfigError` | 便于日志与测试断言 |

### 报错文案三段式模板

```
<what：对象+失败点>（<why：原因类别与具体原因>）。<next：一条可执行动作>。
```

例（达标）：

> 家长库中未找到课程「X」（可能是课程名不准确）。请先用 parent_library_courses（topic=lunyu）列出该主题的真实课程名册，核对后用完整标题重试。

### 反例（不达标）

- ❌ `Child not found`（纯英文、无对象无 next）
- ❌ `创建提醒失败`（无 why 无 next）
- ❌ `识图失败：xxx / 识图失败：xxx`（恒等分支，条件形同虚设）
- ❌ 找不到课程只返回成功文本「课程不存在」而不报错、不给候选
- ❌ 服务端不可达时 `.catch(() => null)` 静默降级，agent 把「无教法」当成事实

---

## 二、不静默降级政策（最重要一条）

**原则**：降级（离线 / 服务端不可达 / 走旧缓存）是**状态**，不是「数据不存在」；必须让 agent 感知。

| 场景 | 正确做法 | 反例 |
|---|---|---|
| 进入课程会话取不到教法 | 区分「服务端明确无此课 → 建议列课程核对」vs「网络失败 → 提示可能离线、教法缺失或旧缓存、勿当无教法」 | 仅 `console.warn`，agent 无感 |
| 拉取学习计划失败 | 提示「无计划/旧计划不代表今天没安排」，勿当空天 | 静默当空 |
| 拉取行为规范（AGENTS）失败 | 提示「本次用本地缓存/默认，家长近期编辑可能未生效」 | 静默用默认 |
| 读进度返回旧缓存 | 附「数据同步于 HH:mm，可能非最新」 | 静默当最新 |
| 家长材料本地无且拉取失败 | 返回 error（沿用 parent-library `readParentMaterial` M8-E 政策） | 静默降级 |

**实现要点**：缓存文件统一带元信息（`lastFetchOk` / `lastFetchAt` / `cachedAt`），fetch* 返回状态
（`"ok" | "not-found" | "network"`），同步读函数把「是否降级」随内容一起带出。

---

## 三、范本索引（改报错时直接抄）

| 范本 | 位置 | 亮点 |
|---|---|---|
| `parent_content` | electron/lib/custom-tools.ts | 按 reason 分类报错（not-allocated / no-course / no-method / no-content / no-html-path），各类给 what+why+next |
| `parent_library_courses` | custom-tools.ts | 主题找不到 → 附「现有主题：A/B/C」 |
| `exam_schedule_create` / `course_status` / `resolvePlanChild` | custom-tools.ts | 孩子找不到 → 附「现有孩子：…」 |
| `study_plan_update` 的 findPlanRowById | custom-tools.ts | id 找不到 → 给最近排期行锚点 + 建议先 list |
| `study_plan_create/assertPlanDate` | custom-tools.ts | 日期格式错 → 给格式示例 + 换算指引 |
| `voice/index.ts` transcribeAudio | electron/lib/voice/index.ts | 多服务逐个 fallback，语义错误（没识别到语音）不 fallback；全失败汇总各家原因 |
| `server-client.ts` ServerError | electron/lib/server-client.ts | status 0=网络错误统一文案；调用方可据此给 next |
| `parent-library.ts readParentMaterial` | electron/lib/parent-library.ts | M8-E：本地无 + 拉取失败 = 显式 error，禁止静默降级 |
| `app_config` | electron/lib/app-config.ts | 未知 key/只读/安全项/数值边界均明确；危险项要求 confirmed:true 二次确认 |

---

## 四、本次（ISSUE-063 2026-09-08）已改位置清单

### P0（不静默降级）
- `learning-summary.ts`：`fetchProgressRemote` / `fetchTodayPlanRemote` / `fetchCourseLessonRemote`
  返回 `"ok"|"network"`（课程还有 `"not-found"`）；缓存写入 `meta{lastFetchOk,lastFetchAt}` / `cachedAt`；
  新增 `getProgressSyncMeta` / `isCourseLessonCacheStale`；`getTodayPlan` 改为带日期校验返回 `{text, fresh}`。
- `agent-prompts.ts`：`fetchAgentPromptRemote` 返回 `{content, status:"ok"|"network"}`。
- `pi-session.ts`：`createChildSession` / `createSceneSession` 教法缺失/旧缓存/计划拉取失败 →
  收集 `dataNotices` 注入 `buildChildPrompt` / `buildScenePrompt`（区分 not-found vs network）。

### P1（候选动作 / 恒等修复）
- `custom-tools.ts`：`kb_update` 课程不存在 → 附 kb_query 列课程核对命令；
  `display_content` 拉取失败 → 区分网络 vs 路径不准给不同 next；
  `parent_read_image` → 按 ffmpeg/凭证/网络/其它四类分别报错；
  `schedule_task create` → 补原因 + 用 list 自检的 next。

### P2（语义与语言）
- `custom-tools.ts`：`parent_course_delete` 未删成 → 报错 + parent_library_courses 核对；
  `page_action` / `page_inspect` / `scene_command` 失败 → 附「先 display_content 展示资料」；
  `kb_query progress` 空结果 → 区分未分配/主题名不准；
  `parent_upload_material` 空路径 → 补 why。
- `child-auth.ts`：两处 `Child not found` → 中文含 childId。
- `ipc-handlers.ts`：`No active session` / `Model not found` → 中文含上下文。
- `programming-agent.ts`：写空文件报错 → 补常见原因与 next。

---

## 五、新增/修改工具时的复核

1. 新工具参数校验、数据不存在、网络失败三条路径必须分别写报错，套用「三段式模板」。
2. `throw new Error` 文案中是否包含一条 **next**？没有就不算写完。
3. 涉及远程数据：默认**不静默降级**；降级走缓存时必须带「可能非最新」提示。
4. 找不到对象（孩子/课程/主题/id）时：优先附「现有 X」候选或查询命令。
5. 面向中文 agent：报错用中文（工具名/命令名保留英文）。

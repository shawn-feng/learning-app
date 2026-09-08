# 工具报错审计清单（ISSUE-063 第一阶段交付）

> **issue**：ISSUE-063 —— 审计所有工具的报错信息：是否详细、准确、能指导 agent 下一步。
> **审计日期**：2026-09-08
> **范围**：孩子会话 + 家长会话全部自定义工具（`electron/lib/custom-tools.ts`、`daily-summary.ts`、`app-config.ts`）+ 会产生「agent/UI 可见报错」的内部调用（`pi-session.ts`、`learning-summary.ts`、`programming-agent.ts`、`voice/*`、`parent-vision.ts`、`server-client.ts`、`ipc-handlers.ts`、`exam.ts`、`child-auth.ts`）。
> **审计方式**：逐文件逐工具通读代码，按「好报错规范」7 条 checklist 打分，给出定位（文件:行）+ 问题 + 优化建议。
> **状态**：✅ 审计完成；✅ **修复已实施（2026-09-08）**——按文末「推荐实施顺序」P0→P1→P2 完成，改动明细见 `docs/TOOL-ERROR-CONVENTIONS.md` 第四节；验证：electron-vite build 通过，vitest 全量待确认。

---

## 一、「好报错」规范 checklist（ISSUE-063 建议落地的标准）

每条工具报错应满足以下 7 条（下文的评分都按它来）：

| # | 维度 | 含义 | 例子 |
|---|---|---|---|
| 1 | **what** | 明确对象 + 失败点 | 「家长库中未找到课程《X》」 |
| 2 | **why** | 区分原因类别：参数错 / 数据不存在 / 网络·服务端 / 配置缺失 | 「可能是课程名错误」 |
| 3 | **next** | 给下一步动作（命令 / 重试 / 去设置） | 「先用 kb_query progress + topic 列出课程名，核对后用完整标题重试」 |
| 4 | **候选** | 找不到 X 时附「现有 X：A/B/C」 | 「现有孩子：珊珊、闻闻」 |
| 5 | **语言** | 中文为主（专有名词/命令名保留英文） | — |
| 6 | **不静默降级** | 真「无」vs「拉取失败/离线」必须区分；降级必须显式告知 | — |
| 7 | **错误类型枚举**（可选） | `ParamError | DataError | NetworkError | ConfigError` | 便于日志与测试断言 |

评分口径：🟢 达标（可直接作范本） / 🟡 部分达标（缺 next/候选/归因其一） / 🔴 不达标（静默吞、恒等分支、纯英文、无信息量）。

---

## 二、工具总清单（3 组共 39 项）

### A 组：孩子会话工具（19 项 = 4 SDK 内置 + 15 自定义）

| # | 工具 | 定义位置 | 报错质量 | 主要问题 | 优化建议 | 优先级 |
|---|---|---|---|---|---|---|
| A1 | read / write / edit / ls（SDK 内置） | pi-session 白名单 :672 | — | SDK 自带，learning-guard 拦截越界（不在本次范围） | 若出现英文 SDK 错误，可在 learning-guard 统一中文包装 | P3 |
| A2 | `display_content` | custom-tools.ts:64 | 🟡 | 参数/越界校验齐全；但**远程拉取失败只透传底层 msg**（如网络超时原文），未给 why+next；本地文件不存在也无 next | 失败时区分「服务端不可达/资料未上传/路径不准」并给下一步：**先用 parent_content(type=htmlPath) 拿到登记的准确路径，或确认服务端已启动** | **P1** |
| A3 | `get_date` | custom-tools.ts:181 | 🟢 | 无错误路径 | — | — |
| A4 | `get_progress` | custom-tools.ts:217 | 🟡 | 只读**本地缓存**（learning-summary 会话前预取），若预取被静默吞掉 → 返回旧/空数据，agent 不知已离线 | 缓存有时间戳（ts 已存）；返回时附「数据同步于 HH:mm」（超过阈值提示可能非最新） | P2 |
| A5 | `kb_query` | custom-tools.ts:261 | 🟢 | query 枚举齐全、缺 topic 明确报错；**但「主题无进度」与「主题名拼错」未区分**（resolveRemoteTopicKey 剥路径兜底会掩盖错名） | 空结果时若疑似主题不存在，提示「用 query=topics 列出全部主题核对」 | P2 |
| A6 | `kb_insert` | custom-tools.ts:404 | 🟢 | 校验齐全，重复插入返回说明性文本（非报错） | — | — |
| A7 | `kb_update` | custom-tools.ts:517 | 🟡 | 「进度更新失败：主题 X 课程 Y 不存在」有 what 但**无 next/候选** | 附「先用 kb_query progress + topic + listOnly 列出该主题课程名核对」 | **P1** |
| A8 | `create_html_lesson` | custom-tools.ts:649 | 🟡 | 委托 programming-agent（见 C4）；本身参数校验好 | 见 C4 | P2 |
| A9 | `parent_content` | custom-tools.ts:1042 | 🟢 | **范本**：按 reason 区分 not-allocated / no-course / no-method / no-content / no-html-path，各给 what+why+next，2026-09-08 已强化 | — | — |
| A10 | `page_action` | custom-tools.ts:1499 | 🟡 | 失败返回「页面操作失败：err」不抛错；page-bridge 错误中文（超时「页面无响应（10 秒超时）」），但**未提示先 display_content 展示资料** | 超时/无响应时 next：「确认已先用 display_content 展示该资料，再重试」 | P2 |
| A11 | `page_inspect` | custom-tools.ts:1542 | 🟡 | 快照失败仅拼一句「快照获取失败：err」，无 next | 同上，附「先 display_content 展示资料；若仍失败可能是页面未打开」 | P2 |
| A12 | `scene_command` | custom-tools.ts:1582 | 🟡 | 失败文本「场景指令失败（cmd）：err」，无归因与 next | 场景页未展示时给出「先用 display_content 展示含 pi-scenario 的资料再驱动」 | P2 |
| A13 | `todo_list` | custom-tools.ts:1644 | 🟢 | 校验与说明性返回齐全；check 未找到返回「可能已被删除」 | 可附 id 前缀提示，已够用 | — |
| A14 | `schedule_task` | custom-tools.ts:1711 | 🟡 | 参数校验很全（含正则/枚举）；**但「创建提醒失败」（:1809）无原因无下一步**（:1809） | 补服务端错误体 + next「稍后重试，或改用 list 查看是否已创建成功」 | **P1** |
| A15 | `summarize_conversation` | daily-summary.ts:297 | 🟢 | 无会话返回跳过说明，不报错，语义明确 | — | — |

### B 组：家长会话工具（25 项 = 4 SDK 内置 + 21 自定义）

| # | 工具 | 定义位置 | 报错质量 | 主要问题 | 优化建议 | 优先级 |
|---|---|---|---|---|---|---|
| B1 | `parent_course_save` | custom-tools.ts:699 | 🟢 | 必填校验有；落库失败透传服务端错误（中文） | 可包一层「保存课程失败」上下文 | P3 |
| B2 | `parent_course_delete` | custom-tools.ts:1006 | 🟡 | 删除不存在的课返回**成功文本**「课程不存在：…」而非报错（语义弱），且无候选 | 改为明确提示 + 附「先用 parent_library_courses 列出该主题课程确认」 | P2 |
| B3 | `parent_topic_save` | custom-tools.ts:1182 | 🟡 | topic 格式校验好；但 assignToChildren 里 `resolvePlanChild` 找不到孩子会列候选（好）；`allocateTopicToChild` 失败**透传裸错误** | upsert/allocate 失败包上下文：「保存主题/分配孩子失败：msg」 | P3 |
| B4 | `parent_upload_material` | custom-tools.ts:759 | 🟢 | 路径/格式/目录/topic 字符校验齐全、提示「先 write 再上传」；上传失败透传错误 | 唯一短板：`上传未返回服务端路径，请重试`（:802）缺 why | 补「服务端未返回路径，可能为网络中断或服务端异常，稍后重试；若反复失败检查服务端日志」 | P2 |
| B5 | `parent_stats` | custom-tools.ts:1287 | 🟢 | mastery/daily 缺 childId 明确报错；空数据给说明性文本 | — | — |
| B6 | `log_activity` | custom-tools.ts:1467 | 🟢 | entry 必填校验 | — | — |
| B7 | `move_file` | custom-tools.ts:1114 | 🟢 | 源不存在/目标已存在报错清晰 | — | — |
| B8 | `copy_file` | custom-tools.ts:1147 | 🟢 | 同上 | — | — |
| B9 | `exam_schedule_create` | custom-tools.ts:954 | 🟢 | **范本**：缺信息提示向家长确认、孩子找不到列「现有孩子」、日期不可解析给换算指引 | — | — |
| B10 | `study_plan_create` | custom-tools.ts:1947 | 🟢 | 日期格式校验带示例与换算指引、空内容/超上限报错明确 | — | — |
| B11 | `study_plan_list` | custom-tools.ts:2017 | 🟢 | 同上 | — | — |
| B12 | `study_plan_get` | custom-tools.ts:2063 | 🟢 | 同上 | — | — |
| B13 | `study_plan_update` | custom-tools.ts:2107 | 🟢 | **范本**：findPlanRowById 给「最近排期行」锚点 + 建议先 list；act/mode 枚举校验 | — | — |
| B14 | `study_plan_sources` | custom-tools.ts:2187 | 🟢 | 孩子未分配主题给指引；主题找不到列「孩子的主题」 | — | — |
| B15 | `parent_library_topics` | custom-tools.ts:2263 | 🟢 | 空库给引导文案 | — | — |
| B16 | `parent_library_courses` | custom-tools.ts:2310 | 🟢 | **范本**：主题找不到附「现有主题：A/B/C」 | — | — |
| B17 | `course_status` | custom-tools.ts:2360 | 🟢 | 孩子找不到列候选；查询失败包上下文 | — | — |
| B18 | `app_config` | app-config.ts:288 | 🟢 | 未知 key/只读/安全项/数值边界都有明确报错；危险项要求 confirmed:true 二次确认 | — | — |
| B19 | `parent_transcribe_media` | custom-tools.ts:825 | 🟢 | 未启用语音 → 指路「设置 → 语音输入」；格式校验列支持清单 | — | — |
| B20 | `parent_read_image` | custom-tools.ts:885 | 🔴 | **`/未找到可用的 ffmpeg|网络|API key|凭证|401|403/ 时三元恒等**（:932 两分支文本完全相同）——条件写了等于没写，无法区分 ffmpeg/网络/凭证错误 | 拆成两分支：①ffmpeg → 「本机缺 ffmpeg/FFMPEG_BIN，请安装或设置后重试」；②网络/凭证 → 「视觉模型网络/凭证错误（msg），请到设置 → 模型核对视觉模型 API Key」 | **P1** |
| B21 | `parent_read_image` 底层 | parent-vision.ts:63 | 🟡 | 「视觉模型未返回任何文字」缺 why；`getVisionModel` 未配置时的错误信息是否指向设置入口待核 | 未配置/模型不可用时附「到 设置 → 模型 配置视觉模型后重试」 | P2 |

> 注：B 组家长会话另有 SDK 内置 read/write/edit/ls 4 项（同 A1，略）。

### C 组：内部调用 / 跨会话（agent 可见报错的非工具函数）

| # | 调用点 | 位置 | 报错质量 | 主要问题 | 优化建议 | 优先级 |
|---|---|---|---|---|---|---|
| C1 | **孩子会话创建 · 教法注入**（核心反例） | pi-session.ts:581,584-585 | 🔴 | `fetchCourseLessonRemote().catch(() => null)` 吞错；:584 取不到 `courseLesson` 仅 `console.warn`，**agent 完全不知「课程没取到教法」就开讲**（对应用户给的例子） | ① fetch*Remote 返回状态（ok/not-found/network-error）并落缓存；② createChildSession 判定：真无课 → 建议「用 kb_query progress + topic 列出全部课程标题核对后用完整标题重试」；网络失败 → 提示「服务端暂不可达，教法可能非最新/缺失，可稍后重进」并让 agent 在开场白前先 self-check | **P0** |
| C2 | **远程预取三兄弟静默吞** | learning-summary.ts:292/302（todayPlan）、352/373（courseLesson）、109/121（progress）；agent-prompts.ts:55/67 | 🔴 | 全部 `catch {}` 静默降级为「旧缓存/空」，agent 分不清「真没有」vs「拉取失败=离线、内容可能旧」 | 每个 fetch 返回 `{status:'ok'|'offline'}` 并写进缓存文件；同步读函数（getTodayPlan/getLearningSummary/getCourseLessonCached）把「缓存时间 + 是否 offline 降级」随结果带出，供 prompt 注入提示 | **P0**（与 C1 同根） |
| C3 | 家长库材料读取政策（正面） | parent-library.ts:771-805 | 🟢 | **范本**（M8-E）：本地无文件且拉取失败时返回 error，禁止静默降级 | 应推广到 C1/C2 | — |
| C4 | `create_html_lesson` → programming-agent | programming-agent.ts:63-65（模型未配置）,192-197,233 | 🟡 | 模型未配置报错指路清晰（好）；**:233 「未能成功写入（文件不存在或为空），请重试」缺上下文**（为何空？） | 附「检查 requirement 是否让编程 agent 写了正确的绝对输出路径；可换更具体需求重试，仍失败可换模型/稍后重试」 | P2 |
| C5 | voice 统一入口 | voice/index.ts:32-70 | 🟢 | 未启用/未配置指路清晰；多服务逐个 fallback 后汇总「所有语音服务均识别失败」并列出各家原因（好） | — | — |
| C6 | voice providers | qwen.ts:44/133/135/146/149、mimo.ts:66/72、tencent.ts:34、aliyun.ts:51、audio.ts:65/128 | 🟢 | 「没有识别到语音，请靠近麦克风再说一次」等下一步明确；HTTP 失败带 status+body 摘要 | tencent/aliyun 也可补「检查凭证/网络」next（低） | P3 |
| C7 | TTS | tts.ts:152/159、qwen-tts.ts、mimo-tts.ts | 🟢 | 空文本/未选音色/HTTP 失败均有明确中文 | — | — |
| C8 | 考核语音上传 / 提交 | exam.ts:265/283/287 | 🟢 | 未配置服务端地址、HTTP 带 status、未返回 file id 均明确 | — | — |
| C9 | 服务端通信层 | server-client.ts:21/56/70/92/106 | 🟢 | ServerError(status 0=网络) 语义化：无法连接→检查地址或网络；非 2xx 透传服务端 error 字段 | — | — |
| C10 | **孩子 profile 英文报错** | child-auth.ts:276/303 | 🟡 | `"Child not found"` 纯英文，无 childId 无候选 | 「未找到孩子记录（childId=xx），请确认孩子仍存在」 | P2 |
| C11 | **切模型 IPC 英文报错** | ipc-handlers.ts:1603/1606 | 🟡 | `"No active session"` / `"Model not found"` 纯英文，UI 直接展示给家长 | 「当前没有进行中的会话，请先进入孩子/家长会话」/「未找到模型 provider/modelId，请刷新模型列表后重试」 | P2 |
| C12 | 上传文件 IPC | ipc-handlers.ts:1806/1828 等 | 🟢 | 非法路径/文件不存在均有中文+原因 | — | — |

---

## 三、问题汇总（按严重度排序）

| 严重度 | 问题 | 影响 | 涉及点 |
|---|---|---|---|
| 🔴 P0 | 教法/计划/提示词远程预取失败一律静默吞，**孩子会话开讲时 agent 不知道「无教法/内容是旧的」** | agent 拿错误假设教学；用户点名场景 | C1 + C2（pi-session.ts:581/602/607，learning-summary.ts 三处，agent-prompts.ts） |
| 🔴 P1 | 报了「找不到课程」却从不给「先列出课程名核对」的候选动作（正是用户要的范式） | agent 反复瞎猜课程名，多耗轮次 | A7 kb_update；A2 display_content 拉取失败 |
| 🔴 P1 | `parent_read_image` 三元恒等分支，条件形同虚设 | 无法区分 ffmpeg 缺失 vs 网络/凭证错误，agent 只能乱试 | B20 custom-tools.ts:932 |
| 🟡 P1 | `schedule_task create` 「创建提醒失败」无原因无 next | agent 无法判断是网络/参数/服务端问题 | A14 custom-tools.ts:1809 |
| 🟡 P2 | page 三兄弟（page_action/page_inspect/scene_command）失败无「先 display_content」next | 卡住时 agent 不知页面未展示 | A10/A11/A12 |
| 🟡 P2 | 若干处英文报错面向中文 UI/agent（Child not found / No active session / Model not found） | 增加理解成本 | C10/C11 |
| 🟡 P2 | 若干「数据不存在」返回成功文本而非报错 / 不列候选（parent_course_delete、kb_query 空主题 vs 错主题） | 语义弱，agent 可能误以为成功 | B2、A5 |
| 🟢 P3 | 已达标但可锦上添花：错误类型枚举、get_progress 数据时效标注、C6/C7 补充 next | 便于分类与日志 | 规范落地时统一做 |

---

## 四、参考范本（改报错时直接抄）

1. **parent_content（A9）**：reason 分类 → 每类给 what + why + next。
2. **parent_library_courses / exam_schedule_create / study_plan_*（B16/B9/B13）**：找不到 X → 附「现有 X：A/B/C」或锚点行。
3. **voice/index.ts（C5）**：多候选逐次 fallback 后汇总各家失败原因，语义错误（没有识别到语音）不触发 fallback。
4. **server-client.ts（C9）**：错误带类别（ServerError.status，0=网络），调用方可据此给 next。
5. **parent-library.ts:771（C3）**：材料拉取「本地无 + 拉取失败 = 显式 error」，禁静默降级——C1/C2 应对齐此政策。

---

## 五、推荐实施顺序（待用户确认后执行）

1. **P0 根因治理（C1/C2）**：改 `learning-summary.ts` / `agent-prompts.ts` 的 fetch* 返回状态 + 缓存记录「拉取时间/是否 offline」；改 `pi-session.ts createChildSession`：courseLesson 缺失时向 agent 报告（区分「真无此课 → 建议列课程核对」vs「网络失败 → 提示稍后重进/内容可能非最新」）。
2. **P1 快速修复**：A7 kb_update、A2 display_content、B20 parent_read_image、A14 schedule_task 四处报错文案改造（每处 ≤10 行）。
3. **P2 收尾**：page 三兄弟 next、child-auth/ipc-handlers 中文化、parent_course_delete 语义化、kb_query 空结果区分。
4. **规范落地**：新增 `docs/TOOL-ERROR-CONVENTIONS.md`（7 条 checklist + 本表索引）；加一个轻量扫描脚本核对 `custom-tools.ts` 所有 `throw new Error` 是否含 next。
5. **测试**：对 P0 改造加最小回归——模拟「服务端不可达」进入课程会话，断言 agent 收到降级提示（而非静默）。

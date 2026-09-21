# 待解决问题清单 (Open Issues)

> 本文件为**索引**。每条 issue 的详情已拆分到独立文件：`ISSUES/ISSUE-XXX.md`（重复编号用 `-2` 后缀区分）。
>
> **2026-08-30 重置说明**：项目已切换至「客户端 + 服务端」拆分架构（SPLIT，见 `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md`）。
> 原 ISSUE-001 ~ 052 为旧架构（一体化 Electron）时期记录，已整体归档至 `ISSUES-archive-2026-08-30.md`，不在本清单保留。
> 本清单只记录新架构下的问题。

> 共 **122** 条 issue（详情见 `ISSUES/` 目录）。

| 编号 | 标题 | 优先级 | 记录时间 | 详情 |
|------|------|--------|----------|------|
| 001 | 家长界面孩子管理：孩子卡片上恢复学习进度展示 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-001.md) |
| 002 | 家长设置·定时任务：去掉「会话重置」，用「自动新建会话」即可 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-002.md) |
| 003 | 家长设置·数据备份：改为服务端数据备份/恢复（zip 上传覆盖），去掉跨机进度查询 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-003.md) |
| 004 | 孩子管理·分配学习主题：支持移除某孩子的某主题，有学习记录则保留记录 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-004.md) |
| 005 | 家长模式：孩子卡片进度改为 icon 入口，点击进入详细进度看板（与孩子模式一致） | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-005.md) |
| 006 | 学习进度：孩子模式点主题后看不到详细课程学习情况；两模式界面/操作需完全一致 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-006.md) |
| 007 | 孩子详情页：点击孩子卡片进入详情页（标签页组织进度/主题/prompt 等），不再用弹窗 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-007.md) |
| 008 | 孩子界面：学习资料展示区可折叠；display_content 调用时自动展开并展示最新内容 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-008.md) |
| 009 | 聊天消息 markdown：字体放大一倍便于孩子阅读；行间不留空行、保持正常行距 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-009.md) |
| 010 | 聊天消息输入框：语音输入（按住说话）按钮消失，需补回 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-010.md) |
| 011 | 学习资料 html 里的语音（朗读按钮）音色与聊天语音不一致，需统一 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-011.md) |
| 012 | 分配学习主题列表与课程管理不一致：课程管理 9 个主题，分配主题时不足 9 个 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-012.md) |
| 013 | 知识记录：Electron 里 speechSynthesis 为什么选不到 Edge 在线神经语音 | — | 2026-08-30 | [详情](ISSUES/ISSUE-013.md) |
| 014 | 孩子 agent 调用 page_inspect 多次失败，需定位失败档位 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-014.md) |
| 015 | 孩子页面操作不自动投递 agent，随下一轮消息附带发送 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-015.md) |
| 016 | 孩子界面：中间展示区折叠按钮仅学习资料页有，学习进度等页也需支持折叠 | 已完成 | 2026-08-30 | [详情](ISSUES/ISSUE-016.md) |
| 017 | 孩子界面：学习资料点击/选中不认识的字词，显示读音+释义（不修改资料 html） | 已完成 ✅ |  | [详情](ISSUES/ISSUE-017.md) |
| 018 | 孩子界面：每学完一课压缩当前会话历史，节省 token | ⏸ 暂缓 / 暂不处理 | 2026-08-31 | [详情](ISSUES/ISSUE-018.md) |
| 019 | 家长端按孩子设置课程时间段，上课/下课在 app 顶部 1/3 区域提醒（铃声 + 语音播报） | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-019.md) |
| 020 | 孩子端左侧「切换展示页」浮层：鼠标移到选项框就消失、难选中 | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-020.md) |
| 021 | 孩子端学习资料列表：课名显示"未命名" + 重发资料不刷新/卡在别的课程 | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-021.md) |
| 022 | 测试债务：9 个测试文件未随 SPLIT 迁移更新，全量 vitest 稳定失败 39 例 | 低 | 2026-08-31 | [详情](ISSUES/ISSUE-022.md) |
| 023 | 孩子聊天框字号设为可调节设置项，入口放孩子左侧边栏 | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-023.md) |
| 024 | 聊天框调宽手柄：当前是"点一下进入拖拽模式、再点一下退出"，应改成"按住拖拽、松手即停" | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-024.md) |
| 025 | 孩子 Todolist：家长/孩子/agent 共建，定时生成+统计，边栏弹框查看，家长规定项不可改 | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-025.md) |
| 026 | 孩子左侧边栏常驻折叠，所有交互统一改为点击 icon 弹框（不再内联展开） | 已完成 | 2026-08-31 | [详情](ISSUES/ISSUE-026.md) |
| 027 | 学习考核（全主观题语音作答 + 客户端出卷/判分 + 服务端存储 + v3 选课 LLM）——需求文档 `EXAM-REQUIREMENTS.md`，2026-09-01 实施完成 | 已完成 | 2026-09-01 | [详情](ISSUES/ISSUE-027.md) |
| 028 | 服务端增加 agent 功能：会话同步上云 + 无头 worker + 家长对话回顾（方案B） | 已完成 | 2026-09-01 | [详情](ISSUES/ISSUE-028.md) |
| 029 | 英语学科：复用现有科目体系 + 英文教学 + 教学后发音测评入 daily（终版 2026-09-04） | 需求终版已定(2026-09-04)，任务 1 已完成，任务 2-4 待实施。 | 2026-09-01（内容 2026-09-04 终版重写） | [详情](ISSUES/ISSUE-029.md) |
| 030 | 学习资料显示字号可调（孩子左侧边栏加「资料字号」按钮） | 已实施 | 2026-09-01 | [详情](ISSUES/ISSUE-030.md) |
| 031 | 查词浮层优化（拼音放大 + 多音字分行各有朗读 + 不显示意思） | 已实施 | 2026-09-01 | [详情](ISSUES/ISSUE-031.md) |
| 032 | 全链路加载态：登录 / 主页 / 内容未加载完都要显示「正在干什么」，加载完再显示页面 | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-032.md) |
| 033 | 灵活学习计划：对话驱动的逐日排期表（study_plans 替换 rules_json.daily） | ✅ **实施完成 | 2026-09-02（2026-09-03 更新） | [详情](ISSUES/ISSUE-033.md) |
| 038 | 定时任务新模型：任务管理页（先创建任务 → 分配给孩子）+ 执行结果查询 | 已完成 | 2026-09-02 | [详情](ISSUES/ISSUE-038.md) |
| 034 | 聊天气泡 markdown 渲染空行过多、消息被拉长（需紧凑化） | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-034.md) |
| 035 | 取消右侧聊天框可调节的最大宽度限制，宽度持久化到本地（重启 app 仍保留） | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-035.md) |
| 036 | 聊天框上传应支持任意文件类型（JSON 等现被拦截） | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-036.md) |
| 037 | 家长聊天框支持上传文件，落到家长 uploads 目录且家长 agent 能读取 | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-037.md) |
| 039 | 家长 agent 会话历史退出再进不显示（落盘有、进入不加载） | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-039.md) |
| 041 | 家长页面左侧边栏去掉「孩子列表」，添加孩子入口收进「孩子管理」 | ✅ 已完成 | 2026-09-02 | [详情](ISSUES/ISSUE-041.md) |
| 042 | 家长 agent 也要支持 /reset、新建会话等会话管理命令（对齐孩子端） | 已实施 | 2026-09-02 | [详情](ISSUES/ISSUE-042.md) |
| 043 | 生产环境珊珊（Mac 客户端）会话未同步上云：家长回看空白 + 服务端每日汇总跳过 | 高 | 2026-09-03 | [详情](ISSUES/ISSUE-043.md) |
| 043-2 | 现场取证 + 同步机制澄清（2026-09-03 登 201 `192.168.1.201`） | — |  | [详情](ISSUES/ISSUE-043-2.md) |
| 044 | 客户端 + 服务端统一日志系统（便于远程排查） | 中 | 2026-09-03 | [详情](ISSUES/ISSUE-044.md) |
| 045 | 孩子 agent 会话注入：去掉「学习进度概览」，改为注入当天学习计划（无 todolist 则不注入） | 中 | 2026-09-03 | [详情](ISSUES/ISSUE-045.md) |
| 046 | 学习考核 Ubuntu 客户端点「按住说话」录音按钮提示「没有权限」（Linux 特有媒体权限预检缺失） | P0 | 2026-09-03 | [详情](ISSUES/ISSUE-046.md) |
| 047 | 孩子端：让 agent 直接制定「定时任务」（到点语音提醒 + 频率设置） | ✅ 已完成 | 2026-09-04 | [详情](ISSUES/ISSUE-047.md) |
| 048 | 考核录音在 Ubuntu+Mac(Chromium143) 报 permission denied + 「下一题」点亮却点不动 | P0 | 2026-09-05 | [详情](ISSUES/ISSUE-048.md) |
| 049 | 家长端孩子管理：新增「每日记录(Daily)」标签页，左列条目 / 右显内容，默认最近 7 天 + 日期范围选择器 | 待定 | 2026-09-05 | [详情](ISSUES/ISSUE-049.md) |
| 050 | 考核出题改异步流式：首门课就绪即开考，其余课程后台生成并增量加入答题流 | — |  | [详情](ISSUES/ISSUE-050.md) |
| 051 | 会话同步：珊珊（本地环境）持续报 500 internal server error | 高 | 2026-09-05 | [详情](ISSUES/ISSUE-051.md) |
| 052 | 本地语音 ASR：默认千问 token-plan 报「千问识别失败：未返回识别文本」 | 高 | 2026-09-05 | [详情](ISSUES/ISSUE-052.md) |
| 053 | 定时任务·课程时间段：当天设置当天触发，过一天就丢失需重设 | 高 | 2026-09-06 | [详情](ISSUES/ISSUE-053.md) |
| 054 | 设计讨论：每个学习主题用独立会话+独立 system prompt（当天所有课程在该会话完成）——对省 token / 防主题串味是否有用？ | 待定 | 2026-09-06 | [详情](ISSUES/ISSUE-054.md) |
| 055 | 家长 agent 缺「上传资料到 server 指定目录」工具：自动制作课程资料后无法推上服务端真源 | 中 | 2026-09-06 | [详情](ISSUES/ISSUE-055.md) |
| 056 | 家长端 agent 制作学习资料注意事项：视频必须 H.264（禁用 HEVC/H.265）+ 必须走 upload 接口上服务端 | 高 | 2026-09-06 | [详情](ISSUES/ISSUE-056.md) |
| 057 | 家长端删除孩子：该孩子 uuid 目录（本地 + 服务端真源）未清理 | 高 | 2026-09-06 | [详情](ISSUES/ISSUE-057.md) |
| 058 | 201 生产环境：21:00 recording 任务在同一孩子会话里当天执行多次（珊珊 3 次 / 闻闻 2 次） | 高 | 2026-09-06 | [详情](ISSUES/ISSUE-058.md) |
| 059 | 课程时间表优化：按「模板 + 星期」分配（上学日 / 周末分别设置，周末可不固定） | 中 | 2026-09-07 | [详情](ISSUES/ISSUE-059.md) |
| 060 | 学习资料 iframe ↔ 主页面通讯：开放「作者可控」协议（特定操作才通讯 + 接口契约） | 中 | 2026-09-07 | [详情](ISSUES/ISSUE-060.md) |
| 061 | 场景化角色扮演学习：网页模拟真实场景，孩子在场景中扮演角色，用语音与场景内多个 agent 角色互动（v1 样例已实现并实测，持续迭代） | — | 2026-09-07（讨论，未开工） | [详情](ISSUES/ISSUE-061.md) |
| 062 | 设计讨论：用「会话树分支」让一个课程/主题成为 pi 会话树的一支，以节省 token 缓存消耗（prompt cache） | 低 | 2026-09-07（讨论，未开工） | [详情](ISSUES/ISSUE-062.md) |
| 063 | 审计所有工具的报错信息：是否详细、准确、能指导 agent 下一步（含「查课程找不到→建议先列全部课程名核对」） | 中 | 2026-09-08 | [详情](ISSUES/ISSUE-063.md) |
| 064 | 主页（选择身份）孩子列表溢出无滚动条：孩子多了显示不全 | 中 | 2026-09-08 | [详情](ISSUES/ISSUE-064.md) |
| 065 | 选课机制重构：固定档必学全考/自定义须课程/下线长周期档（2026-09-09） | — | 2026-09-09 | [详情](ISSUES/ISSUE-065.md) |
| 066 | 家长 agent 课程内容职责增强：考核内容(rubric)/考核方法(assess_method)编写能力 + 格式约定送达（需求记录，后续处理） | ✅ 已实施 | 2026-09-09 | [详情](ISSUES/ISSUE-066.md) |
| 067 | 考核内容结构化：题型目录 + 类型块(题干+内嵌评分,DB真源) + methodSpec 按孩子选类型（设计定案，待实施） | 待实施 | 2026-09-09 | [详情](ISSUES/ISSUE-067.md) |
| 068 | 停止 agent 后仍报 "Agent is already processing"：会话中止后重发消息被 SDK 重入守卫拦截（bug，已修复） | 中 | 2026-09-09 | [详情](ISSUES/ISSUE-068.md) |
| 069 | 自动化测试客户端：用真实对话驱动孩子/家长 agent，断言行为与工具调用是否符合预期（测试框架讨论，待实施） | 中 | 2026-09-10 | [详情](ISSUES/ISSUE-069.md) |
| 070 | 背诵/跟读题：一次录音后题目即被锁定（变「完成」），无法多段录音拼接 | 已实施 | 2026-09-11 | [详情](ISSUES/ISSUE-070.md) |
| 071 | 家长可撤销孩子某一条积分变动记录（流水备注名「撤销」，撤销后重算余额） | 中 | 2026-09-11 | [详情](ISSUES/ISSUE-071.md) |
| 072 | 自定义考核计划需有「标题名」，家长 agent 创建时必须填入（区分 note 给孩子的说明） | 中 | 2026-09-11 | [详情](ISSUES/ISSUE-072.md) |
| 073 | 考核内容模型切换：类别(topic_categories) → 知识点(knowledge_points)（数据已就位，差代码切换；改 API 形状，须与客户端同批） | 中 | 2026-09-11 | [详情](ISSUES/ISSUE-073.md) |
| 074 | 家长端列表静默 LIMIT 截断（题库 2000→3575 只显示 2000 已修；排期 100→1000 已修；记录 60 待评估；题库需分页/过滤） | 中 | 2026-09-11 | [详情](ISSUES/ISSUE-074.md) |
| 075 | 客户端推送空「固定档频率」→ 服务端**无作用域 DELETE** 掉未来排期（生产 136→18 行；已清空排期并暂时关闭考核）——**✅ 已随 ISSUE-094 彻底解决（2026-09-14）：exam_schedules 排期表已取消（DROP TABLE），无作用域 DELETE 代码一并删除，风险根源不存在** | ✅ 已解决（2026-09-14，随 ISSUE-094） | 2026-09-11 | [详情](ISSUES/ISSUE-075.md) |
| 076 | 学习计划完成判定只认 `courses.last_review`（唯一写入方是 AI 手写），`last_review='-'`/无日期的课永远判不了完成（珊珊 383/613 门；todolist 7 条 pending 全因无日期） | **高** | 2026-09-11 | [详情](ISSUES/ISSUE-076.md) |
| 077 | DeepSeek 官方模型名变更：`deepseek-v4-flash` 已下线应改 `deepseek-flash`（官方直连通道 SDK；百炼套餐快照名待核实） | 中 | 2026-09-11 | [详情](ISSUES/ISSUE-077.md) |
| 078 | 家长上传文件后家长 agent 读不到：【附件文件】标记路径被错误剥 `parents/<pid>/` 前缀 + 聊天未透传登录家长 id（全落 `parents/default`） | ✅ 已实施 | 2026-09-12 | [详情](ISSUES/ISSUE-078.md) |
| 079 | 家长 agent 无法整理/治理服务端课程学习资料：缺 list/read/delete/move 的 agent 工具封装（仅暴露上传） | 高 | 2026-09-12 | [详情](ISSUES/ISSUE-079.md) |
| 080 | 设计讨论：agent 从客户端迁到 server 端——**✅已定案：不要过渡 / agent 只在 server / client 零 agent；5 项设计点全部拍板（page_* 保留并上移、TTS server 合成、提醒本地播放、硬断代、programming-agent 上移）** | **高** | 2026-09-12 | [详情](ISSUES/ISSUE-080.md) |
| 081 | agent 服务端化：共享包 + 会话权威 + SSE + 家长/孩子/考核/编程 agent 上移 + 客户端零 agent——**✅ P0~P4 已实施（服务端 0.4.0，server_agent/parent_agent/exam_agent 特性；本地 agent 代码已删）** | 高 | 2026-09-12 | [详情](ISSUES/ISSUE-081.md) |
| 082 | 家长 agent「parent-content」会话：注释声称"专门提示词、与通用助手解耦"，实际与 parent 共用同一 `buildServerParentPrompt`，解耦仅限会话实例/历史/流层面，提示词层面未真正解耦 | 待定 | 2026-09-13 | [详情](ISSUES/ISSUE-082.md) |
| 083 | agent 提示词不再对用户开放编辑与查看：仅存于系统内部，孩子端 prompt 因含系统信息更不可展示，收敛 AgentPromptEditor 入口 | ✅ 已解决（2026-09-13） | 2026-09-13 | [详情](ISSUES/ISSUE-083.md) |
| 084 | agent 工具/后端方法命名未体现目标库表，可读性差（`parent_plan_create` 实际写孩子库 life_plans，名称看不出落库）；建议统一"库简写_表名_动作"命名规范 | ✅ 已解决（2026-09-13） | 2026-09-13 | [详情](ISSUES/ISSUE-084.md) |
| 085 | 考核场次无删除/取消操作：孩子库 `exam_plans` 全仓无 DELETE/cancel 端点（既无 agent 也无 REST），一旦生成永久留存；主库 `exam_schedules` 删除仅限 pending 状态（误排进行中无法撤） | ✅ 已解决（2026-09-13） | 2026-09-13 | [详情](ISSUES/ISSUE-085.md) |
| 086 | 添加孩子表单密码标签「登录密码（仅存本地）」与实际实现不符：密码 bcrypt 哈希经 `POST /children` 上传并存入服务端 `children.profile_json`，登录由 `POST /children/auth` 服务端校验（多设备共享），本地仅离线回退——文案误导用户隐私预期 | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-086.md) |
| 087 | 家长 agent 缺「添加/编辑孩子」能力（仅有只读 `parent_list_children`）；需求定调：应能添加、编辑孩子，**不应**提供删除（删除仍由家长 UI 走 REST）；另需决定 `max_children` 上限校验是否上移服务端（现仅客户端校验，agent 创建会绕过） | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-087.md) |
| 088 | agent 上移服务端后客户端遗留死轮询/死接口：5min 会话同步仍打**已删除**的 `POST /sessions/:childId/sync`、10min `/version` 探测无消费者（`hasServerFeature` 全仓无调用）、`app-config.ts` 孤儿模块、云端 eventPoll 每 2min 打旧消息交换通道（ISSUE-041 遗留）；另 `app_settings` 客户端只剩 `materialsLimit` 有消费方 | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-088.md) |
| 089 | `parent_upsert_topic` / `parent_upsert_course` 已定义、已进 `PARENT_AGENT_TOOL_NAMES` 白名单，但**未加入 `createParentAgentTools` 的 return 数组** → 白发白名单、工具实际不可调；家长 agent prompt 还明确指引用它们落库主题/课程 → 对话式建主题/加课当前不可行（只能走 UI REST） | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-089.md) |
| 090 | 客户端 SSE 桥 `translateAgentEvent` **无 `page_cmd` 分支** → 场景课/资料页受控下行指令（`scene.move/act/show/highlight/update`、`page_action`）全部被丢弃，仅 `say` 台词经旁路可达 = "台词有、动作无"；回执 `page-result` 链随之失效 | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-090.md) |
| 091 | 孩子无法通过 AI 创建「学习 / 考核」计划（只有 `child_life_plan_create`；缺 `child_study_plan_create` / `child_exam_plan_create`），与说明书 §3.4「学习/考核/生活三种计划孩子都能自己定（加分项）」不符；另 `plan_recurrences` **全仓无写入路径**（重复规则不可设置）、`/plans/exam`、`/plans/life`、`/study-plans` 三个落库 REST 成孤儿（无调用方）；数据模型与加分项计分（creator 分组）已就绪，补工具即可 | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-091.md) |
| 092 | 自定义考核「本次方法覆盖」用户不可达：`assess-selection.ts` 的排期级 `scope.methodSpec`（require/exclude/recitePass，优先于主题级）**读取侧已实现**，但 `parent_exam_plan_create` 的 scope 只有 `{topics,courses,note}` → 家长 AI 无法表达"本次只考背诵/只考某知识点"；REST `POST /exam/schedules` 接受任意 scope 但无调用方 —— 与说明书 §3.5.1 不符 | ✅ 已解决（2026-09-14） | 2026-09-13 | [详情](ISSUES/ISSUE-092.md) |
| 093 | 家长端发音评测「测试测评」结果展示错乱：总分 undefined、流利度 [object Object]（`AssessmentSettings.tsx` 读 `res.score`/`res.fluency`，但 `SpeechAssessment` 真契约总分是 `pron`、流利度是 `{overall}` 对象） | ✅ 已解决（2026-09-14） | 2026-09-14 | [详情](ISSUES/ISSUE-093.md) |
| 094 | 考核域重构（用户定案）：**取消 `exam_schedules` 排期表**（DROP TABLE）——每日/每周固定考核改为**配置项**（`exam_fixed:<parentId>`），worker plan tick 每天检查配置生成当天 `exam_plans`（幂等，GET 列表兜底补跑）；**自定义考核直接写入 `exam_plans`**（agent 工具 + 管理面板同口径）；`/exam/schedules*` 路由路径保留但语义全部改为操作 `exam_plans`（渲染层零改动）；副产品：ISSUE-075 无作用域 DELETE 风险随表取消彻底消除 | ✅ 已实施（2026-09-14） | 2026-09-14 | [详情](ISSUES/ISSUE-094.md) |
| 095 | 家长端点「停止」agent：UI 显示「⏹ 已停止」但实际仍在运行——`pi:abort` 主进程是 no-op（注释明写"服务端尚无中止能力"），服务端 `parent-registry` 也无 abort 端点，导致家长/孩子端停止都不生效 | ✅ 已解决（2026-09-14） | 2026-09-14 | [详情](ISSUES/ISSUE-095.md) |
| 096 | 服务端重启后家长/孩子 agent「永远思考中」：`openSse` 一次性连接断后 `agentStreams` 死句柄占位、**从不重连**（服务端日志/落盘证实回复正常、纯送达链路断）——修复：`openSse` 重写为自动重连 + `?lastEventId=` 续传，断线轮次自动补齐 | ✅ 已解决（2026-09-14） | 2026-09-14 | [详情](ISSUES/ISSUE-096.md) |
| 097 | 家长 agent 调 `parent_build_material` 报「agent 模型未配置」，但家长设置页显示已配置——设置页走「本地 app-settings.json（旧构建）/服务端」显示已配置，而服务端 agent 读服务端 `app_settings` 取不到 `programmingModel`；当前源码三路都收口同一服务端键故正常构建不该复现，疑为线上旧客户端构建仍走本地分支导致本地/服务端存储分裂 | ✅ 已解决（2026-09-14）：核实当前链路自洽（服务端实存值 + 端到端验证）；根除残留覆盖机制——app-settings 本地文件只存 materialsLimit、保存改走 /models/app_settings 合并端点（旧实现整键推送会覆盖服务端模型配置）、reconcile 去掉模型字段补齐、未配置报错带 parentId | 2026-09-14 | [详情](ISSUES/ISSUE-097.md) |
| 098 | 考核功能两项：①「背诵考核」配置未生效——背诵题仅由题库 `behavior:speech_recite`/语料驱动，而 LLM 出题链路被硬编码禁止生成背诵（`exam-engine.ts` L78-81），`methodSpec` 只有 `recitePass` 通过线无「只背诵」模式开关，`attachStructuredQuestions` 按知识点而非 behavior 筛题→非结构化课 `recQ=0` 不出背诵、有语料课也只是「1背诵+2~3文字」而非纯背诵；② 珊珊会话出题单次 LLM 调用 32~92s（~40s 对应论语 04:39 那次 41.3s），判分每题重建 session 致 45~104s，端到端约 1.5~2 分钟 | 🟡 待处理 | 2026-09-14 | [详情](ISSUES/ISSUE-098.md) |
| 099 | 珊珊 life plan「洗两双袜子」完成状态不更新（仍 pending）：`summarize_conversation` 已写 daily，但 `daily_entries` 出现两行——① `洗两双袜子（孩子自定加分项）` plan_id 列正确但 **plan_outcome=unknown**；② `洗袜子` **plan_id/plan_outcome 列全空、done 信号只写在 raw 正文**（`- planOutcome：done`）；完成判定只匹配 `plan_id!='' AND plan_outcome='done'` → 两行都不中；根因=AI 把 planId/planOutcome 退化成 raw 文本（`insertMany` 仅读结构化字段）+ `unknown` 是死路无收敛/无人工覆盖 + `parent_life_plan_update` 无 complete 动作 | ✅ 已解决（2026-09-14）：F1 家长 complete 动作（pending/missed 可标 done）+ F2 applySignals raw 正文兜底回捞（治愈存量）+ F3 insertMany 正文解析与同 plan 同日去重合并 + prompt 明令禁止 planId/planOutcome 写进正文；真实数据端到端验证通过，珊珊计划已治愈为 done；F4（unknown 自动放行）维持现状防钻空子 | 2026-09-14 | [详情](ISSUES/ISSUE-099.md) |
| 100 | agent 上移服务端后「每日新建会话省 token」机制丢失：旧客户端 `pi-session.shouldAutoNewSession`（开会话检测最后消息非当天→开新会话）已随零 agent 移除（仅存 `tmp/pi-session-old.ts`）；服务端 `session-registry.ts:261` 的 `shouldAutoNewSession` 只判 `resetMarks`（显式 reset），**不按日期**；会话 key=childId 跨天持久累积（落盘 `data/agent-sessions/<parentId>/<childId>-<slot>/`）；客户端 `scheduler.ts:552-571` 残留定点重置块但默认 `enabled:false` 且仅"客户端在线那一分钟"触发，等于失效 → token 不省 | ✅ 已解决（2026-09-14）：F1 冷路径（/open 进会话跨天裁决 + shouldAutoNewSession 日期保险）+ F2 热路径（服务端 autoNewSessionTask 到点重置，配置默认仍 opt-in）+ 客户端进会话加载切 /open；待部署 201 验证 | 2026-09-14 | [详情](ISSUES/ISSUE-100.md) |
| 101 | 孝经/千字文「背诵」题结构已存在但数据残缺：两主题 18+30 门课每课都有「背诵」知识点 + 1 条 `speech_recite` 题；但**千字文 30 段的背诵题 answer 全是占位符 `重点字词（童趣版）`**（非原文，背诵评测据此打分→不可用），**孝经 18 章答案为真原文但实测 18 章末尾全被拼上 `重点字词读音` 噪声**（原 issue 误判仅 4 章）——并非缺知识点/缺题，而是建课时把解读误填进参考文本列 | ✅ 已解决（2026-09-14）：千字文 30 条 answer 替换为 `teaching_copy`「原文吟诵」真原文（带标点）；孝经 18 条 `REPLACE` 剔除 `重点字词读音` 噪声；已备份，待同步生产 201 | 2026-09-14 | [详情](ISSUES/ISSUE-101.md) |
| 102 | 家长 agent 缺「读取孩子全部会话内容」工具：现有家长工具只覆盖资料/家长库/计划域，**无任何读孩子对话逐字稿的工具**（计划工具仅给摘要）；但底层读链路已存在且经「家长对话回顾」页验证——`db/sessions.ts` 的 `indexAgentSessionsIntoDb`/`querySessionMessages`/`listSessionDates` + `routes/sessions.ts` 的 `assertChildOwned` 归属校验。**⚠️ 本需求扩张原隐私红线「家长 agent 只读孩子数据 summary、不触碰原始对话」**——属家长授权扩张，应保留只读 + 归属校验 + 按天/限量读取 | ✅ 已实施（2026-09-15）：新增 `parent_read_child_conversation`（只读；按天 / all+days≤7；单条 600 / 总量 16000 字符截断）+ prompt 边界段 + 文档隐私边界更新；真实数据冒烟 5 例通过 | 2026-09-15 | [详情](ISSUES/ISSUE-102.md) |
| 103 | 家长 agent 管理课程时缺「知识点 + 题库」管理工具：主题/课/教学/资料已有工具（parent_upsert_topic/course、parent_put_material 等），但**无法创建课程知识点、无法创建/维护题库题、无法把题关联到知识点**——第 4、5 步只能走 UI（REST）；底层 DB（assess-content.ts 的 question_bank/knowledge_points/course_knowledge_questions + saveQuestion/getOrCreateKnowledgePoint/replaceCourseContent）与 REST（POST /assess/questions、POST /assess/courses/save）均已齐备可用，属"封装 agent 工具"缺口，非新设计 | ✅ 已解决（2026-09-15）：新增只读 `parent_library_course_content` + 写 `parent_upsert_course_content`（整课替换，含只读预校验 + 移除告警）+ prompt 段；冒烟 29/29；服务端 0.4.2 已部署 201 | 2026-09-15 | [详情](ISSUES/ISSUE-103.md) |
| 104 | 家长端「考核管理 → 自定义考核」**白屏** + 家长 agent 查考核计划**看不到课程/细节**——同一根因：`exam_plans.scope_json.courses` 自 2026-09-14 起改为 `[{title,kps:[{name,count}]}]`（计划生成时即约定出题参数），但两个消费方仍按旧格式 `["课程名"]` 处理：① `ExamAdminPanel.tsx` 直接把数组项当 React 子节点渲染 → `Objects are not valid as a React child` → 整树卸载白屏（本地 dev 无自定义考核故不复现）；② `parent_exam_plan_list` 用 `String(x)` 转对象 → `[object Object]`，agent 看不到考了哪些课、更看不到每课考哪些知识点 | ✅ 已解决（2026-09-15）：服务端新增 `parsePlanCourses`/`formatPlanCourses` 归一化（两格式兼容）；agent 列表改为「课程（知识点×题数）+ 考核方法 + 说明」；`GET /exam/schedules/:childId` 把 courses 归一成课程名数组（老客户端不再白屏）+ 新增 `courseSpecs` 供新端展示；客户端抽 `PlanCourseList` 组件 + `src/lib/plan-scope.ts`，9 条回归用例（含"对象当子节点确实抛错"的机理对照）；**服务端 0.4.3 已部署 201（13:33）**，接口级验证 `scope.courses` 已是字符串数组 → 老客户端即不再白屏 | 2026-09-15 | [详情](ISSUES/ISSUE-104.md) |
| 105 | 设计讨论/实施：让 agent 具备受控 SQLite 直接操作能力（db-channel 通道，终结「一个新场景加一个工具」）——P1 家长受控写 + P2 孩子受控读写已实现（回归 30 项全绿），P3 受控只读 SQL 待观察，**待部署 201** | 🚧 分期实施中 | 2026-09-16 | [详情](ISSUES/ISSUE-105.md) |
| 106 | 孩子界面字号设置入口合并：聊天字号（Type icon）+ 资料字号（TextSelect icon）两个独立 icon/弹框收进**一个 icon 探出的页面**（弹框内分「聊天字号」「资料字号」两组档位按钮；state/持久化/CSS 变量链路不动） | ✅ 已解决（2026-09-17）：侧栏收口为一个 Type icon（title 汇总两组当前值）+ `showFontPanel` 单弹框两分组（`.modal-section-label` 新样式）；fontSize/matFontSize 与 localStorage key、CSS 变量下传链路零改动；build 通过 | 2026-09-17 | [详情](ISSUES/ISSUE-106.md) |
| 107 | 家长聊天区域重新进入看不到当前会话历史消息——ISSUE-081 服务端化把 ISSUE-039 修复架空：`pi:start_parent` 硬编码返回 `history:[]` + 服务端无家长会话 history/open 端点（孩子端已走 `POST /agent/:childId/open`，家长端联调点未接）；落盘与 agent 上下文记忆正常，纯 UI 恢复链路断 | ✅ 已解决（2026-09-17）：服务端新增 `POST /parent-agent/open`（kind 区分 parent/parent-content；家长**不做跨天裁决**、返回现会话全部历史）+ 客户端桥 `openParentSession()`（复用 mapHistoryMessages）+ `pi:start_parent`/`pi:start_parent_content` 透传真实 history（旧服务端 404 兜底空数组，向后兼容）+ ParentChatPanel 回填零改动恢复、TopicEditor 同批接上；**服务端改动待部署 201** | 2026-09-17 | [详情](ISSUES/ISSUE-107.md) |
| 108 | 家长界面可定制 Dashboard：家长自定义「孩子学习进度与情况」展示页，定制经家长 agent 对话完成——方案建议：声明式 widget 配置（agent 只写受控 JSON、不产 HTML）+ 客户端注册表渲染（7 类 widget 白名单，全部复用现有数据源）+ 配置存 settings 键 `dashboard`（零新表）+ `parent_dashboard_get/set` 两工具；Dashboard 新增 view 并设默认落地页 | 中（方案待拍板） | 2026-09-17 | [详情](ISSUES/ISSUE-108.md) |
| 109 | 家长 agent db 通道需能读主库 `exam_attempts` 表（成绩/逐题/错题/巩固建议）——家长侧现无任何考核成绩读取工具（prompt 只能引导去 UI）；且家长侧 db 通道只有 describe+write、**无 `parent_db_read`**（孩子侧三件套齐全）。方案：新增 `parent_db_read`（补齐对称性）+ 主库受控只读登记表（exam_attempts 第一张，强制 parent_id/child_id 归属过滤、只读、行数上限+审计、JSON 大列截断）——「主库不进直连白名单」原则的首个受控豁免，仅此一张、仅读 | 中 | 2026-09-17 | [详情](ISSUES/ISSUE-109.md) |
| 110 | 盘点：`parent_db_*` 工具能操作哪些表？——`parent_db_describe`/`parent_db_write` 均基于 `parentLibTableRegistry()`（db-channel.ts L79），**只能操作家长内容库 parent.sqlite 的 6 张表**：topics/courses/tags/question_bank/knowledge_points/course_knowledge_questions（均 insert/update/delete，带列白名单+外键校验+行数熔断+审计+敏感列二次确认）。爆破半径严格限定课程内容，**不触达孩子库/计划/积分/成绩/会话**。缺口：parent 侧**无 `parent_db_read`**（只能 describe+write），读内容只能走专用 `parent_library_*` 或 UI；主库 `exam_attempts` 读取仍无工具（ISSUE-109 覆盖） | 中 | 2026-09-18 | [详情](ISSUES/ISSUE-110.md) |
| 111 | SQLite 向量旁表 + 「精确匹配落空 → 向量检索兜底」：LLM 记错课程/主题名时 `WHERE =` 查不到 → 只能全表列出肉眼匹配（courses 600+ 行，上下文爆炸）。方案：`embeddings` 旁表（业务表零变更、JS 内存余弦，sqlite-vec 缓议）+ 首批向量化 `courses.title`/`topics.name` + 新增 embedding 模型配置键 + 写路径异步重嵌入/backfill + 收口 `lookupWithFallback`（精确命中原样返回；0 行 → top-K 候选并明确标注「精确匹配无数据，以下为向量检索返回，请判断选哪一个」，只提示不代入；服务不可用静默降级） | 中 | 2026-09-18 | [详情](ISSUES/ISSUE-111.md) |
| 112 | ✅ 已解决（2026-09-19）：计入积分的考核得分率为 0（珊珊 9/10 被记 0% 误扣 15 分）——根因=09-14 考核 v2 提交路由先行置 `exam_plans.done+attempt_id`，worker `applyExamAttempts` 仅凭 attempt_id 判重跳过 → `exam_plan_courses` 从未回填 → `computeExamRate` 分母 0 → rate 恒 0。修复：幂等判据改为「attempt_id 匹配且明细已有行」+ computeExamRate 无明细时回退主库 per_question 求和 + 空明细告警；存量治愈脚本回填明细并重算流水（09-17 改 +10 良好、09-14/15 金额不变仅 rate 修正），回归测试 3 用例 | 高 | 2026-09-17 | [详情](ISSUES/ISSUE-112.md) |
| 113 | 孩子会话重进后左侧资料列表清空（对话还在、资料没了）——display_content 只推不存（SSE fire-and-forget，无登记）+ `pi:start_child` 硬编码返回 `materials:[]`（ipc-handlers.ts:1335「联调点」历史已由 ISSUE-100 接上、资料至今没人接）；客户端回填逻辑健在恒拿空数组。方案 A：display_tool 推送后持久化 `{path,title,source,ts}` 登记（/reset 清空，与 materials:[] 语义对齐）+ `/open` 一并返回 + 薄桥回填；备选 B 扫会话 toolCall 重建（否决：耦合 jsonl 结构、跨天语义模糊） | 中 | 2026-09-18 | [详情](ISSUES/ISSUE-113.md) |
| 114 | 错题/生字跟踪：把孩子的「漏洞信号」（对话口述错题、不认识的字）结构化沉淀为可复习的错题本——需求分析盘点四类信号源（对话口述流失/查词浮层不留痕/考核 wrong_questions 无闭环/口语评测二期）；方案：孩子 kb 新表 `mistake_book`（kind/status/count 去重）+ 三采集渠道（agent 新工具 `child_mistake_log` + 查词浮层自动上报 + 考核错题同步）+ 孩子端 icon 弹框/家长端 widget + 复习闭环（教学 prompt 注入 open 错题、验证后标 mastered）；明确不做 LLM 全文扫描自动判错。**设计问答已定（2026-09-18）：知识点可选关联（逻辑引用+名称快照，按知识点聚合薄弱视图）；不进题库（孩子 kb 私有数据 ≠ 家长共享内容库，撞 ISSUE-105 边界；错题经 question_id 引用原题做重做，统计可反向供出题参考）；C1 调用时机已定（只认明确漏洞信号：口述错题/对话问字词/稳定薄弱点，反面清单防滥用，先教学后静默记录）** | 中 | 2026-09-18 | [详情](ISSUES/ISSUE-114.md) |
| 115 | ✅ 已实施（2026-09-19）：考核当天重考——`exam_plans` 加 `retake` 字段（幂等迁移，''=不重考，值为重考标准自然语言）；提交路由置 done 后同步钩子（`exam-retake.ts`）：LLM（复用考核会话）按标准+评分摘要生成重考计划 JSON → schema+课程/知识点校验 → 错误反馈重试环（3 轮/100s 预算）→ 按现有口径创建当天计划（origin=retake、确定性 id 幂等）；服务端强制 retake=''（防连环）、count_in_rate 按设置 `exam_retake:<parentId>` 默认不计入（fixed-config 路由已带字段）、失败不丢分仅告警；agent 工具/创建路由加 retake 参数，客户端提交超时 120s+报告页重考提示条；测试 14 用例。待定已落：fixed 首批不做录入入口（custom 先行）。遗留：面板设置开关控件 | 中 | 2026-09-18 | [详情](ISSUES/ISSUE-115.md) |
| 116 | ✅ 已实施（2026-09-19）：定时任务新增「自定义任务」——`scheduler_tasks` 加 type='custom' + `instruction` 列（幂等迁移，owner 恒 parent）；worker tick（每 2 分钟）触发判定沿 last_fired_at 幂等（daily/weekly 到点当日首次命中即跑、once/interval 原生），触发占位后**异步**逐孩子跑独立无头 ephemeral 会话（白名单 get_date/kb 读写 + **weather_query**[Open-Meteo 免 key 7 天预报] + **create_reminders**[source 标记滚动替换+精确去重]）+ 5 分钟看门狗 → 摘要写 task_runs；关键语义：「未来 N 天各播一次」引导建 N 条 once（daily 会每天全量重复播）；面板 + `parent_scheduler_task_create` 工具入口；测试 13 用例。四个待拍板全部落地（白名单/Open-Meteo/5min/source 标记） | 中 | 2026-09-19 | [详情](ISSUES/ISSUE-116.md) |
| 117 | agent 工具并发调用——**框架已支持并行**（SDK `executeToolCalls` 默认 `executeToolCallsParallel`，`toolExecution ?? "parallel"`，服务端未覆盖、无工具声明 sequential——已核实到 bundle 源码级）；`parent_build_material` 每调用独立编程会话（key=parentId:path）不同 path 天然并发安全。**实际串行根因=模型一轮只发一个调用**。方案：①新增批量工具 `parent_build_material_batch`（Promise.all 框架强制并发+上限 3+逐份成败汇总，绕开模型习惯，推荐）②prompt/工具描述鼓励同消息多调用（辅助）。注意 rate limit/成本放大、同 path 仍串行复用会话 | 中 | 2026-09-19 | [详情](ISSUES/ISSUE-117.md) |
| 118 | 调查：家长 agent 穿管 materials 时创建的 HTML 落到哪——**三处落点**：①资料真源 `<dataDir>/materials/<parentId>/<topic>/…`（parent_put_material/parent_build_material，正规主路径）；②孩子工作区 `workspaces/<parentId>/<childId>/outputs/…`；③~~家长会话工作区（不可穿管）~~ **P-a ✅ 已修复（2026-09-19）**：根因=parent_build_material 对非 `materials/` 前缀路径静默落家长工作区，且前缀语法与同族工具（parent_put_material 用根相对路径）不一致——已重构 `resolveLessonOutputPath`：家长侧恒落真源+根相对路径语法（兼容旧前缀）+topic 校验，测试 7 用例。穿管=display_content 读正文内联推 SSE + 登记 display_contents 表（无文件副本）。遗留：P-b 落点边界文档化；P-c 测试家长 76 目录污染 | 低-中 | 2026-09-19 | [详情](ISSUES/ISSUE-118.md) |
| 119 | 背诵题打分链路梳理：**纯发音评测引擎分线性映射，不经 LLM**——题库直出（refText=原文/recitePass 通过线默认 90/pointMax 默认 10）→ 多段录音合并 WAV → 服务端评测（**实际用阿里声希 SSECP**：中文背诵走 cn.pred.score 长文本免拆段，81=声希 overall 合成分；腾讯 SOE=SuggestedScore 为代码兜底）→ toSpeechAssessment（pron=score）→ 客户端 `pointGot=round(total/100×pointMax)`、`correct=total≥pass`。**引擎分本身是黑盒**（声希内部对准确/完整/流利加权合成，权重不公开，我方仅可控 precision=1.0）。**三个注意点**：①`overall??pron` 双字段残留（映射从不设 overall，误导）②得分与通过两条线（9 分但 correct=false 可能，影响错题本/重考口径）③评测失败软失败记 0 分无区分 | 低 | 2026-09-19 | [详情](ISSUES/ISSUE-119.md) |
| 120 | 家长/孩子 agent 共用「知识库」：孩子聊天问历史/自然现象等事实问题时 agent 检索高相关可信知识再答（家长供料圈定内容边界，不联网）；家长提供视频/网页/PDF 自动摄取为可检索知识。方案：`knowledge_docs`（状态机 pending→ingested）+`knowledge_chunks`（分块+向量 BLOB），**向量复用 ISSUE-111 已落地的 embeddings 基建**（首个纯语义消费方）；摄取管线 PDF 抽文本/网页正文提取/**视频 ffmpeg 抽音轨+ASR 转写**（两者均已有能力）；孩子 agent 只读 `knowledge_search`（prompt 教触发时机）+ 家长 agent 管理 tools；二期 LLM 清洗结构化条目/混合检索。待拍板：存放位置（knowledge.sqlite vs parent.sqlite 表）/ASR 通道/分块参数。**检索已调研 Obsidian（2026-09-21）：主路线（结构分块+本地向量+余弦）与 Smart Connections 同构已验证；吸收①结构感知分块替代纯定长 ②混合检索（FTS5 BM25+向量）维持二期但融合排序单列验收（Copilot #1799 教训）③链接图一跳扩展（反链思想，二期，chunks 预留 entities 字段）** | 中 | 2026-09-21 | [详情](ISSUES/ISSUE-120.md) |
| 121 | ✅ 已解决（2026-09-21 拍板 B+命名）：自定义考核取名 + 同日多场——`parent_exam_plan_create` 加 `name` 参数、INSERT 落库 title（不再硬编码「自定义考核」）；两处守卫（agent 工具 + `POST /exam/schedules`，后者收 `body.name`/`scope.name`）去重收窄为**同日同名**（对齐孩子自请语义），不同名未考计划同天并存；孩子端 todayOpen 列表渲染无单条假设、computeExamRate 多条 done 同天合并求和均不受影响。**附带发现**：面板 ExamAdminPanel 新建/编辑表单已是死代码（无 JSX 引用、scope 格式残留 ISSUE-104 前），面板创建入口实际不存在，考核创建只剩 agent 对话一路——恢复 UI 需按 courses 口径重做（新 issue 候选）。测试 4 用例 | 中 | 2026-09-21 | [详情](ISSUES/ISSUE-121.md) |
| 122 | ✅ 已修复（2026-09-21）：`parent_db_write` 的 update 恒报「列 0 未登记」（schema 强制 rows 数组、执行器期望对象的自相矛盾，update 语义整体不可用）——修复三件套：①schema 改 `Type.Union([行数组, 列值对象])`（parent_db_write/child_db_write/Tier2WriteRequest 同批）②执行器双向兼容：新增 `normalizeWriteRows`，update 数组取首元素（多元素拒绝提示按 where 逐条）、insert 对象视为单行，`executeWrite` 与 `tier2Write` 全改走归一 ③`digitColHint`：纯数字列名报错附形状自愈提示；连带修正 parent-tools 重嵌入对单行对象 rows 的取主键。测试 8 用例。**未上 201**（当日 0.5.0b 部署在先，随下次发版） | 高 | 2026-09-21 | [详情](ISSUES/ISSUE-122.md) |

## 记录格式（模板）

- **类型**：bug / 需求 / 架构 / UI / 其他
- **描述**：
- **影响范围**：
- **排查/修改入口**：
- **优先级**：待定 / 高 / 中 / 低
- **记录时间**：YYYY-MM-DD

## [ISSUE-061] 场景化角色扮演学习：网页模拟真实场景，孩子在场景中扮演角色，用语音与场景内多个 agent 角色互动（v1 样例已实现并实测，持续迭代）
- **状态（9/7 晚）**：设计 → 落地 P1 样例（客厅 Hello 场景 + scene_command 全链路）→ 两轮交互优化（无结束横幅 / 自由对话优先 / 复杂动作与物品互动 / 孩子主导不评价不主动记录）→ 场景 HTML 标准规范文档。待：语音球接真 ASR、多角色音色、模板化制作链。各主题 method 是当前该课的 agent 行为权威源（改了 method 即时生效）。
- **需求（用户 9/7 原话）**：用网页模拟真实场景，让孩子在场景中扮演角色，通过语音与场景中的 agent 进行互动交流；场景里可以有多个 agent 扮演不同角色；目的是让孩子用学习的知识解决问题。
- **定性**：这不是 ISSUE-060 的「资料通讯协议」增强，而是新的产品形态——**场景角色扮演引擎**（scenario role-play）。学习资料=可阅读/可操作的内容；场景=可对话的世界。ISSUE-060 的 action 词表/协议语义被本场景吸收复用。
- **核心架构判断（讨论结论）**：
  1. **多角色 ≠ 多 agent 会话（游戏主持人模式）**：一个场景会话=一个「游戏主持人」agent，system prompt 携带完整剧本（characters[]/场景设定/任务链/知识目标/胜负条件），逐轮扮演所有 NPC。优点：世界状态天然一致、1 次 LLM 调用/轮、孩子上下文复用现有孩子会话机制。仅当角色需真正独立记忆时才拆多会话（不建议 v1）。
  2. **语音回环不进页面，页面只是「舞台」**：mic/ASR（腾讯，已有按住说话）、TTS（edge-tts 多音色，按角色分配 voice）、agent 会话全在 app 壳/主进程；页面只负责演出——接收下行指令高亮说话角色、放字幕、变场景、展示任务进度。孩子点场景物件 → 上行事件。这是低频消息，**iframe 现有架构扛得住**，无 iframe（WebContentsView 上课模式）是更沉浸的长期形态但非 v1 阻塞项。
  3. **agent→场景下行用 custom tools（关键设计）**：注册场景专用 custom tools `scene_say({character, line, emotion})` / `scene_update({...})` / `scene_end({result})`（复用 Pi customTools 机制，参考 kb 三件套写法；name 须进 createAgentSession tools 白名单）。agent 每轮调工具驱动舞台 → 主进程按角色音色 TTS → 下发页面演出。比解析 LLM 自由文本 JSON 稳得多。
  4. **剧本=结构化契约**：`scenario.json`（characters[{id,name,voice,persona}], scene, quests[], knowledge_goals, opening, win_condition）+ 舞台 HTML（agent 生成，监听 scene:* 下行、发 child-action 上行）。制作链：家长 agent 对话出需求（含本课知识目标）→ 编程 agent 生成剧本+舞台 → 落 materials。编程 agent prompt 加「场景模板配方」。
  5. **回合制推/按住说话起步**：barge-in（打断）难，v1 按住说话+播报期间禁麦；字幕常显（孩子识字练习本身是学习目标）。SSECP 语音评测（DESIGN-ssecp）后续可挂进场景完成条件（如「正确朗读店名」）。
  6. **学习记录**：场景完成经现有 daily/child_kb 机制落库；场景会话本身上云供家长回看（现有机制）。
- **v1 分期建议**：P1 场景会话+游戏主持 prompt+scene_say/scene_update 工具+TTS 多音色+字幕（iframe 舞台可先静态图+角色立绘）；P2 编程 agent 生成剧本+舞台模板化；P3 任务链/胜负/多场景；P4 接 SSECP 口语评测+学习记录结构化。
- **开放问题**：场景由家长 agent 现场生成还是模板库挑选？学科范围（语文对话场景优先?）；角色数量上限（3~4 个 token/注意力合适）；舞台美术由编程 agent 生成的质量下限。
- **记录时间**：2026-09-07（讨论，未开工）

### 阶段小结（2026-09-07 晚，P1 样例端到端跑通后）
**已实现**（代码 + 数据均已落，见今日日志）：①「场景英语」主题与第1课（家长库 + 孩子 kb 双库）+ 客厅场景资料 HTML（materials 真源 + 索引）；②`scene_command` custom tool（say/move/act/show/highlight/update，复用 page_action 下行链，零新增 IPC）+ 宿主 MaterialsPanel 白名单转发 + 场景页自身监听；③场景 HTML 动画/资产（开窗/跳舞/喝水/画掉落/地标移动/点物朗读）与「无结束」语义（删 banner/end）；④行为规范场景段 + 教学法 v2（孩子主导、不评价、卡住才提醒、不主动结束/记录）；⑤场景标准规范文档 `SCENARIO-HTML-SPEC.md` + 场景就绪清单注入（manifest→agent）。
**实测证据（珊珊 9/7 会话，07-29 文件）**：agent 全链路可跑（display_content→scene_command×51 驱动→孩子语音回应），但暴露三个问题，已在第 3 轮迭代修复：①每句都夸/给模板/「掌握度优秀」式评价与打分、设轮次挑战 → 改为自然接话不评价；②三次主线完成即 self-收场（Bye bye/Good night/明天见）共 ~8 次主动道别 → 改为只有孩子明确结束才道别；③自主 kb_insert×5/kb_update×3 记课程与 daily 并宣称「我帮你记下来」→ 改为只在孩子结束本课/要求记录时写。
**验证结论**：页面=舞台、agent=主持、自定义工具下行的架构成立；「多角色=一个会话逐轮扮演」成立（单 agent 扮演 Steve/Maggie 与孩子对话顺畅）；iframe 现有通道扛得住场景互动（低频消息）。
**遗留开放项**：①~~场景内语音球 mic-press/release 宿主未接~~ → **v2 已接**（见下）；②多角色差异化音色未做（manifest.voice 已预留，TTS 链路需按角色选 voice）；③场景 HTML 制作仍靠手工/编程 agent 一次性生成，无模板库与自动校验；④行为规范/教学法/HTML 动作表三处一致性靠人工，出错时 scene_command 会静默失败（动作表应集中在规范一处引用）。

### v2 迭代（2026-09-07 晚，用户三项调整：语音球真对话 / 预生成语音 / 台词提及自动高亮）
用户拍板：场景对话用**独立 scene 会话**专职扮演（课程会话挂起待命、接收转交总结）；场景回复**进聊天记录**；孩子语音存**独立 voice 目录**。已落地：
- **独立场景会话**（pi-session.ts）：key=`childId|scene|<courseKey>`、目录 `scene-<topic>-<title>`（jsonl=对话真源防丢）、`buildScenePrompt` 独立扮演规范（正文=台词会被朗读；**不知道课程获取/记录**；tools 白名单仅 scene_command；同日续接/跨天新窗）；disposeChildSession 一并清理。
- **IPC**（ipc-handlers/preload）：`scene:prompt`（回复走独立 `scene:reply/end/error` 事件，防与课程会话 pi:reply 混淆；纯工具轮静默不发「没回复」）、`scene:stop`、`scene:transfer`（读 scene jsonl → 转交文本注入课程会话收尾总结，`buildSceneSummaryForCourse`）、`voice:scene_save`（→ `data/children/<id>/voice/scene/<日期>/`，供挑选评测）。
- **渲染**（MaterialsPanel/Learn）：场景语音球 `scene:mic-press/release` → 宿主 useAudioRecorder 录音 → ASR → Learn 发 `scenePrompt`（录音落 voice/scene 并随 prompt 附【附件音频】标记）；`scene:ready` → Learn 场景模式（横条「🎭 场景对话中 / 结束场景对话✕」）；场景模式下聊天键盘输入同样路由 scenePrompt；「结束场景」= `sceneTransfer`+`sceneStop` 回课程会话。
- **预生成语音**（voice/tts.ts）：synthesize 加**磁盘持久缓存** `data/tts-cache/<hash>.mp3`（内存 LRU→磁盘→在线三级）；`prewarmTexts()` 批量预热（并发3，失败静默）；scene:prompt 首轮后台预热 34 条高频台词/单词。
- **台词自动高亮**（HTML）：`Scene.say` 内 `mentionScan` 自动扫台词中的物品 id/英文/中文并高亮（无需 agent 记得发 highlight）。
- tsc/build 通过。**遗留**：scene abort 未接独立通道；场景语音气泡回放 v1 不做；voice/scene 挑选分析待接 ssecp 发音评测；scene 会话仍默认模型（可给 fast 档）；多角色 voice 参数待做。

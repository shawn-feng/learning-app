## [ISSUE-019] 家长端按孩子设置课程时间段，上课/下课在 app 顶部 1/3 区域提醒（铃声 + 语音播报）

- **类型**：需求 / 新功能（家长端配置 + 孩子端提醒）
- **描述**：在**家长界面为每个孩子单独设置课程时间段**（上课时间、下课时间，可多段/课表式）。到了上课/下课时间点，在孩子 app 界面**上方三分之一区域**弹出醒目提示（上课/下课），并**伴随铃声或语音播报**（如「上课时间到了，请开始学习」/「下课啦，休息一下」）。
- **现状 / 排查入口（已查证）**：
  - **按孩子配时间的现成骨架**：`electron/lib/scheduler.ts` 的 `DEFAULT_CHILD_CONFIG` 已有 `recording: { enabled, times[], onNewSession }`，配置经 `scheduler:config:get/set`（`preload.ts:200`）按 childId 存取，UI 在 `src/components/SchedulerSettings.tsx`（逐孩子卡片、时间用 `<input type="time">`、可增删多时间点）——**课程时间段配置 UI 与存储可完全照搬这套「按 childId + 多时间点」结构**，无需新造数据层。
  - **每分钟触发定时器已存在**：`scheduler.ts` 内已有 per-minute tick（`cc.recording.times.includes(nowMin)`，`scheduler.ts:345/442`），在 tick 里比对当前时间与各孩子配置即可触发——课程提醒可**复用同一计时循环**，新增 `classTimes` 比对 + 起止跳变检测（同一分钟只触发一次，用 lastFired 防重）。
  - **语音播报链路已通**：`electron/lib/ipc-handlers.ts:1425` `ipcMain.handle("voice:tts", … synthesize(text, opts))` 返回 mp3 base64（edge-tts 默认，经 `tts-config.ts` 可切 qwen/mimo）；渲染端 `MaterialsPanel.tsx:104 speakMaterialText` 已演示「调 `voiceTts` → `new Audio(mp3)` 播放」。故**语音播报直接复用 `voice:tts` 即可，与资料/聊天同音色**。
  - **铃声素材当前缺失**：全局搜 `mp3/wav/bell/ding` 无现成铃声资源；`media-protocol.ts`/`config.ts` 支持 mp3/wav 但无内置铃声文件。**需捆绑一个短促铃声 mp3/wav 到 app 资源目录**（如 `resources/bell.mp3`），提醒时播放。
  - **顶部提示现有机制偏弱**：仅有聊天区小条 `chat-notice`（`styles.css:2316` + `ChatWindow.tsx:805`，只在聊天顶部一小条）；需求是「**页面上面三分之一**」的全屏固定横幅——需新增 **app 级 overlay**（`position: fixed; top:0; height:33vh; z-index 高`），覆盖 Learn 各子视图，不依赖当前在哪一页。
- **改造方向**：
  ① **数据模型**：`scheduler.ts` `ChildSchedulerConfig` 增 `classTimes: { start: string; end: string; label?: string }[]`（每孩子多段）；`SchedulerSettings.tsx` 增「课程时间段」section（`<input type="time">` 起始/结束 + 增删，复用现有卡片/Plus/Trash2 模式）；存储走现有 `scheduler:config:set` 按 childId。
  ② **触发（复用计时）**：在现有 per-minute tick 中，对每个孩子遍历 `classTimes`，检测「当前分钟 ∈ [start, start) 跳变」=上课、「∈ [end, end) 跳变」=下课，用 `lastReminder` 标记防同分钟重触发；到点后 `webContents.send("class:reminder", { childId, type: "start"|"end", label })`（需在主进程持 webContents，沿用 recording 已有的定时任务执行上下文）。
  ③ **铃声 + 语音**：主进程/渲染端收到 `class:reminder` 后——a) 播放捆绑铃声 mp3（`<audio>` 或主进程读资源 buffer 播放）；b) **可选语音播报**：调 `voice:tts`（或渲染端 `voiceTts`）合成提示语并播放，音色与资料/聊天一致；两种可并存，也允许家长设置「仅铃声 / 仅语音 / 两者」。
  ④ **顶部 1/3 横幅（app 级 overlay）**：建议在 `Learn.tsx` 顶层（甚至 `App`/`Home` 层，确保任意子页可见）加一个固定定位的横幅组件，收到 `class:reminder` 时显示 33vh 高、醒目配色、上课/下课图标与文案，数秒后淡出或手动关闭；**注意多孩子场景**：横幅 childId 需与当前登录孩子匹配才显示（或家长端不显示、仅孩子端）。
  ⑤ **边界**：app 未打开/孩子未登录时不弹（静默）；跨天/配置变更后 tick 自动生效；铃声文件需随安装包分发（打包进 `extraResources`/asar 外）。
- **优先级**：已完成（2026-08-31 实施：`scheduler.ts` ChildSchedulerConfig 增 `classTimes[]`（start/end/label，可多段）+ `classAlertMode`（both/chime/voice）；`SchedulerSettings.tsx` 每孩子卡片加「课程时间段」section（起止 time + 课程名 + 增删 + 提醒方式 radio）；per-minute tick 检测起止跳变（`cs["class-reminder"].lastKey` 含日期防同日同点重触发）→ `webContents.send("class:reminder")` 广播（透传 mode）；`preload.ts` 加 `onClassReminder`；`Learn.tsx` 顶部 33vh 固定横幅（渐变+大图标，8s 自动消失/点击关闭，childId 匹配当前孩子才显示）+ 铃声（Web Audio 合成叮咚，零资源文件依赖）+ 语音播报（`voiceTts` edge-tts 与聊天同音色，按 mode 播报）；scheduler-task-state 测试更新 4 键。全量 288 例 0 失败、tsc 0 业务错误、build 通过）
- **⚠️ 查看入口（2026-08-31 用户实测「没看到」）**：区块在**家长端「设置 → 定时任务」→ 每个孩子卡片内**（⏰ 课程时间段，含空态提示「尚未设置课程时间段，点下方按钮添加」）。**主进程改动（scheduler.ts/preload.ts）必须完全退出 app 重启才生效**（dev 模式主进程不热更新）；渲染产物已确认包含新 UI 字符串。已补 archive-limit.test.ts 两例 classTimes 读写/兜底测试。
- **⚠️ 横幅交互调整（2026-08-31 用户要求）**：提醒横幅**不自动消失**——一直显示到孩子**点击**才关闭（删 8s 自动消失 effect）；横幅底部加「👆 点击关闭提示」闪烁文字（class-reminder-dismiss，blink 动画）。
- **⚠️ 二轮调整（2026-08-31 用户要求）**：① **铃声/语音也循环重复播报**——横幅常驻期间每 15s 重播一次直到点击关闭（`playReminderAlert` 统一首次+循环；`speakReminder` 加 `reminderSpeaking` 锁防上一轮未播完时重叠；interval effect cleanup 关闭即停）；② **孩子左侧边栏新增「今日课程」区块**（`SidebarClassSchedule` 独立组件：实时时钟 HH:mm:ss 每秒刷新只重渲染自身 + 当天课程时间段列表，经 `schedulerConfigGet` 取当前孩子 classTimes；折叠态显示 CalendarClock 图标按钮）。
- **记录时间**：2026-08-31

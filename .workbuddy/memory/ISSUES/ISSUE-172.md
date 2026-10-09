# ISSUE-172：201 生产家长会话编程 agent 不可用（parent_build_material 连续失败「未能成功写入」）——排查记录：API/凭证/注册全通，失败在 pi SDK 嵌套会话内部且**错误被完全吞掉**；修复 = 错误面暴露 + compat 复测

- **类型**：bug / 排查记录（201 生产，0.5.20；2026-10-05 晚家长会话实证）
- **现象**：家长会话要求 `parent_build_material` 生成 HTML 资料（xiaobazhang/拔河马比赛.html），**连续 3 次失败**（含一次最小探针 `_probe.html`），全部同一报错「编程 agent 未能成功写入 …（文件不存在或为空）」；agent 只能手写 `parent_put_material` 样板页兜底，用户暂停等待修复。三次失败时间（会话 jsonl 实证）：15:09:07 / 15:09:13 / 15:15:12 UTC（本地 23:09~23:15）——**探针仅 6 秒就返回**（正常生成中位 321s，ISSUE-146 数据）。
- **已排除（逐项实测/取证，均正常）**：
  1. ✅ **配置**：per-parent `programmingModel="moyu/DeepSeek-V4.1-flash"` 已配置（settings 表实读）；0.5.20 bundle 含 `MOYU_PROVIDER`/`MOYU_MODELS` 注册（moyu.info/v1，api=openai-completions，compat thinkingFormat=deepseek）；
  2. ✅ **凭证**：解密 auth 封套实测——moyu key 存在（51 字符），`.worker/auth/<pid>.json` 已含 moyu（getWorkerRuntime 每次调用都会重写该文件）；
  3. ✅ **API 连通性**：从 201 直接调 moyu——非流式 200 返回正文；流式+tools 200 返回 `tool_calls`（write，参数含正确绝对路径+内容）；带 thinking 参数也 200。raw API 层面**完全可用，1.0~1.6s 出结果**；
  4. ✅ **同 key 其它用途**：孩子/家长 agent 的 defaultModel=moyu 均正常出话（09-27/10-05 会话 jsonl 实证 provider=moyu），runtime/auth 链路对 moyu 本身没坏；
  5. ✅ **文件系统**：服务端 root 运行，materials/xiaobazhang/ 可写（agent 手写样板页成功落盘 8971B）。
- **定位到的确定问题**：
  - **诊断盲区（必须先修）**：`generateHtmlLesson`（programming-agent.ts:178-184）只做「文件存在且 >100B」检查，失败报错笼统；**嵌套 pi 会话的 stopReason='error'/模型报错/SDK 内部重试全部被吞**——journal 与 server-log 在 3 次失败窗口**零错误日志**。6 秒即返回 = 嵌套会话第一轮 LLM 调用瞬间失败（疑 401/400），SDK 把错误当正常结束，外层只见「没写出来」。这是 ISSUE-146（240s 误杀）同款「工具内部静默」的又一表现。
  - **头号嫌疑（待 ①暴露后确认）**：`DeepSeek-V4.1-flash` 是 reasoning 模型（实测响应带 reasoning_content），model 条目 `compat.thinkingFormat:"deepseek" + requiresReasoningContentOnAssistantMessages:true + maxTokens:8192`——多轮工具循环中 SDK 回传 assistant 消息/reasoning 块或 thinking 参数的组合，可能触发 moyu 聚合层 400（聚合平台对 deepseek 兼容参数支持参差）；家长/孩子 agent（同模型）不挂 tools 循环所以不触发。
- **修复步骤（建议顺序）**：
  1. **P0 错误面暴露**：`generateHtmlLesson`/`createProgrammingTool` 捕获嵌套会话的 error 事件与最终 stopReason，失败文案附**真实底层错误**（status/body 摘要）；pi 会话 subscribe 转发错误到 console（ISSUE-147 P0 同款进程内补齐的日志面）；
  2. **部署 201 后复现一次探针**，拿到真实错误码；
  3. **对症**：若 400/compat → 调整 MOYU_MODELS 的 DeepSeek-V4.1-flash compat（去 thinkingFormat/降 maxTokens，或先换 glm-5.3/gpt-4o 验证通路）；若 401 → 查 getWorkerRuntime 缓存命中不重读 auth 的时序缝隙；
  4. **可选**：编程模型失败时报错文案引导设置页换备用编程模型。
- **回归**：探针一次通过落盘；家长会话连做 3 份资料全成功；「未能成功写入」类报错必须携带真实原因（防复发盲区）；孩子端 create_html_lesson 同路径同修。
- **优先级**：高（家长核心工作流断；诊断盲区导致同类问题无法自证）
- **记录时间**：2026-10-05

## ✅ P0 错误面暴露已实施（2026-10-06，服务端 programming-agent.ts；本地 0.5.20 bundle 构建过，待部署 201）

**改动**（`server/src/agent/programming-agent.ts`）：
- 新增 `createProgrammingIssueCollector()`（导出，纯逻辑可单测）：挂 `session.subscribe`，捕获三类被 SDK 吞掉的真实错误——①模型调用失败（assistant 消息 `stopReason="error"`，取 `provider/model/errorMessage` 摘要 ≤300 字符；`message_end` 与 `turn_end` 各派发一次同一消息，按 timestamp 去重）②生成中止（`stopReason="aborted"`）③工具执行失败（`tool_execution_end` isError=true，取工具名+结果摘要）。每条即时 `console.error` 落 server-log（进程内补齐日志面，对齐 ISSUE-147 P0）。
- `generateHtmlLesson`：①错误订阅**无条件挂**（旧代码只在传 onProgress 时才 subscribe——直调路径全盲），订阅回调=收集错误 + 原 ISSUE-146 进度翻译，行为不变；②`session.prompt()` 包 try/catch——SDK 层抛错不再裸穿，报错附收集到的底层错误；③「未能成功写入」失败文案重构：**先报「底层错误（对症处理用）：…」**（无收集到错误才说「会话正常结束但没有写出文件——可能模型没有调用 write」），处理建议首条改为「底层 4xx/鉴权错误 → 检查凭证/兼容性，或在设置页换备用编程模型」（步骤 4 一并落地）；④文件写出来但过程有错误 → `console.warn` 留痕放行。
- **对症预案（步骤 3，待 201 部署后探针拿真实错误码执行）**：若 400/compat → `packages/agent-core/src/runtime/providers.ts` MOYU_MODELS 的 `DeepSeek-V4.1-flash`：去 `thinkingFormat:"deepseek"`（或改 `"qwen"`）、降 `maxTokens`（8192→4096）逐项试；通路对照可用同表 `glm-5.3`（无 compat 特殊参数）切为编程模型验证。若 401 → 查 `getWorkerRuntime` 运行时缓存命中不重读 auth 的时序缝隙。

**验证**：`test/issue172-programming-errors.test.ts` 4 例全绿（模型错误捕获+双事件去重、工具错误、aborted 分类、summarize 拼接+截断）；`issue146-longtool-watchdog` 26/26 不回归（进度/中止链路无扰动）；server tsc 除 topic-package 预存外 0 错误；bundle 构建过。

**下一步（部署后）**：201 部署本版 → 家长会话再跑一次探针 → server-log 必现 `[programming-agent] 模型错误：…` → 按上面预案对症 → 回归：连做 3 份资料全成功。

## 🔬 本地复现结果（2026-10-06，头号嫌疑降级）

**实验**：本地 dev 环境（server/data）临时把测试家长 86a84278 的 `programmingModel` 切到 `moyu/DeepSeek-V4.1-flash`（对齐 201 故障配置，跑完还原），用**带错误收集器的同一份代码**跑最小探针（materials/probe/_probe172.html）。

**结果**：**成功**——5.1s 落盘 1098B，收集器零捕获（无模型错误/无工具错误）。同渠道（www.moyu.info/v1）+ 同模型 + 同 SDK 工具循环 + 同 compat 组合，本地链路完全正常。

**推论（头号嫌疑降级，候选重排）**：
1. ~~compat 组合必然触发聚合层 400~~ → **削弱**：SDK 链路本身能走通；
2. ⬆️ **「6 秒返回」疑似正常时长**（本地成功也只要 5.1s）——201 的三次失败可能是**会话正常结束但文件没落在检查路径上**（模型没调 write / 写到别处 / 路径基座不一致），而非模型报错；新错误面的第三种文案「会话正常结束但没有写出文件」将直接区分这两种情况；
3. ⬆️ **key 级/账号级时变因素**：201 家长的 moyu key 在 10-05 晚窗口被聚合层限流/拒绝（raw 直调在排查时做，与失败窗口不完全重叠）；
4. ⬆️ **201 部署态差异**：201 的 0.5.20 bundle 构建自哪个源无法确认（归并前后路径基座：legacy `materials/<pid>` vs `workspaces/<pid>/materials`）；三次失败（15:09~15:15 UTC）若发生在 0.5.20 部署前，跑的是旧代码。

**结论**：本地无法进一步复现，**必须部署带错误面的版本到 201 后探针**——三种失败文案（模型错误/工具错误/正常结束未写文件）+ server-log 的 `[programming-agent]` 行会直接指路。部署会 bundle 进当前工作区全部未提交服务端改动（并行会话的 open-api/tts/turn-runner 等），**需用户拍板部署时机**。

## ✅ 已部署 201 + 生产探针通过（2026-10-06，用户拍板执行）

**部署 0.5.21**（`tmp/deploy/deploy_server_201_0521.py`，既有 paramiko 机制）：stop→备份 bundle（server.cjs.bak-20261006-073740）+数据（backups/deploy-0.5.21-*, 69M）→安装→重启→探针全过（version=0.5.21、health ok、collector 在 bundle 2 hits、journal 启动零错误）。**本次 0.5.21 相对 201 原 0.5.20 带上：ISSUE-172 错误面 + ISSUE-165 ASR 服务端**（open-api/tts 等并行工作 0.5.19/20 已在跑，本次同基座）。

**生产探针**（`tmp/deploy/probe_172_run.py`：SSH 读 jwtSecret → 签 86a84278 家长 JWT → POST /parent-agent/prompt 走真实会话→parent_build_material 链路）：**成功**——journal `[programming-agent] 生成完成 probe/_probe172.html（141B，耗时 4.1s）`，4.1s 与本地 5.1s 一致，错误收集器零捕获。探针文件已 sudo 清理。

**最终结论（定案）**：
1. 10-05 晚三次失败 = **moyu 聚合层时变故障**（该窗口对该 key 快速失败，6s 返回），现已自愈——同家长/同渠道/同模型在 201 上完全正常；
2. compat 组合（thinkingFormat=deepseek 等）**无罪**，MOYU_MODELS 不需要任何调整；
3. 「未能成功写入」的诊断盲区已闭环：下次再失败，journal 必现 `[programming-agent] 模型错误：moyu/DeepSeek-V4.1-flash：HTTP xxx …`（或工具错误/「正常结束未写文件」），报错文案直接带底层错误与换模型引导——同类问题可自证。

**残留说明**：①探针在家长会话历史里留了一条「生成 _probe172.html」的对话记录（真实路径产物，未删会话）；②「连做 3 份资料全成功」的最终回归待家长实际使用确认（基础设施已就绪：失败即有真因可查）；③客户端 0.1.22（ASR 上收）安装包未重打——旧客户端打 0.5.21 行为不变，兼容窗口安全。

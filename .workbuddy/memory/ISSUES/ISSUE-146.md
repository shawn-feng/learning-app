# [ISSUE-146] 服务端 240s「挂死看门狗」误杀长时工具轮：制作网页（编程 agent）被砍在中途，家长看到的是「模型无响应」

- **类型**：bug（服务端超时判据口径错误：把「工具在跑」当成「模型挂死」）
- **优先级**：**高**（生产已发生 5~6 次，且报错文案把责任推给"模型服务"，会误导用户去查错方向；同时用户正在要求「新增 45s 看门狗」——必须先把两者的责任边界说清）
- **状态**：✅ **P0-a + P0-b 已实施并部署 201（0.5.10，2026-09-24 15:53；启动探针与 marker 复核通过，真实长工具轮未复跑）** —— 见 §四「实施记录」；P1 未做
- **记录时间**：2026-09-24
- **标签**：`240s看门狗` `长时工具` `编程agent` `制作网页` `嵌套会话` `误杀` `agent-stream` `归因错误`
- **关联**：**ISSUE-147**（「用工具调子 agent」范式评估——给出本 issue 的**最终修法**：进程内补齐 `subscribe`/`onUpdate`/`abort` 传播/定义外置四机制）、ISSUE-145（客户端侧 45s 看门狗；两者是**不同层、不同判据**，不要混为一谈）、ISSUE-131（工作区归并）、ISSUE-126（模型失败不 publish error）

---

## 一、缘起（用户提问）

> 「新增 45s 看门狗。如果调用的工具是长时任务，会怎么处理？例如制作网页的工具。」

结论先行：**45s 客户端看门狗不会误伤长工具**（判据是"流上有没有字节"，而服务端心跳与 agent 忙不忙无关）；
**真正在误杀长工具的是服务端那条 240s「会话静默」看门狗**，而且**生产上已经杀掉 5~6 轮**。

---

## 二、两条看门狗的分工（先厘清，别混）

| | 客户端 45s（ISSUE-145 新增） | 服务端 240s（2026-09-18 既有） |
|---|---|---|
| 位置 | `web/src/shim/core/sse.ts` `SSE_STALL_TIMEOUT_MS`；Electron 侧 `electron/lib/server-agent-client.ts` 同源 | `server/src/agent/parent-registry.ts:234` + `session-registry.ts:481` `SESSION_IDLE_TIMEOUT_MS` |
| 判据 | **距上次收到任何字节**（含 `: ping` 心跳注释行）> 45s | **距上次 agent 会话 emit 任何事件** > 240s |
| 触发后动作 | `abort()` 本条 fetch → 走既有重连（带 `lastEventId` 续传），**只是换订阅者** | `session.abort()` **中止当前这一轮**（真杀） |
| 测的是 | 「服务端→浏览器」这条流的存活 | 「agent 内部有没有在产出」 |
| 对长工具的影响 | **无**（心跳无条件每 15s 一发，与 agent 忙不忙无关 → 永不触发） | **会误杀**（工具执行期间外层无事件 → 240s 到点砍） |

**长工具为什么不会触发 45s 那条**（两重保证）：
1. **心跳与 agent 状态解耦**：`routes/parent-agent.ts:91` `const keepAlive = setInterval(() => reply.raw.write(": ping\n\n"), 15000)` 在**建连时就起表**，不依赖任何 agent 状态；孩子侧 `routes/agent.ts` 同款。工具跑 11 分钟，心跳照发 44 次。
2. **即使真触发也不会打断任务**：`parent-agent.ts:99-116` 的 `prompt` 路由是**提交即返回**（`submitParentPrompt` 内部 `void (async …)` 后台跑），SSE 只是订阅者；`req.raw.on("close", …)`（`:92-95`）只做 `clearInterval(keepAlive) + unsubscribe()`，**不 abort 会话**。⇒ 看门狗最坏只是让订阅重连一次，被订阅的那一轮毫发无损。

---

## 三、真正的缺口：240s 看门狗误杀长工具（生产已实证）

### 3.1 机制

「制作网页」的工具是 **`parent_build_material`（家长侧）/ `create_html_lesson`（孩子侧）**
（`server/src/agent/programming-agent.ts:260` 起），其 `execute` 内部**同步 `await` 一个完全独立的嵌套会话**：

```
programming-agent.ts:210  const session = await getProgrammingSession(...);   // 独立 AgentSession
programming-agent.ts:226  await session.prompt(prompt);                        // ← 阻塞几分钟
```

而该嵌套会话：
- **没有任何 `subscribe` / `agentStreamHub.publish`**（`programming-agent.ts` 全文 grep 为 0）⇒ **它的 text/thinking/tool 事件一个都不进事件中枢**；
- 父层会话在工具执行期间**只有 `tool_start` 一个事件**，之后一路静默到 `tool_end`；
- 全仓**没有任何工具用 `onUpdate` 回报进度**（`grep -rn onUpdate` 唯一命中是 `display-tool.ts:47` 的形参 `_onUpdate`，未使用）⇒ **SDK 的 `tool_execution_update` 事件在本项目从未产生过**。

⇒ 父层 240s 计时器（`parent-registry.ts:306-319`）在工具执行期间收不到任何 `markSessionActivity` 刷新，到点即：
```
console.error(`[parent-agent] 会话 … 超过 240s 无任何事件，判定挂死，中止本轮`)
agentStreamHub.publish(key, "error", { message: "模型服务超过 240 秒无响应，已自动中止本轮。请重试；多次出现请检查模型服务。" })
void entry.session.abort()
```

### 3.2 实测数据（201，只读 journal 取证）

**资料生成耗时**（`[programming-agent] 生成完成 … 耗时 Xs`，全历史 9 条）：

| 文件 | 耗时 |
|---|---|
| `outputs/test_page.html` | 28.0s |
| `outputs/练字小秒表.html` | 39.1s |
| `outputs/语文学习习惯·背诵卡.html` | 77.0s |
| `lianzhi/materials/lesson-01.html` | **242.8s** |
| `lianzhi/materials/lesson-04.html` | **360.0s** |
| `lianzhi/materials/lesson-02.html` | **371.7s** |
| `lianzhi/materials/lesson-05.html` | **468.3s** |
| `lianzhi/materials/lesson-03.html` | **654.2s** |
| `outputs/汉字常用笔画学习.html` | **321.4s** |

统计：`count=9  min=28.0  median=321.4  max=654.2`，**> 240s 的有 6 次（67%）**。
⇒ 这个工具**典型耗时就在 240s 阈值的 1~3 倍**，等于每次都可能被砍。

**时间线配对（决定性）**——`判定挂死` 与 `生成完成` 逐条成对，1:1：

| 判定挂死（外层被中止） | 生成完成（嵌套会话压根没被中止） |
|---|---|
| 2026-09-20 12:32:51 | 2026-09-20 12:32:52 ← **挂死后 1 秒**（lesson-01，242.8s） |
| 2026-09-20 13:03:34 | 2026-09-20 13:05:42（lesson-02，371.7s） |
| 2026-09-20 13:13:09 | 2026-09-20 13:20:00（lesson-03，654.2s） |
| 2026-09-20 13:26:30 | 2026-09-20 13:28:26（lesson-04，360.0s） |
| 2026-09-20 13:54:05 | 2026-09-20 13:57:49（lesson-05，468.3s） |

全历史 `判定挂死` 共 **8 次**（6 次家长 `:parent` + 2 次孩子 `:main`），其中 **5 次即上述配对**。
（⚠ 必须如实说明：另外 3 次没有配对的生成记录 —— 09-21 20:40 孩子 main、09-23 22:25 家长 parent 等，**很可能是这条看门狗本来要抓的"模型 API 真挂起"**。⇒ 这条看门狗**不能简单删掉**，只能把判据改准。）

### 3.3 后果（比"卡住"更糟）

1. **报错归因错误**：家长看到「**模型服务超过 240 秒无响应**，已自动中止本轮。请重试；多次出现请检查模型服务」——
   实际模型好好的，是**系统自己把长工具砍了**。用户会去查模型/额度（三个方向全错），而正确的动作只是「再等几分钟」。
2. **产物其实已经生成，但被当成失败**：lesson-01 那条，外层在 `12:32:51` 被 abort，嵌套会话 `12:32:52` 才跑完并写了文件
   （`生成完成` 日志在 `existsSync + size>=100` 校验之后）⇒ **文件落在资料真源里，但工具返回被丢弃**，
   家长以为没做成、可能重试一次 → 重复生成、白烧一次 4~11 分钟的钱与时间。
3. **父层轮被中止 = 上下文断**：家长的"做 5 课资料"这种一句话多轮任务，会被中途砍断，后续轮次拿不到已完成工具的结果。

---

## 四、修复方案与实施

### ✅ 实施记录（2026-09-24，P0-a + P0-b 均已落地并部署 0.5.10）

**新增** `server/src/agent/session-activity.ts` —— 共享活跃度登记处：
`markActivity` / `beginToolExecution` / `endToolExecution` / `runningToolCount` / `runningToolNames` /
`lastActivityAt` / `clearActivity` / `toolProgressText`，及两个常量
`SESSION_IDLE_TIMEOUT_MS = 240_000`（模型静默）与 `TOOL_EXEC_TIMEOUT_MS = 30 * 60_000`（工具硬上限）。

| # | 落地内容 | 文件 |
|---|---|---|
| 1 | **判据分流**：watchdog 先看 `runningToolCount > 0` → 走工具分支（30min 硬上限 + 文案「工具「X」执行超过 30 分钟仍未完成」）；否则才走原「模型服务超过 240 秒无响应」 | `parent-registry.ts` / `session-registry.ts` |
| 2 | `attachStream` 在 `tool_execution_start/end` 维护工具计数；新增 `tool_execution_update` → publish `tool_progress` | 同上 |
| 3 | 一轮 `finally` 里 `clearActivity(key)`；reset / dispose 同步清理（防计数泄漏 → 下一轮永不判挂死） | 同上 |
| 4 | **顺带修一个独立 key bug（孩子侧）**：`attachStream` 原来传 `streamKey(${pid}:${cid})`，而 watchdog 读 `keyOf(${pid}:${cid}:${kind})` ⇒ 活跃度永远刷不到，判据退化成「从提交起算的硬超时」，任何 >240s 的**正常**轮都会被砍。现拆成 `attachStream(entry, sessionKey, streamKey)` | `session-registry.ts` |
| 5 | 编程工具 execute 接 `signal`（→ 嵌套会话 `session.abort()`）与 `onUpdate`（→ `tool_execution_update`）；子会话事件翻译成可读文案 + **15s 心跳**（「生成中…（已 X 分钟）」）；节流 3s；`finally` 退订/清心跳（编程会话按 key 复用，不退订会累积订阅者） | `programming-agent.ts` |
| 6 | 客户端显示进度：两端 `translateAgentEvent` 加 `tool_progress` → `pi:tool_progress`；`onPiToolProgress` 暴露（web shim / preload / 本地 ipc 转发）；`ToolCallState.progress` → 工作气泡标签 + 工具卡片 | `web/src/shim/core/sse.ts`、`electron/lib/server-agent-client.ts`、`shim/domains/agents.ts`、`preload.ts`、`ipc-handlers.ts`、`ChatWindow.tsx`、`ParentChatPanel.tsx`、`Learn.tsx` |

**与本节原 P0-a 写法的差异**：原方案说在 `attachStream` 里维护计数（一致），但**不需要编程工具自报执行状态** ——
父会话的 `tool_execution_start/end` 本来就会到 `attachStream`，在那里计数更可靠且覆盖所有工具；
编程工具只承担**进度回报**与**中止传播**两件事。

**验收（本地）**：`server tsc --noEmit` **0 错**；`electron-vite build` **exit 0**（三包）、`npm --prefix web run build` **exit 0**、服务端 bundle 构建 **exit 0**；
新增守护测试 `test/issue146-longtool-watchdog.test.ts` **26/26**；改动相关 10 个测试文件 **150/150 全绿**；
全量 `vitest run` **8 files / 15 tests 失败 —— 与既有基线（ISSUE-142 §9.3：assess-guide / assessment / english-course-session / event-poll-config / kb-sqlite / page-bridge / sync / token-stats）逐项一致，零新增失败**；
服务端 bundle 启动烟测 `GET /api/v1/health` → `{"ok":true,"db":"ok"}`。
**防假绿**已做：注入 3 处旧逻辑（`if (false)` 屏蔽工具分支 / `attachStream` 退回两参数 / execute 去掉 signal+onUpdate）→ 对应用例 **3 条准确变红**，还原复绿。

**未做**：P1（回放 gap 检测）、ISSUE-147 的 P1（提示词外置）/P2（并行编排）/会话 LRU。

### 部署记录（0.5.10，2026-09-24 15:53，201）

| 项 | 值 |
|---|---|
| 版本 | `SERVER_VERSION` / `server/package.json` → **0.5.10**（两处同步）；`/api/v1/version` 实测返回 0.5.10 |
| bundle | 24,529,101 B，md5 `c0fc0527f279a20ea899a75044e20b95`（本地与 201 两端一致） |
| marker 复核（201 侧 grep 新 bundle） | `runningToolCount`=3 / `TOOL_EXEC_TIMEOUT_MS`=8 / `tool_progress`=3 / 旧 `判定挂死` 字面=0（文案改为按分支插值，原文案已不存在） / `resolveStoredFileAbs`=4（ISSUE-143 修复未回退） |
| 备份 | bundle `server.cjs.bak-20260924-1600`；数据 `data/backups/deploy-0.5.10-20260924-1600/`（server.sqlite + agents.sqlite 在线快照 + .secret/server-config.json/app-settings.json/license.json） |
| 探针 | `health → {ok:true,db:"ok"}`；journal `ERR_COUNT=0`；15:53:28 正常监听 `:8788` 并起 worker（plan/recording/custom 三类调度） |
| 脚本 | `tmp/deploy/deploy_0510.sh` + `deploy_server_0510.py`；验证 `tmp/deploy/verify_0510_api.js` + `run_verify_0510.py`；结果留存 `tmp/deploy/deploy-0510-result.txt`、`verify-0510-result.txt` |
| 回滚 | `systemctl stop learning-server && cp -a /opt/learning-server/server.cjs.bak-20260924-1600 /opt/learning-server/server.cjs && systemctl start learning-server` |

⚠ **本 issue 的核心验收（真实长工具轮不再被砍）尚未复跑**：部署验证只证明了新判据代码在位、服务启动无异常；
要实证「一轮 242~654s 的网页生成不再产生 `判定挂死`、报错文案不再甩锅模型」，必须真跑一次
`parent_build_material` / `create_html_lesson`（有 LLM 代价），观察 `journalctl` 里**没有**「超过 240s 无任何事件」而
工具正常跑完。P1 未做。

---

### P0-a（原方案）把 240s 判据从「会话静默」改成「模型静默」

最小、语义最准确的改法：**工具执行期间不计入静默**。

- `parent-registry.ts` / `session-registry.ts` 的 `attachStream` 里维护 `runningTools` 计数：
  `tool_execution_start` → +1，`tool_execution_end` → −1；
- watchdog（`setInterval` 5000ms）判定时若 `runningTools > 0`，**把上次活跃时间视为"现在"**（即跳过判定）；
- 工具轮另设一个**显著更长的硬上限**（如 30 分钟）防"工具永不返回"，触发时报**准确的**原因
  （「工具 X 执行超过 30 分钟仍未返回」而不是"模型无响应"）。
- 收益：既保住"模型 API 真挂起"的兜底能力，又不再误杀长工具；错误文案恢复可信。
- 代价：改动集中在两个 registry 的 watchdog 分支 + 错误文案；无接口/数据契约变化。

### P0-b（推荐一起做）让长工具有进度，而不是"黑洞 11 分钟"

> ✅ **已按 b1 实施**（`onUpdate` → `tool_execution_update` → `tool_progress`）；b2 的"独立 hub key"留给 P2。

两条路径任选或叠加：

- **b1 接 `onUpdate`**：SDK `execute(id, params, signal, onUpdate)` 第 4 参可推 `tool_execution_update`
  （`pi-coding-agent/dist/core/agent-session.js:509-517` 已把它转成扩展事件）。
  在 `createProgrammingTool` 的 `execute` 里把嵌套会话的 thinking/文本按**节流（如每 20~30s 或每 N 字符）**推一次。
  一次同时解决：① 父层 activity 被刷新 → 240s 不再误杀（是 P0-a 的更强版）；② 家长端能看到「正在写代码…」，不再对着空白等。
- **b2 嵌套会话接 hub**：`getProgrammingSession` 建会话后加 `session.subscribe(...)` 把事件映射成父 key 的
  `tool_progress` 事件（**需注意**：嵌套 agent 的思考不该污染父层轮内文本缓冲 `turnTextBuffers`，建议用**独立事件类型**，前端单独渲染）。

⚠ 取舍：b1/b2 都会把"编程 agent 的内部过程"暴露给家长端 UI，需前端配合（`ParentChatPanel` 的工具卡片加进度区）。
若只想止血，**P0-a 单独做即可**。

### P1（可选）回放 gap 检测（另一条独立缺口）

`agentStreamHub.replayAfter`（`stream-hub.ts:70-73`）只按 `id > lastEventId` 过滤 500 条环形缓冲，
**不告知"你要的那段已经被挤掉了"**。客户端重连后若 `lastEventId` 早于缓冲区最老 id，会**静默丢一段事件**
（典型症状：只收到 `tool_end` 没有 `tool_start` → 工具卡片错乱；或正文缺中段）。
建议：服务端 replay 时若 `lastEventId < buf[0].id - 1` 则先补发一个 `gap` 事件（带当前 `lastEventId`），
客户端收到后重新 `POST /parent-agent/open` 对齐 UI。
（注：长工具本身不产生事件，**不加剧**这条；这是独立的通用缺口，优先级低于 P0。）

### 验收口径

1. **回归历史场景**：以 201 上 lesson-01~05 的时间事实为基（工具轮 242~654s），修复后这些轮**不再产生 `判定挂死` 日志**；
2. **不丢兜底**：人为让模型 API 挂起（或本地模拟 prompt 不返回）→ 仍应在阈值内中止并给出正确文案；
3. **文案准确性**：长工具超硬上限时，错误信息指明"工具 X 超时"，不再写"模型服务无响应"；
4. `tsc --noEmit` 0 错 + 相邻回归（issue135/issue143 等）零新增失败 + 服务端 bundle 构建通过。

---

## 五、取证方法（可复现，全只读）

```bash
# ① 长工具真实耗时
sudo journalctl -u learning-server --no-pager -o cat | grep "生成完成"
# ② 挂死中止次数与原始行
sudo journalctl -u learning-server --no-pager -o cat | grep -c "判定挂死"
# ③ 时间线配对（关键：证明挂死与长工具是同一轮）
sudo journalctl -u learning-server --no-pager -o short-iso \
  | grep -E "programming-agent|判定挂死" | tail -80
```
⚠ 两处踩坑：`sudo` 不带 `-S` 传密码会**静默返回空**（第一版脚本因此得到"0 次"的假结论）；
`journalctl -o cat` **不带时间戳**，配对必须用 `-o short-iso`。

本地取证脚本（只读、留档）：`tmp/deploy/diag_201_longtool.py`、`tmp/deploy/diag_201_longtool_correlate.py`。

---

## 六、结论一句话

45s 那条是**客户端订阅层的自愈**，与长工具正交、不会误伤，且重连不打断任务；
**该修的是服务端 240s 那条**——它把"工具在跑"读成了"模型挂了"，2026-09-20 一天就砍掉 5 轮网页生成，
还把责任写进报错文案推给模型服务。

**✅ 2026-09-24：P0-a + P0-b 已实施并部署 201（0.5.10，本地验证全绿 + 线上启动探针通过；真实长工具轮待复跑）** —— 判据改为「有工具在跑 → 30min 硬上限 + 工具超时文案；无工具 → 原 240s 模型静默」，
并补上长工具的进度回报与中止传播；顺带修掉孩子侧 `activityKey ≠ streamKey` 导致「任何 >240s 正常轮都被砍」的独立 bug。
P1（回放 gap 检测）、ISSUE-147 的 P1/P2 仍待拍板。

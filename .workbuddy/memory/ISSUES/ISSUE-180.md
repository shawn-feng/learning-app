# ISSUE-180：`capture=manual` 页面整体失去取词（ISSUE-017 被 ISSUE-060 manual 模式关掉）——连带错题/生字 C2 采集渠道在这些页面断掉

- **类型**：bug（功能回归 + 数据采集缺口）
- **优先级**：高（编程 agent 每生成一页 manual 页就丢一页取词 + 错题采集；201 已有实锤分布）
- **记录时间**：2026-10-13
- **关联**：ISSUE-017（自动取词）、ISSUE-060（PiBridge 手动模式）、ISSUE-031（浮层优化）、ISSUE-114（查词→错题上报，时机=点击查询后，现状正确勿动）、ISSUE-178（编程 agent prompt 缺口，同根）
- **状态**：✅ **已实施（2026-10-13，F1~F3 全部落地）**，实施记录见文末

## 现象（201 实测，2026-10-13）

家长反馈：「小巴掌童话的 html 没有查词功能，而论语的 html 有」。到 201 逐文件核实，分界线就是 head 里有没有 `<meta name="pi-bridge" content="capture=manual">`：

| 页面（201 实查） | capture=manual | 取词 |
|---|---|---|
| 论语（旧根 `materials/<pid>/lunyu/` 全部章节） | 无 | ✅ 有 |
| reading 主题 60 个故事页（春风系列） | 无 | ✅ 理论有 |
| **小巴掌「从栅栏上面跳进来的客人」**（新根 xiaobazhang/） | **有** | ❌ 无 |
| **schoolwork/2026-10-XX学校作业 ×4** | **有** | ❌ 无 |
| 小巴掌「拔河马比赛」（新根 xiaobazhang/） | 无 | ✅ 理论有 |

「从栅栏上面跳进来的客人.html」已逐项核实：声明了 meta、正文有 DOM 文本（非 canvas、无 user-select:none）、提到 PiBridge 3 处、但 **`request('lookup')` 零处**——自动取词被关、手动取词没接，取词整体消失。

## 根因（代码链已核）

1. ISSUE-017 的取词监听（mouseup 拖选 + dblclick 双击 → `send({kind:"lookup"})`）写在 `src/lib/page-bridge.ts:264-290`，位于 `if (autoCapture)` 块内（`:337`：「manual 采集模式下不挂自动监听」）；
2. `captureManual` 判定在 `:570-573`：html 同时含 `capture=manual` 字样与 `<meta name="pi-bridge">` 即置 `window.__PI_CAPTURE_MANUAL=1` → 桥脚本跳过**全部**自动监听；
3. ISSUE-060 的本意是「关掉自动**上报采集**、作者决定何时上报」——但实现把**取词**这个孩子辅助功能也一并关了（取词不是采集，是阅读辅助，两者不该捆在一起）；
4. 放大器：编程 agent 的协议 prompt（`server/src/agent/programming-agent.ts:136`）**鼓励**新页面声明「`capture=manual`」——编程 agent 每生成一页 manual 页，就丢一页取词，且 prompt 未要求声明者自接 `request('lookup')`（生成页也确实没接）。

**连带损失（错题采集）**：ISSUE-114 的 C2 渠道「查词→错题本」挂在查词链路里——弹框展开时 `mistakeReport({kind:"unknown_word", source:"lookup"})`（`MaterialsPanel.tsx:825`、`ChatWindow.tsx:1117`，时机=点击查询后，正确勿动）。manual 页取词断了 ⇒ 孩子查不了词 ⇒ `mistakeReport` 发不出 ⇒ **这些页面上生字采集为 0**。查词=不会的最强信号，恰好在新生成的页面上流失。

## 方案

| # | 改动 | 位置 | 说明 |
|---|---|---|---|
| F1 (P0，推荐) | **把取词监听从 `autoCapture` 里拆出来**：manual 模式只停用「上报采集」（click/scroll/input/submit/pagehide/tts 自动上报），ISSUE-017 的 mouseup/dblclick→lookup 监听**无条件挂载**（ PiBridge 仍可 `request('lookup')`，两条路并存不冲突——lookup 上报本来就走查词浮层，无重复采集问题） | `src/lib/page-bridge.ts:264-290`（移出 `if (autoCapture)`）+ `:337` 注释 | 一处改动全量恢复：论语/reading/manual 页行为统一；存量 manual 页（从栅栏、学校作业×4）**无需重新生成即恢复取词+错题采集** |
| F2 (P1) | 编程 agent prompt 对齐：①纯阅读/绘本页**不许**声明 capture=manual；②确需 manual 的交互页，prompt 明示「声明 manual 后选中取词仍由宿主提供（F1 后），但页面自主上报须 PiBridge.emit」 | `server/src/agent/programming-agent.ts:131-139` | 与 ISSUE-178 F1（prompt 补环境事实）同文件，可一并改 |
| F3 (P1) | 防回归：`test/` 增加「manual 页仍挂取词监听」的桥脚本用例（解析注入产物断言 lookup 监听存在）；201 存量 manual 页抽 1 份（从栅栏）人工回归选中取词 + `mistakesList` 出现新 unknown_word | `page-bridge` 相关测试 | — |

## 验收场景

1. 201 的「从栅栏上面跳进来的客人」（不重生成）：选中/双击字词 → 查词浮层弹出（ISSUE-031 形态：字+拼音、多音字分行）→ `mistakesList` 新增一条 `unknown_word`（source=lookup）；
2. 论语/reading 页取词行为不变（不回归 ISSUE-017/031）；
3. 真正交互密集页（含 submit-answer 类）的自动上报仍按 manual 停用（F1 只拆取词，不恢复全量采集）；
4. 新生成的编程 agent 页面 prompt 合规（阅读页无 manual 声明）。

## 实施记录（2026-10-13）

### F1 取词监听移出 autoCapture（P0）

`src/lib/page-bridge.ts` BRIDGE_SCRIPT 内：`reportLookup`/`isFormTarget`/`CN_RE`/`LOOKUP_MAX_LEN` 与 mouseup/dblclick 两个监听整体移到 `} // if (autoCapture)` 结束标记之后，注释同步改写（manual 采集模式只停**自动采集上报**；取词是阅读辅助，manual 页照常挂载）。两条取词路并存：宿主自动监听（选中/双击）+ 页面 `PiBridge.request('lookup')`，都走同一查词浮层，后到覆盖先到、无重复采集。

**效果**：存量 manual 页（从栅栏、学校作业×4）**无需重新生成**，客户端更新后即恢复取词 → 查词浮层展开仍触发 `mistakeReport`（ISSUE-114 C2 复通）。

### F2 编程 agent prompt 对齐（P1）

`server/src/agent/programming-agent.ts` 交互通讯协议段改写：capture=manual 只给**真正交互密集/语义型**页面（测验答题、场景互动）；**纯阅读/绘本类页面不许声明 manual**；声明与否，选中取词都由宿主自动提供，页面无需做任何事、也不要自实现选中监听。

### F2 附带：宿主 `request('lookup')` 能力补齐

排查发现 prompt 早已向编程 agent 宣称「已实现能力：tts.speak、lookup」，但宿主 `MaterialsPanel.handleAppRequest` 只实现了 `tts.speak`——`request('lookup')` 实际会得到「未知宿主能力」。本次补齐：`action === "lookup"` → `lookupText(text)` 查字典 → 与选中取词同一 `showLookup` 浮层（ISSUE-017/031 形态：先出悬浮图标、孩子点击才展开弹框 → mistakeReport 照常上报）。request 无坐标载荷，锚点取 iframe 顶部中央偏下。

### F3 防回归测试（P1）

`test/page-bridge.test.ts` 新增 describe「capture=manual 模式（ISSUE-180）」4 例：

1. manual 页（`__PI_CAPTURE_MANUAL=1`）mouseup 选中中文 → 照抛 lookup；
2. manual 页 dblclick → 照抛 lookup；
3. manual 页 click/scroll/change/submit 监听**未注册**、无自动事件上抛、window 无 pagehide；open/ready 握手照常（F1 只拆取词，不恢复全量采集）；
4. 结构断言：解析注入产物（manual 页 html），`if (autoCapture)` 块内无 lookup 逻辑、块外有 mouseup/dblclick 监听——监听被挪回采集块内时用例变红。

### 验证

- `page-bridge.test.ts` 39/39 全绿（原 35 + 新 4）；issue178/172 编程 agent 相关 8 例全绿；
- server `tsc --noEmit` 零新错（现存 6 错均在 token-usage/models/topic-package，ISSUE-174 并行半成品存量）；`npm run build` bundle 过（server 0.5.30）；
- 客户端 electron-vite build 与 web build 均过。

### 待 201 生产验证

- **服务端**：部署 0.5.30（prompt 改动只影响新生成的编程页）；
- **客户端**：随下批打包（桥脚本 + 浮层改动，asar 内生效）；
- **人工回归**（验收场景 1）：201 打开「从栅栏上面跳进来的客人」（不重生成）→ 选中/双击字词 → 查词浮层（字+拼音、多音字分行）→ 展开弹框 → `mistakesList` 新增 unknown_word（source=lookup）；论语/reading 页取词不回归；交互页自动上报仍按 manual 停用。
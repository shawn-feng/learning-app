## [ISSUE-017] 孩子界面：学习资料点击/选中不认识的字词，显示读音+释义（不修改资料 html）

- **类型**：需求 / 功能（学习辅助）
- **描述**：孩子年龄小，学习资料（iframe 内的课程 html）里有不认识的字词。希望孩子**点击或选中**某个字词，就能**显示该字词的读音和意思**（拼音/释义），降低阅读门槛。要求：**不修改任何学习资料 html 文件本身**就能实现（资料 html 由课程生成器产出、存量多，不应逐个改）。
- **可行性（已查证，可行）**：资料 html 经 `injectBridge(html)` 注入 `BRIDGE_SCRIPT` 桥脚本（`src/lib/page-bridge.ts:388`、脚本体 :95）运行在 iframe 内，经 `window.parent.postMessage` 与父页面（`MaterialsPanel.tsx:104` send / :152 handler）双向通讯——ISSUE-011 的 speechSynthesis 接管正是同机制、已验证。**iframe 为 opaque origin（sandbox 不带 allow-same-origin，`MaterialsPanel.tsx:75`）→ 父页面不能直接读 iframe DOM，但桥脚本能读自己 DOM 并上抛**，故「捕获选中文本」在 iframe 内脚本做即可，不改资料 html。
- **现状 / 排查入口**：
  - 上行通道：`BRIDGE_SCRIPT` 的 `send(msg)`（`page-bridge.ts:101-105`）→ `window.parent.postMessage({type:"page:event", kind, detail}, "*")`；父 handler 在 `MaterialsPanel.tsx:152-209`（按 `data.type`/`kind` 分发，现有 `tts`/`tts-cancel`/`click`/`scroll` 等）。
  - 事件监听约定：全部捕获阶段、绝不 preventDefault/stopPropagation，不干扰课程脚本（`page-bridge.ts:204-205`）——新增 lookup 监听须遵守。
  - 读音复用：资料朗读已走 `speakMaterialText(text)` → `window.api.voiceTts`（edge-tts，与聊天同音色，ISSUE-011）——lookup 的「读音」可直接复用。
  - 释义数据源：**当前代码无中文字典**。需新增（见改造方向④）。
- **改造方向**：
  ① **捕获交互（桥脚本内）**：在 `BRIDGE_SCRIPT` 增加监听——孩子「选中文字后松开（mouseup + getSelection）」或「双击单字（dblclick）」→ 取选中/命中文本，避免与课程已有单击发音冲突（用选区/双击触发，不拦单击）。可附点击坐标 clientX/clientY 供浮层定位。
  ② **上抛父页面**：新增 `kind: "lookup"`（detail 含 text + 坐标），send 上行；`MaterialsPanel` handler 增加 `lookup` 分支（不进 `onPageEvent` 页面操作记录、不自动投 agent，遵循 ISSUE-015）。
  ③ **父页面浮层**：`MaterialsPanel` 上方覆盖一小卡片（拼音 + 释义 + 🔊 朗读按钮），按需定位到字词附近（用②的坐标）；点空白关闭。
  ④ **释义数据源**：起步用**本地内置汉字/词语字典（json，离线、隐私友好）**；进阶可选在线词典 API（需联网、国内可达性评估）；可在主进程/electron 侧或 server 侧内置字典，经 IPC/接口返回释义。建议先做本地字典（覆盖常用字 + 课程高频词）。
  ⑤ **分词/优先级**：选中文本优先整词查（词典精确匹配词条）；否则按单字拆分逐字展示（适合「点单字查字」场景）；也支持直接双击单字查该字。
- **优先级**：已完成 ✅（2026-08-31 实施）
- **实施记录（2026-08-31）**：
  - ① 桥脚本（`page-bridge.ts` BRIDGE_SCRIPT）：新增 `mouseup`（拖选）+ `dblclick`（双击选词）监听（捕获阶段、不 preventDefault），`getSelection` 取文本——过滤：无选中/纯英文数字/表单内（input/textarea/select）/超 8 字均不上抛；坐标随事件上抛（`detail.x/y`，相对 iframe 视口）；同文本近坐标 2s 节流防 mouseup+dblclick 双报。`PageEventKind` 加 `"lookup"`，`detail` 加 `x/y`。
  - ② 父页面（`MaterialsPanel.tsx`）：handler 加 `lookup` 分支——`lookupText()` 本地查词 → `WordLookupOverlay` 浮层（fixed 定位：iframe rect + clientX/Y，clamp 视口内）。**不进 `onPageEvent`**（遵循 ISSUE-015）。关闭：点浮层外空白（content-panel onClick）、Esc、iframe 内后续 click（非同交互序列 400ms 宽限）/scroll、资料刷新/卸载。⚠️ handler 闭包内 state 恒初值 → `lookupRef` + `showLookup` 同步（ISSUE-014 教训）。浮层条目：大字 + 拼音（多音空格分隔）+ 释义 + 🔊 朗读（复用 `speakMaterialText` → edge-tts）。
  - ③ 本地字典：`scripts/dict-build/`（chinese-xinhua word.json 16142 条 + pinyin-pro 多音补全）→ `src/lib/dict/chars.json`（14809 字，425 核心字儿童化释义覆盖）+ `words.json`（713 儿童高频词）；`overrides.mjs` 为儿童化覆盖表（**构建时合并，覆盖表拼音列含常用多音如「行 xíng háng」**）。构建：`node scripts/dict-build/build-chars.mjs`。
  - ④ 查询模块 `src/lib/dictionary.ts`：`lookupText()` 整词优先 → 贪心最长词拆分（首字分桶、词长降序、≤4 字）→ 逐字兜底；非中文跳过。数据经 `resolveJsonModule` 内联进渲染 bundle（+~0.7MB）。
  - ⑤ 测试：`test/dictionary.test.ts`（8 例）+ `test/page-bridge.test.ts` 新增 8 例 lookup 桥测试 → 42 例全绿；`tsc --noEmit` 无业务错误；`npm run build` 成功。桥体积 12.04KB（阈值 12→13KB）。
  - **遗留**：全量 vitest 16 文件失败系「无法连接服务端（127.0.0.1:8788，SPLIT 服务端未启动）」环境依赖，与本次改动无交集（page-bridge/dictionary 相关 42 例已独立验证全绿）。

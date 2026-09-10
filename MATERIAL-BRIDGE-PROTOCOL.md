# MATERIAL-BRIDGE-PROTOCOL（资料页 ↔ 宿主/AI 统一通讯协议）

> 定稿：2026-09-08。本协议是**唯一标准**：任何"需要与宿主/agent 通讯"的学习资料网页（孩子端场景互动、家长端随堂测验、绘本等）都由编程 agent 按本协议制作。
> 目标：网页作者只面对一个 `window.PiBridge` API；宿主与 agent 侧只面对一套信封与动作目录；不再按场景/页面种类各维护一套私有通道（如历史遗留的 `scene:*` 直发消息）。

---

## 1. 安全前提

- 资料页运行在 **sandbox="allow-scripts" 不透明源 iframe**（资料是 agent 生成的不可信 HTML，宿主不信任其 DOM）；
- 通讯只经 `postMessage`（iframe 内一律 `window.parent.postMessage(…, "*")`）；
- 宿主侧校验 `event.source`、消息类型白名单；页面侧校验 `type`/`requestId`；
- 协议只传**语义数据**，不暴露宿主内部 API/路径；无任意代码执行。

## 2. 采集模式（作者可控，对应旧版"全量自动采集"问题）

- **默认 `auto`（向后兼容）**：桥脚本照旧自动采集 click/scroll/input/submit/选中查词并上抛；
- **`manual`（新网页推荐，尤其"交互密集型/语义型"页面）**：页面声明后，桥**不**挂自动采集监听，所有"想让 agent 知道的事"都由作者显式 `PiBridge.emit(action, payload)` 上报——真正做到"特定操作才通讯"。

声明方式（放 `<head>` 即可）：

```html
<meta name="pi-bridge" content="capture=manual">
```

> 兼容：未声明的旧资料行为完全不变。

## 3. 页面作者 API（唯一入口：`window.PiBridge`）

```js
PiBridge.emit(action, payload?)          // 上行事件：告诉宿主/agent "页面里发生了 action，带 payload"（尽力而为，无回执）
PiBridge.request(action, payload?)       // 请求-响应：调用宿主能力并等待结果 → Promise<{ ok, data?, error? }>
PiBridge.on(action, handler)             // 注册宿主→页面命令的处理函数（演出/翻页/状态等下行命令）
PiBridge.off(action, handler?)
```

命令 handler 签名：`(payload) => void | { data } | Promise<{ data }>`；同步返回值或 Promise resolve 都会作为命令回执发回宿主；抛错/返回 `{error}` 则回执失败。

## 4. 信封（内部实现，作者不感知；文档供宿主/排查参考）

| 方向 | 信封 | 说明 |
|---|---|---|
| 页面→宿主 事件 | `{ type:"page:app", action, payload, seq, ts }` | 由桥内 PiBridge.emit 发出 |
| 页面→宿主 请求 | `{ type:"page:req", requestId, action, payload, seq, ts }` | PiBridge.request 发出 |
| 宿主→页面 命令 | `{ type:"page:app-cmd", requestId, action, payload }` | 宿主 `MaterialsPanel.appCmd` 发出，页面 PiBridge.on 接收 |
| 页面→宿主 命令回执 | `{ type:"page:app-cmd:result", requestId, ok, data?, error? }` | 命令执行完毕回执 |
| 宿主→页面 请求回执 | `{ type:"page:app-res", requestId, ok, data?, error? }` | 宿主能力处理后回给页面 |

可靠性沿用宿主 `page:exec` 的成熟底座：就绪 gate（页面 `page:ready` 前不下发）、requestId 配对、超时、页面关闭自动 reject。

## 5. 标准动作目录（命名空间制，单一来源）

- **通用**（家长端测验、绘本等一切网页）：
  - 上行 `emit`：`submit-answer`（{questionId, answer, correct?}）、`complete-section`（{section}）、`request-help`（{topic?}）、`self-check`（{correct, wrong[]}）…；
  - 宿主能力 `request`：`tts.speak`（{text, voice?}，播完 resolve）、`lookup`（{text}，返回拼音/释义）、`goto-course`（预留）、`get-progress`（预留）；
  - 自定义 action 约定：payload 自带 `semantic` 说明字段，宿主不理解的 action 也会透传进 agent 上下文，由 agent 依据说明回应。
- **场景演出命名空间 `scene.*`**（场景互动引擎使用，历史 `scene_command` 工具的下行语义平移到此，agent 侧仍用工具名 `scene_command`，参数不变）：
  - 宿主→页面：`scene.say` {character,text,zh} / `scene.move` {character,x,duration} / `scene.act` {character,act} / `scene.show` {character} / `scene.hide` {character} / `scene.highlight` {target} / `scene.update` {task,progress,total} / `scene.busy` {busy}（伙伴回应中提示）/ `scene.mic.status` {status} / `scene.mic.result` {ok,text?,error?}；
  - 页面→宿主：`scene.ready`（{manifest}，场景属性清单，一次性）、`scene.item-click`（{target,word,zh}）、`scene.mic.press` / `scene.mic.release`（触发宿主录音）。

## 6. 生命周期约定

1. 页面加载 → 桥发 `page:ready`（宿主据此放行指令）；资料页要上报"内容/能力清单"时再 `emit('…ready', 清单)`（场景= `scene.ready`+manifest）；
2. 会话期间任意时刻可 `emit` 事件、`request` 能力、接收宿主 `app-cmd`；
3. 无"结束"语义由页面/宿主业务决定，协议层无 end。

## 7. 编程 agent 制作约定（嵌入 `buildProgrammingPrompt`）

生成"需要与宿主/AI 通讯"的学习资料时：
1. **默认使用本协议**：上报关键互动用 `PiBridge.emit(action, payload)`，调用宿主能力用 `PiBridge.request('tts.speak',{text})` 等，接收宿主指令用 `PiBridge.on('…', handler)`；
2. 交互密集/语义型页面**声明 `capture=manual`**；
3. `action` 一律用命名空间内小写连字符（`scene.say`、`submit-answer`），自定义 action 在 payload 里带 `semantic` 说明；
4. 完整规范：见 `MATERIAL-BRIDGE-PROTOCOL.md`；拿不准动作名时用通用命名并在 payload.semantic 自解释。

## 8. 作者示例

**家长端随堂测验**（上行上报 + 朗读能力）：
```html
<meta name="pi-bridge" content="capture=manual">
<script>
  function check() {
    var answer = document.querySelector('input:checked')?.value;
    PiBridge.emit('submit-answer', { questionId: 'q1', answer: answer, correct: answer === 'B' });
    PiBridge.request('tts.speak', { text: correct ? 'Correct!' : 'Try again.' });
  }
</script>
```

**场景页接收演出命令**：
```js
PiBridge.on('scene.say', function (p) { showBubble(p.character, p.text, p.zh); speak(p.text); });
PiBridge.on('scene.act', function (p) { runAct(p.character, p.act); });
PiBridge.emit('scene.ready', { title: '…', props: [ … ], characters: [ … ] });
```

## 9. 宿主实现要点（供维护）

- 渲染层 `src/lib/page-bridge.ts`：桥内注入 `PiBridge` SDK + `capture=manual` 识别；类型/常量。
- `MaterialsPanel`：`page:app`→构造 `PageEvent{kind:'app'}` 上抛；`page:req`→查能力表（`tts.speak` 等）处理并回 `page:app-res`，未知能力走 `onAppRequest`（默认 `{ok:false,error:'unknown-action'}`）；`page:app-cmd:result`→兑现 pending；暴露 `appCmd(action,payload)`（复用 exec 就绪/超时/pending）。
- 主进程 `electron/lib/page-bridge.ts` `formatPageEvent`：`kind:"app"` → `在资料「title」中触发动作「action」，数据：{payload}`。

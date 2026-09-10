## [ISSUE-024] 聊天框调宽手柄：当前是"点一下进入拖拽模式、再点一下退出"，应改成"按住拖拽、松手即停"

- **类型**：Bug / 交互（聊天面板拖拽手柄）
- **描述**：右侧聊天框左侧边缘有调宽手柄。当前行为是**点击一下就进入"拖拽模式"（之后移动鼠标即改变宽度），再点击一下才退出**；期望行为是**按住鼠标左键拖动才调宽、松开鼠标立即停止**（标准拖拽，松手即停）。
- **现状 / 根因（已查证代码）**：
  - **手柄绑定的拖拽逻辑**：`useChatPanel.ts` 的 `startDrag`（`src/hooks/useChatPanel.ts:49-70`）在 `onMouseDown` 时给 `window` 加 `mousemove`+`mouseup` 监听器，拖拽中 `setWidth` 实时改宽；`onUp` 负责移除监听器并还原 `cursor`/`userSelect`。**逻辑本身是"按住拖拽"模型**，不是 click-toggle——但有个致命缺陷：**`mouseup` 只监听在 `window` 上**。
  - **根因 = 拖到 iframe 上松手，`mouseup` 被 iframe 吞掉（经典"拖过 iframe"陷阱）**：孩子端 `Learn.tsx` 中间展示区是 `MaterialsPanel` 渲染的 **`<iframe srcDoc=...>`**（`MaterialsPanel.tsx:92/97`）——它是一个**独立 document**。手柄位于聊天面板左缘、紧邻中间区；用户往左拖（变宽）时鼠标移入中间区、若**在 iframe 上方松开**，`mouseup` 事件发生在 iframe 子文档里，**不会冒泡到父窗口 `window`** → 父窗口的 `onUp` 永不触发 → `mousemove` 监听器一直挂着 → 聊天框持续跟随鼠标移动，直到用户在父文档上再点一次（第二次 mousedown+mouseup 才让 `onUp` 跑）→ 表现为**"点一下进入拖拽、再点一下退出"**。
  - **为什么只在特定场景复现**：家长端 `Dashboard` 中间不是 iframe（`Dashboard.tsx:226` 同用手柄），松手在父文档上 `mouseup` 正常触发 → 表现为正常按住拖拽；**孩子端 `Learn` 中间是 iframe**，拖宽时极易在 iframe 上松手 → 必现"卡住/点二下"的 bug。这与用户"右侧聊天框宽度调整"的体感一致（孩子端右聊）。
  - **附带副作用**：`onUp` 不执行还会让 `document.body.style.cursor="col-resize"` / `userSelect="none"` 一直残留，光标与选中状态也被卡住。
- **改造方向**：
  ① **首选：Pointer Events + setPointerCapture**（最小且彻底）：手柄改用 `onPointerDown`/`onPointerMove`/`onPointerUp`，在 `onPointerDown` 调 `e.currentTarget.setPointerCapture(e.pointerId)`；之后 `pointermove`/`pointerup` 直接绑在**手柄元素自身**（捕获后即使指针移到 iframe 上方，事件也路由回手柄）。`onPointerUp` 里 `releasePointerCapture` + 移除监听 + 还原 cursor/userSelect。**彻底解决 iframe 吞事件**，无需改布局。
  ② **备选：拖拽时盖透明遮罩**：`onMouseDown` 时在 body 加 `position:fixed; inset:0; z-index` 的全屏透明层（盖在 iframe 之上），让 `mouseup` 落在父文档、再移除遮罩——可行但多一次 DOM 操作。
  ③ **备选：拖拽中禁 iframe 指针事件**：`onMouseDown` 给 body 加 class 使 `.materials-iframe { pointer-events:none }`，松手移除——同样让 mouse 穿透到父文档。
  ④ **保持现有持久化/范围**：`useChatPanel.ts` 是家长/孩子共用 hook（`Dashboard`/`Learn` 都走它），改造在 hook 内一次完成、两端同时修复；`width` 持久化（localStorage `chat:${key}:width`）与折叠逻辑不变。
  ⑤ **回归**：`chat.width` 拖拽实时生效 + 刷新保留（useChatPanel）、`chat.collapsed` 折叠（Learn.tsx:1003 / Dashboard）、ISSUE-023 字号变量、聊天区占满（ISSUE-008/016 的 `panelCollapsed` flex 逻辑）不受影响；重点测**孩子端往左拖到资料 iframe 上方松手**应能干净停住。
- **优先级**：已完成（2026-08-31 实施：方案① Pointer Events + setPointerCapture——`useChatPanel.ts` `startDrag` 参数改 `React.PointerEvent`，`onPointerDown` 时 `setPointerCapture(e.pointerId)`，`pointermove/pointerup/pointercancel` 绑到手柄元素自身（捕获后即使指针移入 iframe，事件仍路由回手柄，松手即停、彻底解决 iframe 吞 mouseup）；`releasePointerCapture` + 还原 cursor/userSelect；捕获失败 fallback window 级监听；`Learn.tsx`/`Dashboard.tsx` 手柄 `onMouseDown`→`onPointerDown`；`.chat-resize-handle` 加 `touch-action:none`（触屏可拖）。tsc 0 业务错误、build 通过）
- **记录时间**：2026-08-31

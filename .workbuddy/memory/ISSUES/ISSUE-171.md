# ISSUE-171：查词弹框里的语音播报一点就弹框消失且无声——mouseup 泄漏到 document 选区监听

- **类型**：bug / UX（事件冒泡竞态）
- **现象**：聊天框选字词 → 点悬浮图标出查词弹框 → 点 🔊 朗读：弹框立刻消失（回到悬浮图标态），也没有播报声音。资料面板的查词弹框同链路同隐患。
- **根因（已核代码）**：`useWordLookup` 在 document 上挂 mouseup 监听（onUp：选区有效 → 重锚定 + `setOpen(false)` 回图标态）。Chromium 里**点击按钮不清除文本选区**——点 🔊 的 mouseup 冒泡到 document，把仍存活的选区当「新选词」→ 重锚定 + 收回弹框；React 卸载弹框（连同 🔊 按钮）→ **click 事件永远派发不到按钮** → `onSpeak` 未执行 → 无声 + 弹框消失。弹框此前只 stopPropagation 了 click，mousedown/mouseup 仍外漏（悬浮图标 Bubble 只拦了 mousedown）。
- **修复（2026-09-28）**：弹框根节点 mousedown/mouseup/click 全部 stopPropagation；悬浮图标补 onMouseUp stopPropagation。效果：弹框内部任何点击不再触发「点外部关闭」或「重锚定」，🔊 正常触发播报、弹框保留；「点外部关闭」由外部 mousedown 直达 document 保证，Esc 关闭不变，语义无回归。
- **验证**：electron-vite / web 双端构建过；行为推演：🔊 点击 → 播报 + 弹框保留；X 关闭、Esc、点外部关闭均走原路径；选新词 → 重锚定不受影响（发生在弹框外）。
- **优先级**：中（查词是高频路径，播报是 ISSUE-031 的核心交互）
- **记录时间**：2026-09-28（当日修复）

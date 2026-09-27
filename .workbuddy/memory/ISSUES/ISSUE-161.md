# ISSUE-161：微信绑定改为飞书绑定——微信渠道已取消，绑定面板/文案全面切到飞书

- **类型**：需求 / 渠道切换（产品面重命名 + 文案修正）
- **记录时间**：2026-09-27
- **状态**：✅ 已实施（见实施记录）

## 背景

微信渠道已取消（OpenClaw 网关的微信插件不再使用）；**飞书渠道本身已完整实现**（server/src/channels/feishu.ts：官方 SDK WebSocket 长连接收消息、卡片过程气泡、/reset /help 斜杠命令、bind_requests/bindings 都带 channel='feishu'，面板里也已有「飞书机器人配置」编辑区）。要改的是**产品面**：设置页入口与绑定面板仍叫「微信绑定」，飞书渠道的引导文案甚至让用户去「设置 → 微信绑定」。

## 改动

1. **面板改名**：`WeChatBindPanel.tsx` → `FeishuBindPanel.tsx`（组件同名改），Settings 页 tab「微信绑定」→「飞书绑定」（tab key wechat → feishu）。
2. **面板文案**：标题「📱 微信绑定」→「💬 飞书绑定」；引导语改为「家人在飞书里给『学习伙伴』机器人发消息即可接入」（微信/ClawBot 表述退场）；空态、绑定成功提示里的「微信」→「飞书」。
3. **服务端文案**：feishu.ts 未绑定引导「设置 → 微信绑定」→「设置 → 飞书绑定」；wechat.ts /turn 未绑定回复里的「设置 → 微信绑定」引用同步（微信渠道已取消，入口名以新面板为准）。
4. **保留不动**：`/api/v1/wechat/*` 路由路径、`wechat_bindings`/`wechat_bind_requests` 表名（channel 字段区分 wechat/feishu）、preload `wechatBind*`/`wechatFeishu*` 方法名、web-shim 同名方法——均为内部契约，改名是纯 churn 且会破坏 OpenClaw 网关的 POST 契约；微信 /turn 入口保留（渠道取消后自然不再触发）。

## 回归

设置页 tab 切换正常、面板轮询/确认绑定/解绑/飞书配置保存不受影响（纯文案+组件改名）；web-shim 覆盖通过。

## 实施记录（2026-09-27）

- **面板改名**：`git mv WeChatBindPanel.tsx → FeishuBindPanel.tsx`，组件 `FeishuBindPanel`；Settings 页 import/挂载/tab key（wechat→feishu）与 tab 联合类型同步。
- **面板文案**：标题「💬 飞书绑定」；引导语「家人在飞书里给『学习伙伴』机器人发消息即可接入（原微信渠道已取消）」；待确认空态/绑定成功提示/已绑定空态的「微信/ClawBot」表述全部换飞书。
- **服务端文案**：channels/feishu.ts 未绑定引导 → 「设置 → 飞书绑定」；routes/wechat.ts /turn 未绑定回复改中性「这个账号…设置 → 飞书绑定」（该入口属已取消的微信渠道，仅兜底触发）。
- **保留不动**（内部契约，改动是纯 churn 且会破坏 OpenClaw 网关 POST 契约）：`/api/v1/wechat/*` 路由路径、`wechat_bindings`/`wechat_bind_requests` 表名（channel 字段区分渠道）、preload `wechatBind*`/`wechatFeishu*` 方法名与 web-shim 同名方法；微信 /turn 入口保留（渠道取消后自然不触发）。
- **验证**：tsc 无新增错（根/服务端）、双端 build 过、web-shim 覆盖 + wechat-bridge 测试 6/6 过。

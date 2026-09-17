# 学习伙伴 × 微信桥（OpenClaw learning-bridge）

> 2026-09-17。用 201 上已有的 OpenClaw gateway 作为微信渠道适配器：微信私信 → weixin 渠道插件
> → `learning-bridge` 钩子 → learning-server `/api/v1/wechat/turn`（家长/孩子 agent 会话）→ 回复原路推回微信。
> OpenClaw 自己的 LLM 不参与——学习服务端的 agent 是唯一大脑（含全部工具与安全白名单）。

## 组件

| 组件 | 位置 | 说明 |
|---|---|---|
| `/api/v1/wechat/turn` | server/src/routes/wechat.ts | 收 `{senderId, text}`，按 `wechat_bindings` 路由到家长/孩子会话，聚合 `text_delta` 直到 `turn_end`（240s 熔断）返回最终回复 |
| `wechat_bindings` 表 | server/src/db.ts（主库） | `wechat_id ↔ role(parent/child) + parent_id + child_id`；管理入口 `POST /api/v1/wechat/bindings`（家长 JWT，action=list/add/remove） |
| learning-bridge 插件 | openclaw-bridge/learning-bridge/ | OpenClaw `before_agent_reply` 钩子：拦截微信私信→转发 server→`{handled:true, reply}`；busy/未绑定/错误都有友好话术 |

## 201 上的安装状态（2026-09-17）

- 插件目录 `~/learning-bridge`（`--link` 安装，改代码后 `openclaw plugins reload learning-bridge`）
- `openclaw-weixin` 2.4.9 已装并启用；`learning-bridge` 已启用
- 配置已写入：`plugins.entries.learning-bridge.hooks.allowConversationAccess = true`
- 运行时验证：`openclaw plugins inspect learning-bridge --runtime` 显示 `Typed hooks: before_agent_reply`
- openclaw.json 改动前备份：`~/.openclaw/openclaw.json.bak.wechatbridge-20260917`

## 首次启用步骤（需人工）

```bash
# 1）微信扫码登录（只能由账号主人完成）
openclaw channels login --channel openclaw-weixin

# 2）启动 gateway（或按你原来的方式启动）
openclaw gateway start   # 或 openclaw gateway；建议配 systemd 常驻

# 3）绑定微信号（在能拿到家长 JWT 的环境执行，如 App 登录后）
curl -X POST http://127.0.0.1:8788/api/v1/wechat/bindings \
  -H "authorization: Bearer <家长JWT>" -H "content-type: application/json" \
  -d '{"action":"add","wechatId":"wxid_xxx","role":"parent","label":"妈妈"}'
# 孩子绑定：{"action":"add","wechatId":"wxid_yyy","role":"child","childId":"<childId>","label":"珊珊"}

# 4）微信里发一句话给 ClawBot 验证
```

## 环境变量（gateway 进程）

| 变量 | 默认 | 说明 |
|---|---|---|
| `LEARNING_SERVER_URL` | `http://127.0.0.1:8788` | 学习服务端地址（同机默认即可） |
| `LEARNING_WECHAT_TOKEN` | 空 | 与 server 的 `WECHAT_CONNECTOR_TOKEN` 配对；**server 未设令牌时只允许回环来源** |
| `LEARNING_BRIDGE_DEBUG` | 关 | `1` 时把首个事件的原始字段打进 stderr（排查 OpenClaw 版本字段差异） |

## server 侧鉴权口径

`POST /api/v1/wechat/turn` 要求：`x-wechat-token` 等于 server 进程的 `WECHAT_CONNECTOR_TOKEN`；
该变量未设置时仅接受 127.0.0.1/::1 来源（OpenClaw 与 server 同机部署的默认形态）。
跨机测试（如 201 的 OpenClaw 指向 Windows dev server）需两边都配令牌。

## 已知边界

- 仅私信，微信群聊不在支持范围（weixin 插件能力元数据未声明群聊）。
- 一轮回复最长等 240s，超时返回已生成的部分文本。
- 同一会话上一轮未结束时返回 busy 话术（与 App 内语义一致）。

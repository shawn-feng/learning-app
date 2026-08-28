# learning-app 接入权益认证中台（IdP）设计方案

> 状态：方案已评审（2026-08-28）
> 关键决策：
> 1. app 端回跳：**自定义协议 `piauth://callback`**（Electron 注册，系统浏览器回跳）
> 2. token 续期：**中台新增 refresh_token**（长有效期，app 静默续期，免频繁扫码）
> 3. 权益判定：**app 本地换算**（拉 completions 自算"时长/孩子数"等业务权益，规则在 app 端）

---

## 一、角色与目标

- **learning-app**（Electron 桌面端）= OAuth **客户端**：提供登录页、接收回跳、管理本地 token、定时校验授权。
- **权益认证中台 benefit-auth** = **IdP**：统一承载多平台身份登录（抖音/微信/小红书）、任务权益数据、授权状态。
- 用户身份以平台账号（如抖音 open_id）为锚，在中台完成登录与任务；learning-app 不直接对接各平台，全部走中台。

**目标**：
1. app 登录页选平台 → 跳该平台认证页 → 扫码 → 认证通过且权益满足 → 进主页；
2. app 定时轮询中台授权有效性，失效自动处理（先刷新、再重登）。

---

## 二、登录时序

```
learning-app 登录页
  │ 1.用户点「抖音」
  │ 2.shell.openExternal(authorize_url)
  ▼
系统浏览器 → https://auth.aixuexihao.top/oauth/authorize
             ?client_id=<app_id>&platform=douyin&response_type=code
             &redirect_uri=piauth://callback&state=<随机>
  │ 3.中台：未登录→渲染抖音扫码页；已登录→直接发码
  ▼
用户扫码授权成功
  │ 4.中台 302 回跳
  ▼
piauth://callback?code=<code>&state=<state>
  │ 5.app 校验 state → POST /oauth/token 换 token
  ▼
{ user JWT, refresh_token, app JWT, user_id }
  │ 6.GET /oauth/userinfo（user JWT）拿身份
  │ 7.GET /api/app/users/{uid}/completions（app JWT）拿完成任务 → 本地换算权益
  ▼
权益满足 → 进主页     不满足 → 展示"还差哪些任务"
  │ 8.进主页后每 5 分钟：GET /api/app/users/{uid}/auth_status
  ▼
token 快过期 → POST /oauth/refresh_token 静默续期
授权失效(解绑/权益撤/刷新失败) → 提示重新登录
```

---

## 三、接口定义

### 复用（小幅调整）

#### 1. `GET /oauth/authorize` — 授权发起页
- 新增参数：`platform`（`douyin` | `wechat` | `xhs`，默认 douyin；未接入平台返回 404"暂未开放"）
- 其余不变：`client_id`、`redirect_uri`（须精确匹配 app 注册值）、`response_type=code`、`scope`、`state`
- 行为：已登录（ba_sid Cookie）→ 直接发 code 回跳；未登录 → 按 platform 渲染对应平台扫码页

#### 2. `POST /oauth/token` — 授权码换 token
- 参数（Form）：`grant_type=authorization_code`、`code`、`client_id`、`client_secret`、`redirect_uri`
- **返回新增 `refresh_token`**：
```json
{
  "access_token": "<user JWT 72h>",
  "refresh_token": "<随机串 30d，一次性轮换>",
  "token_type": "Bearer",
  "expires_in": 259200,
  "app_token": "<app JWT>",
  "scope": "user_info",
  "user_id": "b0736e0d-..."
}
```

#### 3. `GET /oauth/userinfo` — 用户身份（不变）
- Header：`Authorization: Bearer <user JWT>`
- 返回：user_id、昵称、头像、platform_accounts（含 scopes/绑定时间）

#### 4. `POST /api/app/register` — 注册客户端（不变）
- `redirect_uris` 填 `piauth://callback`（可多个，逗号分隔）
- 返回 app_id / app_secret

#### 5. `GET /api/app/users/{user_id}/completions` — 完成任务（不变）
- Header：`Authorization: Bearer <app JWT>`
- 返回该用户在本站完成的任务列表（供 app 自行换算权益）

### 新增

#### 6. `POST /oauth/refresh_token` — user token 静默续期
- 参数（Form）：`grant_type=refresh_token`、`refresh_token`、`client_id`、`client_secret`
- 成功：返回新 `access_token` + 新 `refresh_token`（**轮换**，旧 refresh_token 立即失效）
- 失败：`401 invalid refresh_token`（过期/已用）→ app 提示重新登录
- 安全：refresh_token 哈希存储、单次使用、30 天有效期、最多轮换 5 次后需重新授权

#### 7. `GET /api/app/users/{user_id}/auth_status` — 授权有效性聚合（轮询用）
- Header：`Authorization: Bearer <app JWT>`
- 响应：
```json
{
  "valid": true,
  "user_token_expires_at": "2026-08-31T12:00:00Z",
  "platform_accounts": [
    {
      "platform": "douyin",
      "scopes": ["user_info", "trial.whitelist", "video.list.bind"],
      "token_expires_at": "2026-09-12T00:00:00Z",
      "valid": true,
      "note": ""
    }
  ],
  "entitlements": { "total": 3, "valid": true },
  "checked_at": "2026-08-28T14:00:00Z"
}
```
- `valid=false` 的判定维度（任一即失效，`note` 说明原因）：
  - user JWT 已过期（app 应先本地续期）
  - 平台账号 access_token 过期且 refresh 失败（中台自动尝试 refresh，失败才标 invalid）
  - 用户已解绑该平台账号
  - 权益被管理员撤销（entitlements.valid=false）
  - 测试期白名单失效（用户被移出白名单）

---

## 四、learning-app 侧实现要点

1. **登录页**：平台列表（从配置或中台查询可用平台）→ 点平台 → 生成 authorize_url（含随机 state，存内存比对）→ `shell.openExternal`
2. **协议注册**：Electron `app.setAsDefaultProtocolClient('piauth')`；macOS `open-url` 事件 / Windows 注册表 / Linux xdg 处理 `piauth://callback?code=..&state=..`
3. **token 管理**：`user JWT` + `refresh_token` + `app JWT` 存本地（safeStorage 加密）；app 启动时若 user JWT 过期 → 先 refresh_token 续期 → 失败才回登录页
4. **权益换算（本地）**：拉 completions → 按 app 业务规则换算"可用时长/孩子数" → 满足进主页
5. **定时轮询**：每 5 分钟调 auth_status；valid=false 时：token 过期→refresh；解绑/权益撤→提示重新授权/完成任务

---

## 五、安全设计

| 项 | 措施 |
|---|---|
| redirect_uri | 必须精确匹配 app 注册的 redirect_uris（防开放重定向） |
| state | app 生成随机值，回跳比对（防 CSRF） |
| client_secret | 仅 app 服务端持有；app JWT 仅服务端调用 `/api/app/*` 用 |
| refresh_token | 哈希存储、一次性轮换、30 天、5 次上限 |
| 传输 | 全 HTTPS；token 不下发到渲染进程（主进程持有，IPC 按需） |

---

## 六、多平台扩展

- 中台：已有 `PlatformProvider` 抽象（douyin 已实现），新增 wechat/xhs 只需新 Provider + 平台开放平台申请（登录 scope、回调、白名单同理）。
- app：登录页平台列表由中台配置驱动，新增平台无需改 app 逻辑。
- 注意：各平台"特定能力"（视频/数据/评论）授权方式、scope 名、白名单规则各不相同（抖音需上线转正 + PC 扫码），扩展时逐平台评估。

---

## 七、待办清单

- [ ] 中台：`/oauth/authorize` 增加 platform 参数
- [ ] 中台：`/oauth/token` 返回 refresh_token；新增 `POST /oauth/refresh_token`
- [ ] 中台：新增 `GET /api/app/users/{uid}/auth_status`（含平台 token 自动刷新逻辑）
- [ ] 中台：`POST /api/app/register` 允许注册 `piauth://callback`
- [ ] learning-app：登录页 + 协议注册 + token 管理 + 轮询（Electron 侧）
- [ ] learning-app：权益换算规则（时长/孩子数）

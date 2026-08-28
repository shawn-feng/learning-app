# 权益认证中台 · 接口与对接契约（v0.2）

> 面向：网站自身前端、以及需要接入的第三方 App（如 learning-app）。
> 本文件描述的接口均已实现并通过端到端测试。

---

## 1. 用户唯一身份模型

- 每个用户有一个**中台 UUID**（`users.id`，首次任意平台登录自动生成）。
- 同一 UUID 下可绑定**多个平台账号**（`platform_accounts`：user_id + platform + open_id）。
- 首次登录（如抖音）生成 UUID；之后在「个人中心」点「绑定」走二次 OAuth，把微信/小红书等挂到**同一 UUID**（登录态内绑定，不会新建用户）。
- 各平台 `scope`（已授权范围）随账号存储，例如 `user_info,video.list`。

## 2. 抖音登录（网站自身）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/oauth/douyin/qrcode?mode=login` | 生成扫码登录二维码（PC 展示，轮询下方 status） |
| GET | `/api/oauth/douyin/status?qr_code=` | PC 轮询：返回 `pending` / `complete`(+token) |
| GET | `/api/oauth/douyin/callback?code=&state=` | 抖音回调：换 token→建/绑用户→签 JWT→写会话 Cookie→回 `/me` |

`mode` 取值：`login`（默认）｜`bind`（已登录态绑定第二平台）｜`upgrade`（已登录态扩大 scope）。

## 3. 平台绑定与解绑（用户侧，需登录）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/me/bindings` | 列出已绑定平台、各自已授权 scope、可绑定平台列表 |
| DELETE | `/api/me/bindings/{platform}` | 解绑某平台（不影响其它平台与权益） |
| GET | `/api/me/{platform}/videos` | 拉取该平台视频列表（需 `video.list` 等高级 scope；缺权限返回 403 并提示升级） |

升级视频权限：`GET /api/oauth/douyin/authorize?mode=upgrade&scopes=user_info,video.list`（浏览器跳转抖音重授权）。

## 4. learning-app 对接（本网站作为 IdP，授权码流程）

learning-app 不自己对接抖音，改为把用户引导到本网站完成抖音登录，再回跳拿用户身份与任务完成情况。

```
1. learning-app 前端 302 到：
   GET https://auth.aixuexihao.top/oauth/authorize
       ?client_id=<APP_ID>&redirect_uri=<APP_CB>&response_type=code&state=<STATE>

2. 用户在本网站用抖音扫码登录（未登录则先展示登录续接页）

3. 本网站回跳：
   <APP_CB>?code=<CODE>&state=<STATE>

4. learning-app 后端用 code 换 token：
   POST https://auth.aixuexihao.top/oauth/token   (form)
        grant_type=authorization_code&code=<CODE>&client_id=<APP_ID>
        &client_secret=<APP_SECRET>&redirect_uri=<APP_CB>
   → { access_token(用户JWT), app_token(应用JWT), user_id, ... }

5. learning-app 用 user JWT 取身份（可选）：
   GET /oauth/userinfo   Authorization: Bearer <access_token>
   → { user_id, nickname, avatar_url, platform_accounts }

6. learning-app 用 app_token 查用户在本网站的完成情况，自行判定权限：
   GET /api/app/users/{user_id}/completions   Authorization: Bearer <app_token>
   → { completions: [ {task_id, platform, task_type, title, reward_config, granted_at}, ... ] }
```

> **权限判定在 learning-app 侧**：本网站只提供「用户完成了哪些任务」（类型/奖励/时间），
> 具体换算成使用时长、孩子数量等业务权限由 learning-app 自行决定。

### 接入前置
- learning-app 在本网站注册应用：`POST /api/app/register` → 拿到 `app_id` / `app_secret`。
- 注册时填 `redirect_uris`（逗号分隔），`/oauth/authorize` 会校验回跳地址。

## 5. 任务模型（App 侧）

- 任务新增 **`platform`** 字段（默认 `douyin`），验证器按平台路由。
- 任务类型新增 **`repost`**（转发/分享），与 `like_comment`（点赞评论）一样**无开放查询接口，必须 `verify_mode=manual`**（创建时强制校验，否则 400）。
- 自动验证类型（抖音）：`follow_account` / `publish_video` / `bind_account` / `fans_reach`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/app/register` | 注册应用（返回 app_id/secret） |
| POST | `/api/app/token` | 换 app_token |
| POST | `/api/app/tasks` | 创建任务（带 platform） |
| GET | `/api/app/users/{user_id}/completions` | **查用户完成的任务（供第三方自判权限）** |
| GET | `/api/app/users/{user_id}/entitlements` | 查用户权益（奖励明细） |

## 6. 部署与配置要点

- 服务器：`/opt/benefit-auth`，端口 9001，Nginx 反代 `auth.aixuexihao.top`，systemd `benefit-auth.service`。
- 把 `douyin-client.txt` 里的 `client key/secret` 写入服务器 `/opt/benefit-auth/.env` 的
  `DOUYIN_CLIENT_KEY` / `DOUYIN_CLIENT_SECRET`，并设强随机 `BENEFIT_JWT_SECRET`，重启服务。
- **抖音开放平台后台**：应用回调域名填 `https://auth.aixuexihao.top/api/oauth/douyin/callback`；
  如需「读取用户视频」，在开放平台为应用申请 `video.list` 等 scope。
- 数据库兼容：旧 `benefit.db` 启动时会自动 `ALTER TABLE` 补齐新字段（platform/scopes/redirect_uris），无需手动迁移。
- Nginx 配置无需改动；仅后端代码更新 + 重启。

## 7. 已知限制 / 后续

- 验证器目前为抖音专用（`app/verifiers.py`）；接入微信/小红书需新增对应平台自动验证器并在 `app/platforms/` 注册。
- 扫码登录的 `state` 与 IdP `code` 存内存，**单机单进程**可用；多 worker 部署请改用 Redis（已在代码中集中，便于替换）。
- 多平台「统一任务墙」前端已预留 `supported_platforms` 列表，新增平台只需后端 Provider + 前端补充即可。

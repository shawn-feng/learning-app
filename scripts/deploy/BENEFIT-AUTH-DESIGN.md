# 权益认证中台（Benefit Auth Center）架构设计

> 版本：v0.1 草案（2026-08-17）
> 定位：独立的第三方认证服务，帮助 App 管理「用户完成营销任务 → 获取权益」全流程

---

## 1. 系统定位

为多个 App 提供统一认证 + 营销任务 + 权益发放能力的中台服务。App 不自己管用户认证，而是：

1. **App 注册**到中台，获得 `app_id` / `app_secret` 凭证；
2. App 在中台**创建营销任务**（如「抖音关注指定账号」→ 奖励「7 天 VIP」）；
3. **用户**在中台扫码登录（先接抖音），进入个人界面查看各 App 的任务；
4. 用户按说明**完成任务**，系统通过**验证器**确认完成；
5. 确认后**权益发放并保存**在中台；
6. App 通过**开放 API** 查询用户权益，据此向用户提供服务。

```
┌──────────┐ 注册/建任务/查权益  ┌──────────────────────┐  扫码登录/做任务/领权益  ┌────────┐
│   App A  │◄──────────────────►│   权益认证中台          │◄────────────────────►│  用户   │
│   App B  │  (app_id/secret)   │  (独立服务, 独立数据库)  │   (抖音 OAuth 登录)    │        │
└──────────┘                    └──────────────────────┘                        └────────┘
                                        │
                                        ▼
                              ┌──────────────────────┐
                              │   抖音开放平台 API      │  (自动验证: 关注/作品/授权)
                              └──────────────────────┘
```

---

## 2. 数据模型（SQLite，独立库 `benefit.db`）

### 2.1 应用与任务

| 表 | 字段 | 说明 |
|---|---|---|
| **apps** | id (uuid), app_id (唯一), app_secret (hash), name, icon_url, redirect_domains, status, created_at | 第三方应用 |
| **tasks** | id, app_id, title, description, task_type, target_config(JSON), reward_config(JSON), verify_mode(`auto`/`manual`), max_times_per_user, start_at, end_at, status, created_at | App 创建的任务 |

**task_type（任务类型，决定验证方式）**

| 类型 | 含义 | 可自动验证? | 验证器 |
|---|---|---|---|
| `follow_account` | 关注指定抖音账号 | ✅ | AutoVerifier：调抖音 `following/list` 匹配目标 open_id |
| `publish_video` | 发布带指定话题/文案的视频 | ✅ | AutoVerifier：调 `video/list` 匹配标题/话题 |
| `bind_account` | 完成平台授权绑定 | ✅ | 登录即绑定，OAuth 完成即验证通过 |
| `fans_reach` | 粉丝数达到阈值 | ✅ | AutoVerifier：调 `user/info` 检查粉丝数 |
| `like_comment` | 点赞/评论指定视频 | ⚠️ 平台无开放查询接口 | ManualVerifier：提交凭证+人工审核 |

### 2.2 用户与平台账号

| 表 | 字段 | 说明 |
|---|---|---|
| **users** | id (uuid), email(可空), phone(可空), nickname, avatar_url, status, created_at | 中台用户（可匿名，扫码登录自动创建） |
| **platform_accounts** | id, user_id, platform(`douyin`), platform_user_id(open_id), nickname, avatar_url, access_token, refresh_token, token_expires_at, bind_at | 用户绑定的平台账号（一人可绑多平台） |

### 2.3 任务实例与权益

| 表 | 字段 | 说明 |
|---|---|---|
| **task_instances** | id, task_id, user_id, status(`claimed`/`submitted`/`granted`/`rejected`/`expired`), evidence(JSON 凭证), verify_detail(JSON 验证结果), claimed_at, submitted_at, granted_at | 用户领取的任务 |
| **entitlements** | id, app_id, user_id, task_id, task_instance_id, reward_code(JSON), status(`active`/`used`/`revoked`), granted_at, used_at | 发放的权益（App 凭此兑付） |
| **reviews** | id, task_instance_id, reviewer, action(`approve`/`reject`), comment, created_at | 人工审核记录 |

---

## 3. API 清单

### 3.1 App 侧（用 `app_id` + `app_secret` 换取 `app_token`，或直接签名）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/app/token` | app_id+secret → app_token（JWT） |
| POST | `/api/app/tasks` | 创建任务 |
| GET | `/api/app/tasks` | 任务列表（含完成统计） |
| PUT | `/api/app/tasks/{id}` | 更新任务（上下架、改奖励） |
| GET | `/api/app/users/{user_id}/entitlements` | 查询某用户全部权益 |
| POST | `/api/app/entitlements/{id}/consume` | 核销权益（标记已使用） |
| POST | `/api/app/webhook/task-completed` | 任务完成回调（可选，实时通知 App） |

### 3.2 用户侧（用户 JWT）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/oauth/douyin/authorize` | 生成抖音扫码登录 URL/二维码 |
| GET | `/api/oauth/douyin/callback` | 抖音 OAuth 回调（换取 token，绑定账号） |
| GET | `/api/me` | 个人主页数据（昵称、头像、平台账号） |
| GET | `/api/me/tasks` | 各 App 的任务列表（含我已完成/可领取状态） |
| POST | `/api/me/tasks/{id}/claim` | 领取任务 |
| POST | `/api/me/tasks/{id}/submit` | 提交完成凭证（手动类任务上传链接/截图） |
| GET | `/api/me/entitlements` | 我的权益列表 |

### 3.3 网页

| 路径 | 说明 |
|---|---|
| `/` | 首页/扫码登录入口 |
| `/login` | 抖音扫码登录页 |
| `/me` | 个人界面：各应用任务信息 + 我的权益 |

---

## 4. 验证器架构（可插拔）

```python
class TaskVerifier(Protocol):
    async def verify(self, instance, account) -> VerifyResult: ...

# 自动验证器（对接抖音开放平台）
class DouyinAutoVerifier(TaskVerifier):
    # follow_account: GET /api/douyin/v1/user/following/list → 匹配 target open_id
    # publish_video:  GET /api/douyin/v1/user/video/list → 匹配标题/话题
    # fans_reach:     GET /api/douyin/v1/user/info → 检查 follower_count

# 人工审核器
class ManualReviewVerifier(TaskVerifier):
    # 保存用户提交的凭证 → 状态置 submitted → 后台审核 → grant/reject
```

- 任务创建时 `verify_mode` 决定走哪个验证器；
- 自动验证器定时（或领取后立即）调用抖音 API 校验；
- 验证结果写入 `task_instances.verify_detail`，可追溯。

---

## 5. 抖音 OAuth 流程

```
用户点击"抖音扫码登录"
  → GET /api/oauth/douyin/authorize
  → 302 到抖音: https://open.douyin.com/platform/oauth/connect?client_key=XX&response_type=code&scope=user_info&redirect_uri=https://auth.aixuexihao.top/api/oauth/douyin/callback
  → 用户扫码授权
  → 抖音回调 /api/oauth/douyin/callback?code=XX
  → 服务端用 code 换 access_token + open_id（POST /oauth/access_token/）
  → 绑定/创建用户 → 签发中台 JWT → 302 到 /me
```

**需要的抖音开发者凭证**（用户提供，写入 `.env`）：
- `DOUYIN_CLIENT_KEY`（Client Key）
- `DOUYIN_CLIENT_SECRET`（Client Secret）
- 回调域名白名单：`auth.aixuexihao.top`

---

## 6. 部署拓扑（独立服务）

```
https://auth.aixuexihao.top   ← Nginx 443 (复用 Let's Encrypt 证书)
        │  反代
  127.0.0.1:9001  ← uvicorn（systemd: benefit-auth.service）
        │
   /opt/benefit-auth/{app, benefit.db, .env}
```

- 与学习伙伴服务（8000）完全隔离：独立目录、独立数据库、独立 systemd 服务；
- DNS 新增 `auth` A 记录 → 47.96.154.226；
- 证书：certbot `--nginx -d auth.aixuexihao.top` 扩展现有证书。

---

## 7. 里程碑

| 阶段 | 内容 | 状态 |
|---|---|---|
| M1 | 架构设计 + 数据模型 + 服务骨架 | ✅ 已完成 |
| M2 | App 注册与任务管理 API | ✅ 已完成 |
| M3 | 抖音 OAuth 扫码登录 + 账号绑定 | ✅ 已完成（待配置开发者凭证） |
| M4 | 任务领取/验证器/权益发放与查询 API | ✅ 已完成 |
| M5 | 用户个人页（任务+权益） | ✅ 已完成 |
| M6 | 部署（auth.aixuexihao.top）+ 端到端验证 | ✅ 已完成 |

## 8. 待用户提供

1. **抖音开放平台开发者应用**：Client Key / Client Secret（需在抖音开放平台创建应用，配置回调域名 `https://auth.aixuexihao.top/api/oauth/douyin/callback`，写入服务器 `/opt/benefit-auth/.env` 的 `DOUYIN_CLIENT_KEY` / `DOUYIN_CLIENT_SECRET` 并重启服务）；
2. **完成 ICP 备案**：当前域名未备案，阿里云拦截公网 80 端口（HTTP 请求显示备案拦截页），443/HTTPS 不受影响；备案后 HTTP→HTTPS 跳转才能生效；
3. 首个接入 App 的**测试账号信息**（app 名称即可，可直接调用 `POST /api/app/register` 注册获得 app_id/app_secret）。

## 9. 已部署服务速查

| 项 | 值 |
|---|---|
| 服务地址 | `https://auth.aixuexihao.top` |
| 服务目录 | `/opt/benefit-auth`（数据库 `benefit.db`） |
| 端口 | 9001（仅内网，Nginx 反代） |
| systemd | `benefit-auth.service`（已 enable，开机自启） |
| 证书 | Let's Encrypt DNS-01 签发，含 www/aixuexihao.top/auth 三域名，自动续期 |
| 代码 | `benefit-auth/`（本地）→ `/opt/benefit-auth`（服务器） |
| 部署配置 | `scripts/deploy/benefit-auth.service`、`nginx-benefit-auth.conf` |

### 对接示例（App 侧）
```bash
# 1. 注册 App（获取凭证）
curl -X POST https://auth.aixuexihao.top/api/app/register \
  -H "Content-Type: application/json" -d '{"name":"我的App"}'
# → {"app_id":"app_xxx","app_secret":"xxx"}   （secret 只返回一次，妥善保存）

# 2. 创建任务（如：关注指定抖音账号，奖励 7 天 VIP）
curl -X POST https://auth.aixuexihao.top/api/app/tasks \
  -H "Authorization: Bearer <app_token>" -H "Content-Type: application/json" \
  -d '{"title":"关注官方账号","task_type":"follow_account",
       "target_config":{"target_open_id":"xxx"},"reward_config":{"type":"vip_days","days":7},
       "verify_mode":"auto"}'

# 3. 查询用户权益
curl https://auth.aixuexihao.top/api/app/users/<user_id>/entitlements \
  -H "Authorization: Bearer <app_token>"
```

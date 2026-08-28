# Benefit Auth Center · 部署记录 (v0.2)

> 部署时间：2026-08-28
> 目标实例：`i-bp15zfctbt147ktl39pk`（cn-hangzhou · Ubuntu 24.04）
> 公网：`https://auth.aixuexihao.top`（nginx → 127.0.0.1:9001）
> 方式：阿里云云助手 RunCommand（无需 SSH）+ OSS 私有桶签名 URL 中转

## 本次变更（相对 v0.1）
- 多平台底座：`app/platforms/`（Provider 抽象 + DouyinProvider + 注册表），后续微信/小红书只需新增 Provider。
- 跨平台账号关联：唯一 UUID + 登录态内绑定/解绑/列举（`/api/me/bindings`）。
- 任务模型：任务增加 `platform` 维度；新增 `repost`（转发，强制人工审核）。
- 抖音视频授权：scope 升级重授权 + `GET /api/me/{platform}/videos`（含 token 刷新）。
- 作为 learning-app 的 IdP：标准授权码流程（`/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`）+ `GET /api/app/users/{user_id}/completions`（返回用户完成任务，供 learning-app 自行判定权限）。
- DB 自动迁移：旧库启动自动补 `tasks.platform` / `platform_accounts.scopes` / `apps.redirect_uris`，无需手动迁移。
- 删除旧 `app/routers/oauth_douyin.py`，由 `app/routers/oauth.py` 取代。

## 服务器 .env 补充项（已写入，保留原 BENEFIT_JWT_SECRET）
```
PUBLIC_BASE_URL=https://auth.aixuexihao.top
COOKIE_SECURE=true
DOUYIN_CLIENT_KEY=awp5v9fq70zg7sdz
DOUYIN_CLIENT_SECRET=176006c36b9fc613bc671d3db4f19cfc
DOUYIN_API_BASE=https://open.douyin.com
```
> 抖音开放平台后台需确认：应用回调域名 `https://auth.aixuexihao.top/api/oauth/douyin/callback`，并已申请 `video.list` 等 scope（用于“网站获取用户视频”场景）。

## 验证结果（生产实跑）
| 检查 | 结果 |
|---|---|
| `GET /health`（公网/内网） | 200 |
| `GET /api/oauth/douyin/qrcode` | 200（抖音凭证已生效） |
| `GET /api/oauth/wechat/qrcode` | 404（未支持平台正确拒绝） |
| `GET /api/me`（无 token） | 401 |
| `GET /api/me/bindings`（无 token） | 401 |
| `GET /api/app/users/x/completions`（无 token） | 401 |
| DB 迁移 | tasks/platform、platform_accounts/scopes、apps/redirect_uris 均已补列；数据无损 |
| 服务状态 | active，日志 `Application startup complete`，uvicorn :9001 |

## 回滚
- 备份：`/opt/backups/benefit-auth-<ts>.tar.gz`（含 app + .env + benefit.db）
- 回滚：`tar xzf /opt/backups/benefit-auth-<ts>.tar.gz -C /opt && systemctl restart benefit-auth`

## v0.2.1 热修复（2026-08-28）：抖音白名单「授权不合法」
- 根因：①`authorize_url` 把 redirect_uri 的 `:` 编码成 `%3A`，而抖音 2023-06-12 起对「域名+path」精确比对（不标准化），编码值 ≠ 控制台配置 → 「当前链接不合法/授权不合法」；②白名单 scope 仅 `trial.whitelist`，通行做法须为 `user_info,trial.whitelist`。
- 修改：`app/platforms/base.py`（redirect_uri 改 `quote(..., safe=':/')` 原样输出 + 参数顺序对齐文档）、`app/routers/oauth.py`（白名单 scope 加 user_info；callback 按实际授予 scope 决定是否拉 user_info）。
- 部署：OSS 签名 URL（`aliyun oss sign ... --timeout 900`）+ 云助手 RunCommand（**须 `--ContentEncoding Base64`**）。备份 `/opt/backups/benefit-auth-<ts>.tar.gz`。
- 验证：`authorize_url = https://open.douyin.com/platform/oauth/connect?client_key=awp5v9fq70zg7sdz&response_type=code&scope=user_info,trial.whitelist&redirect_uri=https://auth.aixuexihao.top/api/oauth/douyin/callback&state=<服务生成>`。
- ⚠️ 用户后台必做：抖音开放平台 → 网站应用 → 设置 → 开发配置 → 授权回调地址 填完整 URL `https://auth.aixuexihao.top/api/oauth/douyin/callback`（含 path），并确认 user_info / 测试应用白名单权限已开通。

## learning-app 对接下一步
1. 在本站注册 OAuth 客户端：`POST /api/app/register`（拿 app_id/app_secret），并在 `redirect_uris` 填 learning-app 的回跳地址。
2. 前端跳转 `https://auth.aixuexihao.top/oauth/authorize?client_id=<id>&redirect_uri=<uri>&state=<state>`。
3. 用户抖音扫码登录后回跳 `?code=...`，后端 `POST /oauth/token` 换 user/app token。
4. 用 `GET /api/app/users/{user_id}/completions` 查询该用户在本站完成的任务，自行换算“时长/孩子数”等业务权限。
详见 `benefit-auth/INTEGRATION.md`。

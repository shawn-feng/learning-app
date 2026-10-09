# Benefit Auth Center · 部署记录 (v0.2)

> 部署时间：2026-08-28
> 目标实例：`i-bp15zfctbt147ktl39pk`（cn-hangzhou · Ubuntu 24.04）
> 公网：`https://auth.aixuexihao.top`（nginx → 127.0.0.1:9001）
> 方式：阿里云云助手 RunCommand（无需 SSH）+ OSS 私有桶签名 URL 中转

## v0.5 抖音经营任务对接（2026-09-28 已上线）

- **新模块 `app/business.py`**：抖音「经营任务」对接层——client_token（POST /oauth/client_token/，内存缓存）、
  活动创建/查询（POST /dy_open_api/apps/v3/activity/create/、/query/，鉴权=client_token，scope=open.business.task_manage）、
  查询用户是否完成（POST /dy_open_api/apps/v3/activity/query_activity_user_completion_status/，
  鉴权=用户级 token，scope=open.business.task_verify）。
  ⚠️ 该端点实测返回**顶层 err_no/err_msg** 形状（非文档示例的 data.error_code），解析器两种都兼容。
- **mock/live 双模式**（.env `DOUYIN_BUSINESS_TASK_MODE`，默认 mock）：经营任务能力（task_manage/task_verify）
  审批通过前为 mock——完成查询一律未完成并带 mock 标记、任务保持 claimed、不虚发权益；
  「去完成」跳转链接照常工作。审批通过后改 `live` 并重启即自动验证。
  live 接线已验证：带假 token 真调抖音返回 `err_no=28001008 access_token 过期`（端点/鉴权头/解析链路全通）。
- **验证器** `DouyinBusinessTaskVerifier`（verifiers.py）：`bt_*` 任务类型
  （bt_like 点赞 / bt_follow 关注 / bt_finish 完播 / bt_share 转发 / bt_comment 评论），
  target_config 需 activity_id + business_task_id（live）+ target_url（跳转）。
  apps.py 建任务白名单已放开 bt_*（auto 可用；like_comment/repost 仍强制 manual）。
- **新端点** `POST /api/me/tasks/{instance_id}/check`：用户跳抖音完成后回来点「我完成了」触发重验
  （领取时也会自动验一次；auto 任务专用，platform token 过期先走 refresh_token 续期）。
- **任务墙 UI**（/me）：bt_* 任务显示中文类型标签；未领取且有 target_url → 「去完成」+「领取任务」双按钮；
  claimed 态 → 「我完成了，验证」按钮（未查到完成记录弹提示，含 mock 说明）。
- **演示任务种子** `seed_demo_tasks.py`（仓库 benefit-auth/）：幂等灌 5 条 demo-bt-* 任务
  （内置演示 App app_demo_builtin），target_url 默认占位（发现页/用户搜索页），
  可 `--video-url/--user-url` 指定真实目标后重跑更新。
- **顺手修两个存量 bug（routers/me.py）**：`_auto_verify_if_possible` 把 `aiosqlite.Row` 当 dict 用
  （`task.get()` / `account.get()`）→ **领取 auto 任务必 500、自动验证从未真正跑过**（实例建出但 verify_detail 恒 '{}'）。
  现已 dict() 化。publish_video 验证路径迁到已确认的 `/oauth/video/list/`（旧路径返回 HTML 兜底页）。
- **部署**：整包 app/ + seed_demo_tasks.py（备份 /opt/backups/app-20260928-125748.tar.gz、app-20260928-125935.tar.gz）；
  OSS 签名 URL 用 Python V1 签名生成（tmp/deploy/_oss_sign.py，PUT 上传 + GET 中转），云助手 RunCommand 执行。
- **生产验证**：health 200（www/auth 双入口）、种子 5 任务落库、/me 页含新按钮、页面 JS `node --check` 通过、
  /api/me/tasks 无 token 401。**待用户真机验证**：www 扫码登录 → 看到任务列表 → 点「去完成」跳抖音。
- **切 live 前提（用户侧 P0）**：开放平台控制台申请 `open.business.task_manage` / `open.business.task_verify`
  能力 → 批准后创建真活动（activity_create），把 activity_id/business_task_id 回填任务 target_config，
  .env 加 DOUYIN_BUSINESS_TASK_MODE=live 重启。

## 每日视频互动任务机制（2026-09-21 上线，替代静态任务）

- **任务规则**：每天 00:10（ECS cron `/etc/cron.d/benefit-daily-task`）调
  `POST /api/admin/daily-task` 生成当日任务「X月X日 · 官方视频互动任务」：
  对官方抖音号当日视频完成 完播/点赞/评论/转发 **任意一项**，提交凭证**人工审核**，
  通过发放 **vip_days 7**（云端按「完成当天 +7 天、不叠加」折算进订阅）。
  任务当天 23:59 (+08:00) 过期，次日生成新任务 → 驱动每周持续做任务。
- **任务类型**：新增 `video_interact`（manual-only，见 apps.py `_TASK_TYPES`）。
- **管理端**（X-Admin-Token，值在 /opt/benefit-auth/.env 的 BENEFIT_ADMIN_TOKEN）：
  - 审核页：`https://www.aixuexihao.top/admin/reviews?token=<BENEFIT_ADMIN_TOKEN>`（书签收藏）
  - API：POST /api/admin/daily-task（幂等）｜GET /api/admin/pending-reviews｜POST /api/admin/review
- **每日视频轮换**：编辑 `/opt/benefit-auth/daily-videos.json` 的 `videos` 列表
  （按天轮换链接进任务描述）；不配置则描述为「打开官方抖音号主页看最新视频」。
- **旧任务已全部下线**（7 个：5 个 demo-bt_* 积分任务 + 绑定抖音账号 + 关注官方抖音号）；
  demo-bt_* 属内置 demo 应用 app_demo_builtin。
- 已知限制：完播/点赞/评论/转发无平台查询 API，只能人工审核（每日约 1 分钟）；
  bt_* 经营任务能力审批通过后可换自动验证（business.py 目前 mock）。
- E2E 已实测：领取→提交凭证→审核通过→7 天权益→云端折算（2026-10-07→10-14）。

## IdP 应用注册：学习伙伴（2026-09-21，配合 App 抖音扫码登录）

- `POST /api/app/register` 注册「学习伙伴」：app_id=`app_2cd2b7263372a407`，
  redirect_uri=`http://127.0.0.1:17888/callback`（Electron 本地回调）；secret 存云端/LAN server .env。
- 任务（app token 经 /api/app/tasks 创建）：绑定抖音账号(+30天,bind_account,auto)、
  关注官方抖音号(+30天,follow_account,auto,target=站长抖音 open_id)。
- 用途：App 家长端抖音扫码登录（/oauth/authorize → /oauth/token → 云端 /api/auth/douyin-login）
  + 权益门禁（云端 /api/license 每次查询经 /api/app/users/{uid}/entitlements 同步 vip_days）。
- 零代码改动，纯存量 API。

## v0.4 视频互动数据分析（2026-09-21 已上线）

- **抖音互动数据接入**（`platforms/douyin.py` + `routers/me.py`）：
  - `GET /api/me/{platform}/videos/stats?ids=a,b,c` → 每条视频的 like_count/comment_count/play_count/share_count（**POST https://open.douyin.com/video/data/**，需 scope `video.data`）。
  - `GET /api/me/{platform}/videos/{item_id}/comments?cursor=&count=` → 评论列表 + 评论者身份（**GET https://open.douyin.com/video/comment/list/**，需 scope `video.comment`）；每条与 `platform_accounts.open_id` 匹配，命中标记 `matched_user`（定位到本站用户），作者本人回复标记 `is_author`；全量幂等落库。
- **新表 `video_interactions`**（启动自动建表）：平台评论 id 主键（douyin:<cid>），存 owner_user_id / item_id / interactor_open_id / douyin_no / nickname / content / digg_count / reply_count / interacted_at / **raw（平台原始 JSON 全量留存，字段名以实际返回为准）**。
- **scope 变更**：`advanced_scopes` = video.list.bind, **video.data, video.comment**；/me 页授权升级按钮 scope 串同步（UPGRADE_SCOPES）。
- **登录即申请（2026-09-21）**：`default_scopes` = user_info, video.list.bind, video.data, video.comment——用户扫码登录时一并勾选授权（应用已正式，trial.whitelist 已移除）。⚠️ 若控制台能力未审批，抖音授权页可能报「应用scope权限不足」导致无法登录：**降级开关 = 服务器 `/opt/benefit-auth/.env` 加 `DOUYIN_LOGIN_SCOPES=user_info` 并 `systemctl restart benefit-auth`**（代码读取该环境变量覆盖默认 scope，无需回滚代码）。
- **前端 /me**：每条视频显示 ❤点赞 · 💬评论 · ▶播放；「互动明细」展开评论者（头像/昵称/内容/时间/评论获赞，标签区分「作者本人」/「本站用户」+ open_id 或抖音号），支持加载更多；未授权时提示并可一键升级授权。
- ⚠️ **前提（需用户在抖音开放平台控制台操作）**：
  1. 「管理中心 → 应用详情 → 接口权限」申请开通 **视频数据（video.data）** 与 **互动管理（video.comment）**；
  2. 开通后由视频作者账号在 /me 页点「升级授权」重新扫码（scope 含新权限）。
- ⚠️ **平台能力边界（官方文档确认）**：抖音开放平台**无「点赞用户列表」API**，点赞只能拿到视频级数量（video.data）；评论者的「抖音号」是否返回待真实数据验证，但每条评论的 open_id（本应用内稳定唯一）+ 昵称必可用于定位，原始 JSON 已全量入库可随时复核。
- 部署：整包 app/（备份 /opt/backups/app-20260921-085637.tar.gz、app-20260921-085952.tar.gz）。验证：服务 active、新表/新列自动迁移、端点 401/403 鉴权正确、假 token 探测确认两个新端点真实存在（抖音返回 2190008 access_token 非法而非 404）。

## v0.3 账号密码登录 + 绑定提示（2026-09-20 已上线）

- **新增账号注册/登录**：`POST /api/account/register` / `POST /api/account/login`（`app/routers/account.py`）。
  ⚠️ 路径**不能**用 `/api/auth/*`——nginx 把 `api/auth` 正则分流到 learning-cloud :8000（Electron 账号体系），`/api/account/*` 才会落到 9001。
- **users 表加 `password_hash` 列**（启动自动迁移，幂等；存量扫码用户该列为空、不受影响）。口令哈希 PBKDF2-HMAC-SHA256 ×120k（`security.py hash_password/verify_password`，纯 stdlib，无新依赖）。登录签发与扫码登录同一套 user JWT（72h）。
- **首页**：左右两栏布局（2026-09-20 改版）——左侧网站功能简介（统一认证/视频互动数据分析/任务中心/权益兑付），右侧登录卡片，卡片上下两段：上「账号登录」（登录/注册表单切换），下「平台账号登录」（抖音扫码，其余平台即将上线）；窄屏（≤920px）自动上下堆叠。
- **/me**：未绑定任何平台账号时顶部显示提示横幅「📹 要进行视频互动数据分析，请先绑定平台账号」+「立即绑定」按钮（走既有 mode=bind 授权弹窗）。账号用户无头像时隐藏头像位。
- 部署：整包 app/ tar.gz（排 __pycache__）→ OSS 签名 URL → 云助手（备份 /opt/backups/app-*.tar.gz → 解压覆盖 → 重启）。部署前实测服务器 15 个 app 文件 md5 与仓库 HEAD 全一致。冒烟：注册/登录/错密码 401/公网路由 400/409 均符合；冒烟用户已从库中删除。
- 回滚：`tar xzf /opt/backups/app-20260920-112236.tar.gz -C /opt/benefit-auth && systemctl restart benefit-auth`（password_hash 列保留无害，旧代码不读）。

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

# 学习伙伴云服务 · 阿里云 ECS 部署文档

> 部署时间：2026-08-17
> 实例：`i-bp15zfctbt147ktl39pk`（cn-hangzhou · Ubuntu 24.04 · 1.6G 内存）
> 公网：`https://www.aixuexihao.top`（也可用裸域 `https://aixuexihao.top`）

## 部署拓扑

```
Electron 客户端
    │  CLOUD_API_URL=https://www.aixuexihao.top（打包后默认）
    ▼
Nginx :443  (Let's Encrypt 证书，HTTP→HTTPS 301)
    │  反代
    ▼
uvicorn :8000  (systemd: learning-cloud.service)
    ▼
/opt/learning-cloud/
  ├─ app/                  # FastAPI 应用源码
  ├─ database/app.db       # SQLite 数据库（家长/订阅/同步元数据）
  ├─ storage/              # 孩子数据文件（parent_id/child_id/...）
  ├─ venv/                 # Python 3.12 虚拟环境
  └─ .env                  # JWT_SECRET（600 权限，不入库）
```

## 日常运维

| 操作 | 命令 |
|---|---|
| 查看服务状态 | `systemctl status learning-cloud` |
| 重启服务 | `systemctl restart learning-cloud` |
| 查看日志 | `tail -f /var/log/learning-cloud.log` |
| 测试证书续期 | `certbot renew --dry-run` |
| Nginx 配置检查 | `nginx -t && systemctl reload nginx` |

## 重新部署（更新代码）

```bash
# 本地打包
cd cloud-service && tar -czf /tmp/learning-cloud.tar.gz app requirements.txt
base64 -w0 /tmp/learning-cloud.tar.gz > /tmp/b64.txt

# 服务器执行（通过 aliyun CLI 云助手 RunCommand）
cd /opt/learning-cloud
echo '<base64>' | base64 -d > /tmp/app.tar.gz
tar -xzf /tmp/app.tar.gz -C /opt/learning-cloud   # 覆盖 app/
systemctl restart learning-cloud
```

### 云助手部署实操要点（2026-08-31 实测踩坑）

1. **SendFile 落盘文件名 = `--Name` 参数值**，不是源文件名。`--Name deploy-auth-py` 会写到 `<TargetDir>/deploy-auth-py`。覆盖部署时源路径要用 `--Name` 的值（如 `/tmp/deploy/deploy-auth-py`）。
2. **RunCommand 必须加 `--ContentEncoding Base64`**：`--CommandContent` 传 base64 时若不指定编码，服务器会把 base64 字符串当脚本执行，报 `File name too long`。
3. SendFile 参数是 **`--InstanceId.n`**（RepeatList），不是 `--InstanceId`（会报 MissingParameter）。
4. 查询 SendFile 结果用 `DescribeSendFileResults --InvokeId`；RunCommand 结果用 `DescribeInvocationResults --InvokeId`，Output 字段是 base64 需解码。

## 客户端配置

`electron/lib/config.ts` 的 `getCloudApiBase()`：
- 开发模式（未打包）→ `http://localhost:8000`
- 生产打包 → `https://www.aixuexihao.top`
- 环境变量 `CLOUD_API_URL` 始终优先

## 客户端版本发布（ISSUE-040，2026-08-24 起）

> 升级包托管在自有服务器 `/download/`（阿里云 2024 新规禁止新建 bucket 公共读，OSS 公共分发需控制台申请；降级方案）。

### 发布一个版本（0.1.x）

```bash
# 1. 升版本号（package.json version）
# 2. 打包（Windows：清 NODE_OPTIONS 避开 shim 拦截；输出目录用新的避免 app.asar 被 Defender 锁）
NODE_OPTIONS= npm run build
NODE_OPTIONS= npx electron-builder --win -c.directories.output=distX   # distX 用新目录

# 3. 上传到 OSS 中转 + 服务器 /download/ 覆盖（oss2 环境：.workbuddy/binaries/python/envs/default）
python scripts/publish-update.py --dist distX                    # 上传 OSS 中转（私有）
# 4. 用 oss2 sign_url 生成 3 个文件（latest.yml / Setup exe / blockmap）的签名 URL，写入 distX/signed-urls.json
# 5. 云助手 RunCommand：服务器 curl 签名 URL 覆盖 /opt/learning-cloud/download/ 下同名文件

# 6. 云端登记版本（ADMIN_TOKEN 在服务器 /opt/learning-cloud/.env）
curl -sS -X POST http://127.0.0.1:8000/api/version \
  -H "Content-Type: application/json" -H "X-Admin-Token: <ADMIN_TOKEN>" \
  -d '{"version":"0.1.x","release_date":"YYYY-MM-DD","release_notes":"...","download_url":"https://www.aixuexihao.top/download/<文件名 URL 编码>","min_version":"0.1.0"}'
```

### 客户端升级链路

- 客户端 `electron/lib/updater.ts` 运行时 `setFeedURL` 指向 `https://www.aixuexihao.top/download/`（`config.ts getUpdateFeedUrl()`，env `UPDATE_FEED_URL` 可覆盖）。
- 启动静默检查 / 家长设置页「通用设置 → 软件更新」手动检查；发现新版自动差量下载（blockmap），下载完成提示重启安装；失败降级打开 `/api/version` 的 `download_url`。
- 升级不动 userData（`%APPDATA%/学习伙伴/app-data` 在安装目录外），无需数据迁移。

## 网页认证页面（2026-08-17 新增）

| 路径 | 说明 |
|---|---|
| `/` | 域名根目录，直接展示登录页 |
| `/auth/login` | 登录页（专属认证路径，不占根路径） |
| `/auth/register` | 注册页 |
| `/me` | 个人页（当前为空壳，未登录自动跳转 `/auth/login`） |
| `GET /api/auth/me` | 认证接口，Bearer token 返回家长 id/email（网页个人页使用） |

- 网页与 Electron 客户端共用同一套账号体系（`/api/auth/*`）。
- 页面为 FastAPI 直接渲染的纯内联 HTML（`cloud-service/app/pages.py`），无外部依赖。
- token 存于浏览器 localStorage；如需更高安全可改为 httpOnly Cookie（当前为纯 JSON API，localStorage 为最简方案）。

## ⚠️ 架构合并（2026-10-09 方案A' 已上线）：单服务单库

learning-cloud（:8000）与 benefit-auth（:9001）**已合并为一个服务**：合并版跑在
**benefit-auth（:9001）**，nginx 全部流量（含原 /api/version、/api/auth、/api/license、
/api/sync、/download）已切换到 9001；**learning-cloud 已 stop+disable**（文件保留可回滚）。

- 合并内容：原 cloud-service 的认证兼容面（/api/auth/register|login|me|douyin-login|
  parent-status|set-password + /api/license，compat_parents/compat_subscriptions 表）、
  版本分发（/api/version + /download）、消息交换（/api/sync）全部并入 benefit-auth。
- 数据：learning-cloud 的 app.db 五张表已迁入 benefit.db（21 parents/22 subs/11 versions）。
- .env 合一：/opt/benefit-auth/.env 现含 JWT_SECRET（旧 cloud 会话验签）、ADMIN_TOKEN、
  DOWNLOAD_DIR=/opt/learning-cloud/download、DAILY_VIDEOS_FILE 等。
- 回滚：`systemctl stop benefit-auth && systemctl start learning-cloud benefit-auth(旧单元不可用,
  用备份目录) + nginx 9001→8000 切回`；备份在 /opt/backups/merge-20261009-112017。
- 部署方式变更：**只需部署/重启 benefit-auth 一个服务**；learning-cloud 不再部署。
- 本地仓库：cloud-service/app（合并版源码，单 app.db）；benefit-auth/app 为旧独立版（已停用）。

## 抖音扫码登录 + 权益门禁（2026-09-21 接入 benefit-auth IdP）

家长登录界面新增「抖音扫码登录」：抖音扫码 → benefit-auth 认证 → 自动找/建家长账号；
无权益的账号进入「任务门禁」页（打开中台个人中心做任务），**每次查有效期时云端自动把
新完成的任务权益折算进订阅有效期**，客户端轮询到有效后自动进主页。

```
Electron 登录页「抖音扫码登录」
  → 本地回调 http://127.0.0.1:17888/callback + 系统浏览器打开
     https://www.aixuexihao.top/oauth/authorize?client_id=<学习伙伴 app_id>
  → 扫码授权 → 302 回本地带 code
  → LAN server POST /api/v1/auth/douyin（code→benefit token→云端建号→license→会话）
  → 云端 POST /api/auth/douyin-login（localhost:9001 /oauth/userinfo 核验身份）
  → 云端 GET /api/license 每次调用：benefit-auth 拉取新权益(vip_days) → 幂等延长订阅
```

| 项 | 值 |
|---|---|
| benefit-auth 应用 | 学习伙伴 `app_2cd2b7263372a407`（secret 只存 ECS benefit-auth `.env`，不入库不入码；LAN server 免 secret 纯转发） |
| redirect_uri | `http://127.0.0.1:17888/callback`（客户端本地回调端口固定 17888） |
| 中台任务 | 绑定抖音账号(+30天,自动)、关注官方抖音号(+30天,自动)；用 app token 经 /api/app/tasks 管理 |
| 云端 .env | BENEFIT_BASE=http://127.0.0.1:9001 / BENEFIT_APP_ID / BENEFIT_APP_SECRET |
| LAN server 配置 | **无 SK**（0.5.23 起：抖音换码由云端 benefit-auth 免 secret 消费授权码，本端纯转发；client_id 公开 AK 只在客户端） |

### 登录形态简化（2026-09-21 第二批，随上一批同客户端发布）
- **中台注册界面已下线**（benefit-auth 首页只剩账号登录+抖音扫码；新用户抖音扫码自动注册）。
  后端 /api/account/register 保留但无 UI 入口。
- **App 登录页只留「抖音扫码登录」**（+服务端地址配置）；注销后再登录同样只能扫码。
- **家长中心入口弹窗只输密码**（不显示账号）：抖音家长首次进入=设置密码；
  「忘记密码？抖音扫码重置」= 输新密码→浏览器扫码确认→LAN
  `POST /api/v1/auth/douyin-reset-password`（code→benefit_user_id→云端重置）→直接进入。
- **家长中心内改密码**：设置 →「账号安全」标签（走 session 鉴权 /api/auth/set-password）。
- 云端新增：`GET /api/auth/parent-status`、`POST /api/auth/set-password`（已部署，E2E 通过）。

### 上线清单
- [x] 云端已部署（/api/auth/douyin-login + license 权益同步，E2E 实测通过 2026-09-21）
- [ ] LAN server 换新版 server.cjs（≥0.5.21，含 /api/v1/auth/douyin），201 部署须用户同意；
      systemd 或 server-config.json 配 BENEFIT_CLIENT_ID/SECRET
- [ ] 客户端发新版（登录页抖音按钮 + 任务门禁页；本地 dev 可先测）

### 降级/回滚
- 抖音登录不影响既有邮箱登录；LAN server 未配 BENEFIT_* 时 /api/v1/auth/douyin 返回 503 提示未配置。
- 云端 benefit-auth 不可达时 license 同步静默跳过（照常返回当前有效期）。
- 回滚云端：恢复备份 tar（/opt/backups/learning-cloud-app-<ts>.tar.gz）。

## 安全清单

- [x] JWT_SECRET 为 64 字符随机值，仅存服务器 `/opt/learning-cloud/.env`（600）
- [x] FastAPI 仅监听 `127.0.0.1:8000`，不直接暴露公网
- [x] 安全组仅开放 80/443（22/8001/5175 限特定 IP）
- [x] TLS 1.2/1.3，HTTP 强制跳转 HTTPS
- [x] certbot 自动续期（证书有效期至 2026-11-15）
- [ ] 数据备份策略（建议加 cron 每日备份 database/ + storage/）
- [ ] 历史数据迁移（服务器当前为空库）

## 注意事项

1. 本机 aliyun CLI 凭证（profile `learning-deploy`）为独立子账号 AK，请勿外传；如不再需要可到 RAM 控制台删除。
2. `aliyun-aksk.txt` 中的千问 QIANWEN_APPKEY 与部署无关，勿混淆。
3. 孩子数据同步接口支持大文件（Nginx `client_max_body_size 100m`）。

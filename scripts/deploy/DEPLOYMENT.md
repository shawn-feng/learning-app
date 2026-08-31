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

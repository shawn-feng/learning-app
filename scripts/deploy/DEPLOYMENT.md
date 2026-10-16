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

## learning-server 0.5.26（2026-10-10 18:02 部署 201）
- 内容：语音渠道门控（builtin=仅 TokenHub / custom=仅自配通道 / off=停用）+ ASR 改官方 asrproxy 专用端点
  （`/v1/wand/asrproxy/sync_transcribe`，`{model, data:裸base64}` 直传，hy-asr-3.0-preview，同池计费）
  + ASR 用量落库（session_file=asr）+ 配额接口四类拆分 + modelChannel 三态。
- 流程：惯例部署（备份 server.cjs.bak-* + data/backups/deploy-0.5.26-*）→ 重启 → 验证。
- 验证：version=0.5.26、asrproxy/readVoiceChannel 标记在 bundle、health ok、启动日志默认模型同步正常；
  **真机端到端**：家长 JWT 调 `/asr/transcribe`（真实语音 wav）→ 200「你好，今天天气怎么样。」；
  语音开关（asr_config.enabled）已确认为开启。

## learning-server 0.5.27（2026-10-10 21:05 部署 201）
- 内容：配额面板「今日分类消耗」改用**官方同源数据**（benefit-auth 新端点 /api/tokenhub/usage-models，
  DescribeUsageRankList Dimension=model **Period=3600 小时粒度**——日粒度聚合视图延迟大、近 24h 只出零头）；
  本地今日/近7天仅统计内置模型白名单（isTokenHubModel：deepseek-flash / deepseek-v4-flash-vision-exp /
  hy-asr-3.0-preview，兼容带/不带前缀）；分类卡官方不可得时回落本地并明确标注口径差异。
- 背景：用户反馈「分类消耗与官方已用对不上」——①本地 dev 连本地库而官方统计整个 Key（环境错位）；
  ②total_tokens 把缓存命中重复计（570万 vs 官方 280万）；③worker/考核/向量调用不落 token_usage。
  官方同源分类 + 明确标注是唯一能对上的方案。
- 验证：201 version=0.5.27；配额接口 officialCategories={text:2782528, vision:41, asr:5927}（与 CycleUsed
  差值=当前未闭合小时桶+延迟，符合预期）；本地 dev 同样验证通过。

## learning-server 0.5.28（2026-10-10 21:5x 部署 201）
- 内容：配额面板「今日分类消耗」改为**按官方模型占比把实时 CycleUsed 折算到四类**——
  总和精确等于「今日已用」（余差整数归占比最大类）。直接用 rank-list 视图永远追不上：
  该视图（日/小时粒度均）聚合滞后约 1 小时，实测分类卡一小时不动而 CycleUsed 涨 72万。
  折算说明随接口下发（officialCategoriesNote）显示在卡片角标。
- 验证：201 version=0.5.28；CycleUsed=3,586,115 vs 分类合计=3,586,115，差=0；
  本地 dev 同样验证通过。

## learning-server 0.5.29（2026-10-12 20:00 部署 201）
- 内容：**服务端 TTS 接入 TokenHub**（ISSUE-174 续）——管理端「语音合成模型」= minimax-speech-* 时，
  开放 API 语音回复走官方 MiniMax 同步合成代理 `POST /v1/wand/minimax-tts/sync_tts`
  （端点出处：DescribeModelList 的 ModelAPIInfo.Reference → 文档 /document/product/1823/135796；
  chat 网关不认语音模型，`/wand/tts/{action}` 路由存在但全 action not allowed，服务名是 minimax-tts）。
  hex 音频解码、base_resp 错误透出、rate/volume→speed/vol 夹取；仅 builtin 渠道注入家长 Key
  （custom/off → edge-tts 不烧配额）；合成失败回落 edge-tts（音频不缺席）；缓存键含模型名；
  用量 recordTtsTokenUsage（slot=tts）落库 → 配额面板「语音合成」分类有真实数据；
  isTokenHubModel 加 minimax-speech- 前缀、classifyModelCategory 加 minimax-speech→tts（原误归 text）。
  音色固定官方默认系统音色（minimax_55e81114-ce7e-4ca1，不透传设备音色参数）。indextts-2 未接入（回落 edge）。
- 验证：version=0.5.29、minimax-tts/recordTtsTokenUsage 标记在 bundle、health ok、
  startup 日志「系统默认模型已同步 … tts=minimax-speech-2.8-turbo」、家长 Key 已物化；
  本地 tsx 真网全链路（合法 MP3、官方 usage 回执）；9/9 新单测（issue174-tokenhub-tts.test.ts）。

## learning-server 0.5.30（2026-10-12 20:35 部署 201）
- 内容：**客户端朗读合成上收服务端**——新路由 `POST /api/v1/tts/synthesize`（家长 JWT，
  {text, rate?, volume?} → 二进制 24kHz MP3）。根因：app 客户端朗读本机 edge-tts 被微软 403
  拒绝（2026-10-12 实测复现，"播放没有反应"），且管理端 minimax-speech-* 只能在服务端调（Key 不出服务端）。
  渠道语义与开放 API 一致：builtin → TokenHub 合成（失败回落 edge-tts）；custom/off → edge-tts 不烧配额；
  用量 recordTtsTokenUsage 落库。配套客户端 0.1.26：electron/lib/voice/tts.ts edge 分支优先调
  /tts/synthesize（serverFetchBinary + currentSessionToken），失败回落本地 edge；web 端走浏览器
  speechSynthesis 不受影响。
- 验证：201 version=0.5.30、tts/synthesize + recordTtsTokenUsage 标记在 bundle、health ok；
  **201 真机端到端**：家长 JWT 调 /tts/synthesize → 200 audio/mpeg 45KB 合法 MP3（TokenHub minimax
  合成），同文本二发走服务端缓存；路由 5/5 + 客户端分发 3/3 + 服务端 TTS 9/9 单测全绿。

## learning-server 0.5.31（2026-10-14 09:34 部署 201）
- 内容：管理端「合成音色」同步与消费——`SystemDefaultModels` 增加 `voice`（随 model-config 下发，
  meta 恢复缺字段补默认）；`synthesizeTokenhubTts` 接收 voice 参数透传 MiniMax `voice_setting.voice_id`
  （空回落内置默认），synthesizeReply 音色进缓存键。修复：初版音色只进缓存键未透传 API 调用（测试抓住）。
- 验证：201 version=0.5.31、voice sync 标记在 bundle、health ok、startup 日志
  「…tts=minimax-speech-2.8-turbo voice=minimax_55e81114-ce7e-4ca1」；18/18 相关单测
  （含管理端音色→voice_id 透传断言）；云端 model-config 已带 voice（fix19）。

## learning-server 0.5.32（2026-10-14 10:05 部署 201）
- 内容：**音色选择移到家长端（server 端）**——用户拍板：TTS 由 app 的 server 端请求，音色应在 server 端选。
  家长端设置「AI模型」页新增「语音合成音色」下拉（存 app_settings.ttsVoice，家长级全设备生效；
  空 = 跟随管理端云端配置）。优先级：家长端显式选择 > 管理端云端 voice > 内置默认。
  server：readTtsVoice（asr/config.ts，与 readVoiceChannel 同范式）+ TtsOptions.tokenhubVoice，
  /tts/synthesize 与开放 API 语音回复两处消费。客户端 0.1.27：piSetTtsVoice IPC + web shim 同步。
  公网管理页音色下拉保留（作为云端统一默认）。
- 验证：201 version=0.5.32、readTtsVoice/tokenhubVoice 标记在 bundle、health ok；
  20/20 相关单测（家长端覆盖云端音色断言）；
  **201 真机端到端**：同文本两次合成——默认音色 46,836B / 家长端 clever_boy 94,068B，哈希不同（音色真实生效），
  测试后 app_settings 已还原。

## learning-server 0.5.33（2026-10-15 15:2x 部署 201）
- 内容：ISSUE-182 自定义定时任务 v2——①执行上下文按分配 agent 走默认上下文+全量工具（孩子任务=每孩子一轮，
  孩子基底提示词+孩子全量工具（page_* 不装配）+任务特供三件 weather/reminders/mastery，cwd=孩子工作区；
  家长任务=整任务一轮+家长全量工具含 load_skill，cwd=scratch；装配真源 buildChildAgentToolset/
  buildParentAgentToolset 从 session/parent-registry 抽出共用）；②分配目标加「家长」（assignments/task_runs
  幂等补 target_type 列 + 新表 scheduler_alerts；assign 路由 target=parent 仅 custom）；③看门狗分支
  （孩子 5min/家长 11min）；④连续失败≥2 推家长（scheduler_alerts + SSE source=scheduler_alert +
  GET /scheduler/alerts）；⑤指令模板（天气穿衣/错题复习，POST /tasks 模板分支泛化）。
  **边界：仅 type='custom' 走 v2，recording 等确定流程任务原样。**
- 流程：deploy_0533_custom_tasks_v2.py（上传→备份 bundle+数据 84M→替换→重启）+ version_fix 补部署
  （首替后 version 仍回 0.5.32——**SERVER_VERSION 是 version.ts 硬编码常量，不读 package.json，每版必拍**）。
- 验证：201 version=0.5.33、notifyCustomTaskFailure/scheduler_alerts 标记在 bundle、health ok、
  **迁移自检**：scheduler_task_assignments/task_runs 的 target_type 两列 + scheduler_alerts 表均在启动时建成；
  journal 无 error；**线上冒烟**（自签 JWT）：task-templates 三卡（mastery+天气+错题）、/scheduler/alerts 空列表、
  /scheduler/tasks 正常。单测：issue182 12 例 + 改动面 64/64 绿。
- 回滚：bundle bak-20261015-151156（0.5.32）、数据 deploy-0.5.33-20261015-151156。

## learning-server 0.5.34（2026-10-15 19:11 部署 201）
- 内容：ISSUE-183 考核朗读/背诵录音音量前置校验 + 评测最终分改各维度平均——
  ① assessment_config 新增 minVolumeNorm（考核录音最低平均音量，0-100 归一分，默认 42≈-35dBFS，0=关闭）
  + recitePassDefault（朗读/背诵通过线默认，默认 90）；无 DB 迁移（加密 JSON 内新键，旧配置读出即得默认值）；
  ② `POST /assessment/assess` 评测启用且阈值>0 时评测前对合并音频整体算平均音量（复用 16k wav 免二次
  ffmpeg），低于阈值 422 `{code:VOLUME_TOO_LOW, volumeNorm, minVolumeNorm}` 按未答拦下（拦旧客户端/绕过；
  journal 留 warn）；③ `GET /exam/config` 下发 examRules{minVolumeNorm,recitePassDefault}（孩子端 iframe
  前置校验+判分用，客户端 0.1.30 起消费）；④ aliyun-ssecp/tencent-soe 最终分=各维度平均（全缺回退综合分）；
  ⑤ recitePass 未设语义改 0（旧客户端 `Number(0)||90` 行为不变）。纯服务端改动，客户端待打包发布。
- 流程：deploy_0534_issue183.py（上传→备份 bundle+数据 85M→替换→重启→验证）。
- 验证：201 version=0.5.34、VOLUME_TOO_LOW/minVolumeNorm/examRules/dimensionMeanScore 标记在 bundle、
  health ok、journal 无 error；**线上冒烟（smoke_0534_issue183_v3.py，自签家长 JWT）**：
  配置回读默认值 42/90 → 阈值改 50 → curl 上传真实"安静"WAV（-49dBFS）→ /assessment/assess 返回
  **HTTP 422 VOLUME_TOO_LOW volumeNorm=18**（journal 同步落 warn「录音平均音量低于阈值，按未答拦下」）→
  恢复 42/90 回读一致 → 真实考核计划 `exam/config?schedule=` 返回 examRules{42,90}。
  部署前状态（enabled=true/aliyun-ssecp）已原样恢复；冒烟临时文件/测试 files 行已清理。
- 回滚：bundle bak-20261015-191124（0.5.33）、数据 deploy-0.5.34-20261015-191124（85M；磁盘 88%）。
- ⚠️ 冒烟脚本教训（记录给下次）：`(BOOT + TAIL).replace()` 的方法调用只作用于尾段字面量——模板公共段
  里的占位符不会被替换（v2 曾因此打到假家长；v1 失败退出未还原配置，v3 先恢复再测）。

## learning-server 0.5.35（2026-10-16 08:29 部署 201；首布曾误用 0.5.34 号，见末条）
- 触发：用户实测「家长 agent：创建一个定时任务，每天早上7点，对当天学习计划里的课程创建考核计划（新学考全部知识点、复习考薄弱点）」→ agent 回复**创建不了**。
- 根因：**parent-scene-automation 技能正文仍是 v1 白名单口径**——「执行会话能做的：查天气、建提醒、读写 daily；**不能碰：积分、考核、学习计划**」（ISSUE-116 v1 收窄执行器的历史产物）。
  0.5.33 已把执行会话换成全量工具，但技能/工具描述没同步；模型读完技能即按"做不到"拒答（工具描述那处经 compactParentTools 下沉后模型根本看不到，真正的口径真源=技能正文）。
- 修复：①automation 技能正文「能力白名单」整段重写为 v2「执行能力」——分配孩子=孩子 agent 全量工具（每孩子独立一轮）、
  分配家长（target="parent"）=家长 agent 全量工具（整任务一轮，按需 load_skill）、**考核/计划类自动化默认分配给家长**
  （家长建=必考、孩子建=加分项）；仍做不到的收敛为「加/扣积分、改完成态」（本无工具）+「指令必须自包含（执行时无人在线）」；
  ②`parent_scheduler_task_create` 支持 `target="parent"`（与 childName 二选一；家长分配行 child_id=家长 id + target_type='parent'，直通 0.5.33 已部署的 F2 执行分支）。
- 验证：201 version=0.5.35、health ok、service active、journal error=0；bundle md5 与本地 dist 一致（f4d6c329…），
  标记（转义感知校验）：新口径「全量工具/二选一/以家长名义建考核计划（必考）」FOUND、旧「不能碰积分」MISSING；
  **超集校验**：ISSUE-183（VOLUME_TOO_LOW/minVolumeNorm/dimensionMeanScore）与 ISSUE-182 F4（notifyCustomTaskFailure）均 KEPT——0.5.35 构建自含 ISSUE-183 已提交源码，无回退。
  单测：issue182 14/14（+2 工具用例）、issue144-parent-skills 45/45（+5 口径关键词断言）、issue144-parent-report-tools 18/18（顺带修过期断言：
  mastery_report 自 5ed0481/ISSUE-135 P5 起为 progress+plan 多场景）、issue121/123/134/149 共 41/41。
- ⚠️ **运维教训（marker grep）**：esbuild 产物把**所有非 ASCII 转义为 `\uXXXX`（大写十六进制）**——
  部署脚本里 `grep -F '中文标记'` 必然 0 命中（既非原文也非小写转义）。中文标记要么换 ASCII 词做 marker，
  要么用 node 按大写转义形式校验（`deploy_0535_automation_scope.py` 的 esc_chk 已改为后者）。
- ⚠️ **版本号撞车**：首次构建按 0.5.34 号发布（08:27），但 0.5.34 已被 ISSUE-183（10-15 19:11 部署，不含本修复）占用——
  两个不同 bundle 同号。08:29 改号 0.5.35 重新构建发布，此后 201 上的 0.5.34 字样仅存在于回滚备份。**教训：bump 前先 `git log --oneline -5` 看最新部署记录，避免与并行会话撞号**。
- 回滚：bundle bak-20261016-082700（0.5.33）+ bak-20261016-0829xx（0.5.34=ISSUE-183 无本修复）、数据 deploy-0.5.35-20261016-082936（主库+配置）。

## learning-server 0.5.36（2026-10-16 08:45 部署 201）
- 触发（用户定稿）：「定时任务与提醒的场景口径……只要按照家长要求创建定时任务就行了，并不是执行定时任务。口径里写了太多关于如何执行定时任务的事情。应该只描述如何创建目前已经有的几种定时任务。」
- 改动：`automation` 技能正文重构为**只讲创建**——新增「目前已有的几种任务」表（提醒类/天气与穿衣/错题复习/学习情况分析/考核计划类/其他：每行=指令要点+分配对象），
  参数速查、重复规则（REPEAT_RULES_BLOCK 同源）、复述确认与失败语义保留；**删除全部执行侧描述**（执行器工具面/load_skill 机制/「全量工具」；
  0.5.35 加的 ①执行能力段整体移除——那类内容会被模型当成创建门槛而拒答）。`parent_scheduler_task_create` 工具描述同步去执行侧内容。
- 验证：201 version=0.5.36、health ok、journal error=0；转义感知标记：「目前已有的几种任务/考核计划类/target="parent"/自包含」FOUND、
  「不能碰积分/全量工具」MISSING；超集校验 ISSUE-183（VOLUME_TOO_LOW…）与 ISSUE-182 F4（notifyCustomTaskFailure）KEPT。
  单测 issue144-parent-skills 等 3 文件 77/77（含新增反向守卫：执行侧词条不得回流技能正文）。
- 回滚：bundle bak-20261016-0845xx（0.5.35）、数据 deploy-0.5.36-20261016-084533（主库+配置）。

## learning-server 0.5.37（2026-10-16 08:57 部署 201）
- 背景（用户拍板方案 A + 模板处理选 (ii)）：「定时任务与提醒」口径的类型清单**以家长端「定时任务」页为准**——
  可创建四类：`recording` 每日学习记录总结 / `auto_new_session` 自动新建会话 / `mistake_sorting` 错题整理 / `custom` 自定义任务
  （三张推荐模板卡＝ custom 的预填形态，保持面板专属）；「提醒」不在可创建之列（孩子对话自建 / 写进 custom 指令）。
- 改动：①automation 技能「目前能创建的几种任务」表按上述四类重写（类型键/何时用/关键参数/分配对象），
  分配对象规则=前三类只能给孩子、custom 二选一（孩子 / target="parent"）；②`parent_scheduler_task_create` 加 `type` 参数支持四类
  （缺省 custom 兼容旧行为）：前三类禁止 target="parent"、不接受 instruction、不接受 frequency/weekday/interval/fireAt，
  `onNewSession` 仅 recording；落库字段与「定时任务」页创建路径一致（extra_json / instruction=NULL / frequency=daily）；
  ③客户端面板 custom 提示语去 v1 残留（"可查天气/建提醒/写学习记录"→"可分配给孩子或家长本人"，随下次客户端打包）。
- 验证：201 version=0.5.37、health ok、journal error=0；转义感知标记（四类标签 + 提醒说明 FOUND / 全量工具·不能碰积分 MISSING）+ ASCII 类型键 FOUND；
  超集校验 ISSUE-183 与 ISSUE-182 F4 KEPT。单测 5 文件 101/101（新增：四类创建落库断言 + buildEffectiveChildConfig 接线断言
  [recording/autoNewSession/mistakeSorting 进有效配置] + 五条约束不落行断言）；双端构建过。
- 回滚：bundle bak-20261016-0857xx（0.5.36）、数据 deploy-0.5.37-20261016-085711（主库+配置）。

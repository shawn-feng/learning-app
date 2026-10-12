# ISSUE-174：模型接入收口到腾讯云 TokenHub——每家长一个托管 API Key（配额/禁用/升配全链路实测通过，未开发）

- **类型**：需求 / 调研实测（只评估与验证 API，不做开发）
- **优先级**：中
- **记录时间**：2026-10-09

## 一、需求描述（用户原话归纳）

1. app 的模型配置**不再让用户自己配置**，内嵌腾讯云 TokenHub；
2. 文本模型用 **DeepSeek flash**；**ASR 和视觉也用 TokenHub 里的模型**（具体模型未定）；
3. 为**每一个家长用户单独创建一个 API Key**；**用户不需要知道这个 Key**；
4. app 只显示该 Key **还剩多少配额**；**不够了提醒用户购买**。

## 二、调研结论（文档评估 + 开通状态）

- **产品**：腾讯云「大模型服务平台 TokenHub」，管控 API version `2026-03-22`，管控域名 `tokenhub.tencentcloudapi.com`（全 HTTPS，接口限频 20 次/秒）；数据面 **OpenAI 兼容**：`https://tokenhub.tencentmaas.com/v1`，`Authorization: Bearer` 鉴权，可直接用 OpenAI SDK。
- **两套凭证严格区分**：
  - **管控 API**（建/删/改/查 Key）→ 云 API 密钥 SecretId/SecretKey，TC3-HMAC-SHA256 签名（v3）。本仓库 `docs/tencent-aksk.txt` 为 **CAM 子用户 `learning-app`（SubUin 100052437425）** 的密钥，已授 `QcloudTokenHubFullAccess`（文件已 gitignore，安全）；
  - **推理调用** → 管控 API 创建出来的 `sk-` API Key，下发给 app 使用（额度/模型白名单由腾讯网关强制，绕过 app 直连也逃不出限额）。
- **Key 路线选型**：普通 Key（`CreateApiKey`，按量计费）**已足够支撑全部需求**；Token Plan 企业版套餐 Key（批量建 Key/独占额度，比按量省 50%~80%）**未开通**（`DescribeTokenPlanList` 返回空），个人版套餐（28~468 元/月）仅支持 1 个 Key、每账号最多 2 个套餐，不满足多用户，排除。
- **Key 级有效期无原生参数**（CreateApiKey/ModifyTokenPlanApiKey 等均无过期时间字段）→ 若需要，用应用侧记录到期时间 + 定时 `ModifyApiKeyStatus(disable)` / `DeleteApiKey` 兜底（禁用实测 8 秒生效，可用）。

## 三、实测记录（2026-10-09，3 轮脚本全链路验证，测试 Key 已全部删除并列表归零确认）

### 通过的能力清单

| 能力 | 接口 | 实测结果 |
|---|---|---|
| 每家长一 Key | `CreateApiKey` | ✅ 创建成功（ApiKeyName/Remark/初始状态/日配额一步到位），返回 `ApiKeyId`（`ak-20261009-…`） |
| 取回明文 Key | `DescribeApiKey` | ✅ **响应含 `ApiKey` 明文字段**（`sk-`，51 字符）——服务端建完可取回下发 app，用户无需手动管理；同时返回 `QuotaSet`/`QuotaStatus`/`Uin`/`SubUin` 等 |
| 单 Key 配额 | `Quotas`（创建时） | ✅ 按日 100000 token 生效：`QuotaStatus=active`、`QuotaSet[{PkgId, CycleUnit:"d", CycleCredits, CycleUsed, StartTime, ExpireTime}]`；周期支持 `d`/`m`/`lifetime`（月周期可设起始日 1~31） |
| **在线升配** | `ModifyApiKeyInfo` + `QuotasDesired` | ✅ 实测 10 万→20 万/日即时生效（是"设置总量"非"追加"）——「不够了→购买→调额」闭环成立。⚠ 文档注：改月度起始日会删旧限额包新建、累计额度重置 |
| 禁用/启用 | `ModifyApiKeyStatus` | ✅ **禁用约 8 秒后数据面变 401**（错误码 401002「API Key 不存在」，即禁用 Key 对外如不存在）；**启用约 7 秒恢复 200** |
| 指定模型 | `BindType=model_custom_endpoint_custom` + `Bindings` | ✅ 绑定 `deepseek/deepseek-flash` 的 Key：调绑定模型 200；**调未绑定模型被拦**（400，401006）；`BindingItems` 回显 `Status:online`。⚠ 两注意：文档称 **model 绑定即将下线、推荐 endpoint 绑定**；绑定 Key 的 `/v1/models` **仍返回全量 118 个**（列表不过滤，仅调用被拦，展示层要自己过滤） |
| 删除 | `DeleteApiKey` | ✅ 删除成功，`DescribeApiKeyList` 确认归零（⚠ 响应列表字段名是 `ApiKeySet`，非文档示例的 `ApiKeyDetailList`） |
| 推理冒烟 | `POST /v1/chat/completions` | ✅ 200，响应含 `usage.total_tokens`（本轮 52 token）——**本地累加配额展示的数据源就在这** |
| 用量排行 | `DescribeUsageRankList` | ✅ 调通。参数已探明：`Dimension` ∈ `apikey/endpoint/model`（**小写**）、`StartTime/EndTime` ISO8601 带 `+08:00`、`Period` 整数秒（3600/86400），指标=Total/Input/Output/CacheToken |
| 套餐探测 | `DescribeTokenPlanList` | ✅ 返回空——企业版套餐确未开通 |

### ⚠ 两个实测约束（直接影响产品设计）

1. **用量统计到账延迟很大，`CycleUsed` 不能当实时余额**：成功调用消耗 52 token 后，`QuotaSet.CycleUsed` **8.5 分钟仍为 0**，`DescribeUsageRankList` 窗口内同样查不到（日志管道聚合，文档未承诺延迟 SLA）。
   → **「app 显示剩余配额」的正确做法**：app/服务端按推理响应里的 `usage.total_tokens` **本地累加做准实时展示**；`CycleUsed` 只作对账兜底。硬限额由腾讯网关强制扣减，不依赖展示，不会超用。
2. **模型 ID 有坑，`/v1/models` 列表 ≠ 全部可直接调用**：裸 ID（`deepseek-v4-flash`）直接调用报 400004「model or service ID does not exist」，实际可调的是 `deepseek/deepseek-flash` 这类形式。**每个模型定选型前必须实测一次**（ASR 大概率走 `/v1/audio/*` 路径而非 chat，本轮未测）。

### 模型候选（从 `/v1/models` 118 个中初筛，均未实测除标注外）

- **文本（已实测 200）**：`deepseek/deepseek-flash`（⚠ reasoning 模型，会先出 `reasoning_content`，`max_tokens` 给小了会 `finish_reason=length` 且 content 为空）
- **ASR**：`hy-asr-3.0-preview`、`wand-asr-v1`（未实测）
- **视觉**：`deepseek/deepseek-v4-flash-vision-exp`、`hy-vision-2.0-instruct`、`hunyuan-t1-vision-20250916`、`glm-5v-turbo`（未实测）

### 权限与凭证验证

- CAM 子用户 `learning-app` + `QcloudTokenHubFullAccess` → 全部管控 API 调用通过（无需主账号密钥）；
- 创建的 Key 归属 `Uin=100052436767 / SubUin=100052437425`，计费结算到该账号（按量后付费）；
- **设计待拍板**：Key 明文要嵌进 app 就必须下发（可被提取），或改走服务端代理（多一跳、但 Key 永不出服务端）。实测表明即使 Key 被提取，额度/模型白名单/禁用都在网关侧强制，风险可控——但「下发 vs 代理」要拍板。

## 四、测试产物

- 仓库根目录临时脚本（未跟踪，`_-` 前缀约定）：`_tokenhub_api_test.py`（**含 TC3-HMAC-SHA256 签名的完整实现 + 全流程用例**，开发时签名部分可直接搬进 server/cloud-service）、`_tokenhub_api_test2.py`（时延测量，第一轮有模型 ID 干扰）、`_tokenhub_api_test3.py`（修正后的最终测量）。
- 测试产生的 Key 已全部 `DeleteApiKey`（最终 `DescribeApiKeyList` 归零确认）。

## 五、后续开发要点（未实施）

1. 服务端 TokenHub 管理网关模块（签名复用测试脚本实现；密钥只放服务端）；
2. 家长 ↔ Key 映射存储（可用 Remark 存 parentId 或服务端建表，待定）；
3. 注册/购买流程：建 Key（默认日配额）→ 明文加密入库 → 下发 app（或服务端代理）；
4. 配额展示：本地按 `usage.total_tokens` 累加 + `CycleUsed` 对账；
5. 购买提醒：本地阈值 + `QuotaStatus=inactive`/网关 4xx 兜底；购买后 `ModifyApiKeyInfo` 升配；
6. ASR / 视觉模型选型实测（含调用路径验证）；
7. （可选）Key 有效期：应用侧记录 + 定时 disable；
8. （可选）成本优化：评估 Token Plan 企业版套餐（省 50%~80%）。

## ✅ 已实施（2026-10-09 当天完成开发，未部署）

**拍板三项**：默认日配额 **500 万 tokens/天**；ASR 兜底=服务端持有现有通道 Key（env）；充值=管理员人工（后台调额，ModifyApiKeyInfo 即时生效）。

### P0 技术侦查（第二轮实测，脚本 `_tokenhub_p0_spike.py`）

| 项 | 结论 |
|---|---|
| 工具调用（编程 agent） | ✅ `deepseek/deepseek-flash` 完整 tool 循环（发起→回填→终答） |
| 视觉 | ✅ `deepseek/deepseek-v4-flash-vision-exp`、`hy-vision-2.0-instruct`（标准 OpenAI image_url；**首轮 8×8 测试图被 400 拒是图片问题非接口问题**）；glm-5v-turbo 可用但 reasoning 耗尽 max_tokens 需给大 |
| ASR | ❌ **TokenHub 数据面无任何音频端点**（`/v1/audio/*`、`/asr` 全 404）→ 按拍板走 env 兜底 |
| embeddings | ✅ `kinfra-text-embedding-0.6b`（1024 维）/ `4b`（2560 维） |
| 教训 | `/v1/models` 的裸 ID 不可直调：deepseek 系必须 `deepseek/` 前缀；glm-5.3-flash 等裸 ID 可调 |

### P1 benefit-auth（Python，均已真实腾讯云验证）

- **`app/tokenhub.py`**：TC3-HMAC-SHA256 签名客户端（httpx）+ CreateApiKey/DescribeApiKey/ModifyApiKeyInfo/ModifyApiKeyStatus/DeleteApiKey 封装 + `ensure_user_key` 幂等发放（默认日配额 500 万，存 settings 键 `tokenhub_default_daily_credits` 后台可改）。
- **新表**：`tokenhub_keys`（user_id/api_key_id/api_key 明文/配额/状态）、`admin_login_challenges`。
- **用户端点**（`routers/tokenhub_routes.py`，家长 user JWT 鉴权）：`GET /api/tokenhub/key`（幂等发放+明文+配额）、`GET /api/tokenhub/quota`（DescribeApiKey 实时，60s 缓存）、`POST /api/tokenhub/key`（显式发放/调额）。
- **管理门户**（`routers/admin_portal.py`）：`/admin/login` 账密 → 生成 5 分钟挑战 → **邮件发确认链接+内嵌二维码**（QQ SMTP_SSL；链接页是 POST 表单按钮防邮件扫描器 GET 预取误触发；challenge.id 留登录浏览器、approve_token 走邮件，二者分离）→ 登录页轮询签发 8h 管理 Cookie → `/admin/tokenhub` 配额后台（总览卡：Key 数/当日总耗/异常数；行操作：**调额**/禁用/启用/删除；限流 10 次/5 分钟）。
- **邮件** `app/mail.py`：smtplib SSL，env `SMTP_USER/SMTP_AUTH_CODE`（QQ 授权码）、`ADMIN_EMAIL`（默认 79734745@qq.com）、`ADMIN_USERNAME/ADMIN_PASSWORD`（未配则门户关闭）。
- **本地验证**：真实发放（5M 配额）→ 幂等 → 调额 6M → 禁用 → 删除 全通；HTTP 层 /key、/quota、401、错误密码 401、approve→poll→Cookie→后台页 全通；无 SMTP 时报错信息明确（生产配授权码后走真实邮件）。

### P2 server（Node）

- **`packages/agent-core/src/runtime/providers.ts`**：注册 `tokenhub` provider（baseUrl `https://tokenhub.tencentmaas.com/v1`），模型=文本 `deepseek/deepseek-flash` + 视觉 `deepseek/deepseek-v4-flash-vision-exp`（deepseek reasoning compat），声明 embedding `kinfra-text-embedding-0.6b`（1024 维，`EMBEDDING_PROVIDER_PRIORITY` 追加）；**兜底常量切 tokenhub**。
- **模型选择收口**（`runtime/index.ts` + `programming-agent.ts`）：`defaultModel/visionModel/programmingModel` **仅当指向 tokenhub 时生效**，旧 provider 遗留配置忽略不删（可回滚）。
- **`server/src/auth/tokenhub.ts`（新）**：Key 物化——`ensureParentTokenHubKey` 凭家长 `parents.cloud_token` 调云端 `/api/tokenhub/key`，**每轮比对刷新**（管理员删除重建 Key 后本地自动轮换；同值跳过防 revision 抖动）合并进加密 auth 封套；触发=启动 15s 后 + 每 5 分钟后台循环（存量用户覆盖）+ 登录成功钩子（`routes/auth.ts` login/register/douyin）+ `GET /models/settings` 懒触发；401 告警每家长每小时至多一条。
- **`GET /api/v1/models`** 只下发 tokenhub 模型（设置页下拉自然收敛）。
- **ASR**：`asr/config.ts` `getTranscribeCandidates` 增加服务端 env 兜底（`ASR_FALLBACK_DASHSCOPE_KEY` 优先 / `ASR_FALLBACK_MIMO_KEY`）——家长配置过旧通道仍优先，全未配置走兜底，用户零配置。
- **`GET /api/v1/tokenhub/quota`**（家长 JWT）：云端官方口径（remote，标注延迟）+ 本地 token_usage 今日/近 7 天（准实时）+ 模型信息。
- 构建：`npm run build` ✅（server.cjs 0.5.23，23.8MB）；tsc 仅剩 topic-package.ts 既有遗留错误（与本issue无关）。

### P3 客户端（Electron + web shim，双端构建 ✅）

- **Settings「模型配置」→「模型服务」**：删 8 个 provider chip/Key 录入/打码回显/连通性检测，换「已接入 TokenHub」状态卡 +「查看配额」入口；模型「设为默认」与编程 agent 下拉保留但只列 TokenHub 模型。
- **新增「大模型配额」tab**（`TokenHubQuotaPanel.tsx`）：今日额度进度条（剩余=max(配额−max(官方已用,本地今日),0) 保守展示）、官方统计标注延迟、额度耗尽红条/不足 10% 黄条（「请联系管理员充值」）、近 7 天本地用量表。
- **「语音配置」简化**：ASR 收敛为「启用开关」（系统统一提供，不再有 4 通道 Key 录入）；TTS 收敛为 Edge TTS（免费不耗配额）+ 音色选择。
- **主页低额度横幅**：官方口径 inactive/剩余<10% 时顶部红/黄横幅，点击进家长中心。
- 通道：`tokenhubQuotaGet`（preload `tokenhub:quota` / ipc / web shim models 域）；旧 `piSetApiKey` 等 IPC 保留（兼容旧客户端）。

### 回归

- 新增 `test/issue174-tokenhub.test.ts` 9 例全绿（provider 注册/兜底常量、模型收口四态、封套合并+同值跳过+轮换更新、quota 路由聚合+401+不泄明文）。
- 相邻回归：issue126-model-sync + issue163-key-mask 13 例、issue165-asr-config + qwen-asr + open-voice + verify-config 27 例，全绿。

### ⏳ 部署清单（未执行）

1. 服务器 `/opt/benefit-auth/.env` 补：`TOKENHUB_SECRET_ID/SECRET_KEY`（docs/tencent-aksk.txt）、`ADMIN_USERNAME/ADMIN_PASSWORD`、`SMTP_USER/SMTP_AUTH_CODE`（QQ 授权码）→ 部署 benefit-auth → 验证两步登录 + 后台。
2. server 0.5.23 部署 201 → 观察启动日志 `[tokenhub] startup: 扫描 N 位家长`。
3. 客户端（Settings/语音/配额/横幅）随下个客户端包发布（旧客户端兼容：服务端未下发旧 provider 模型列表但旧 Key 仍可用）。
4. env `ASR_FALLBACK_DASHSCOPE_KEY`（需用户提供一把 DashScope key）配在 201。

## 🔄 用户调整（2026-10-09 当天第二轮，已实施）

用户拍板三处调整，均已实现并验证：

1. **管理员凭证页面化**：不再依赖 env——init_db 播种 `admin_username=79734745@qq.com` / 密码 `123456`（PBKDF2 存 settings 表），后台新增「修改管理员密码」面板（旧密码校验，≥6 位）；env 仅作首次种子值。
2. **SMTP 授权码页面配置**：settings 键 `smtp_user/smtp_auth_code`（DB 优先，env 兜底）；后台新增「邮箱验证（SMTP）」面板（发件邮箱+授权码+保存+**发送测试邮件**，打码回显 `abcd****mnop`）；**未配置 SMTP 时登录降级单因素**（账密直进+后台黄色横幅提醒去配置）——解决「先配 SMTP 才能登录、登录才能配 SMTP」的死锁。
3. **保留自定义模型渠道**：撤销「仅 tokenhub 生效」的收口——`resolveConfiguredModelKey`：defaultModel/visionModel/programmingModel 指向 **tokenhub 恒生效（无需 Key）**，指向自定义 provider 时**只要 auth 封套有对应 Key 即生效**，否则回落 TokenHub 默认；6 处 pick 调用点补传 auth（session/parent-registry、exam-engine、model-sync、vision、worker/tasks）+ programming-agent；`GET /models` 恢复全量 provider。
   - 客户端设置页改为**双标签**：「大模型 (TokenHub)」独立标签（状态卡+TokenHub 模型设默认，无需任何 Key）+「自定义模型」标签（恢复原 8 provider chips/Key 录入/打码回显/逐 provider 模型列表设默认/编程 agent 下拉含全部模型）。
- **验证**：benefit-auth TestClient 全流程（种子直进 200+cookie、错误密码 401、SMTP 保存→db 来源+打码、测试邮件失败报错明确、有 SMTP 后登录切挑战流、改密后旧密 401 新密走到发信步）；server tsc（仅剩 topic-package 既有遗留）+ 构建 ✅；issue174+126+163+165 28 例回归全绿；electron/web 构建过。
- **部署清单更新**：服务器 env 只需 `TOKENHUB_SECRET_ID/SECRET_KEY`（+201 的 `ASR_FALLBACK_DASHSCOPE_KEY`）；管理员密码与 SMTP 授权码部署后在 `https://auth.aixuexihao.top/admin/login`（79734745@qq.com/123456）页面里配置/修改。

## 🔄 管理后台重构（2026-10-09 第三轮，已部署生产）

用户拍板重设计：分类菜单 + TokenHub 凭证页面化 + 验证码式二次验证。

- **侧边菜单布局**：`🧊 TokenHub`（凭证配置 + Key 列表/调额/禁用/删除）与 `🔒 安全设置`（改密 + SMTP）两个菜单，客户端 JS 切换页面。
- **TokenHub ak/sk 页面化**：settings 键 `tokenhub_ak/tokenhub_sk`（DB 优先 env 兜底）；`tokenhub.py` 增加 `set_runtime_config/get_config` 运行时覆盖，所有管控调用点（发放/配额/列表/测试）前置同步；状态显示 SecretId 打码（`AKIDwvuu****Bwvm`）+「测试连通」按钮（DescribeApiKeyList 实测返回 Key 总数）。
- **Key 打码收紧**：管理列表改 `mask_key_prefix`（只显示前 10 位 + `****`，无后缀），页面注明"绝不回显完整 Key"。
- **二次验证改验证码式**：账密通过 → 邮箱发 **6 位验证码**（5 分钟有效，复用挑战表 approve_token 列存码）→ 登录页输入验证码 → 同浏览器直接签发 Cookie（`POST /api/admin-portal/verify`）；错 5 次作废重来；已用挑战 404 不可复用。原链接/扫码 approve 流程移除。**SMTP 一旦配置即默认启用验证码二次验证**；未配置降级单因素 + 横幅提醒（规则确认）。
- 顺带修两个历史 bug：后台 JS 裸变量引用元素 id（smtp-user 等带连字符不生成全局变量 → 保存无反应）；邮件中文 preamble 裸输出致 `smtplib` ASCII 编码炸（改 ASCII preamble）。
- **验证**：本地 TestClient 全流程（直进/验证码收发/错码 5 次作废/复用 404/凭证保存打码/真实连通测试/菜单页渲染）全过；生产部署 fix3 后公网登录返回「账号或密码错误」= 用户已自行改密（预期行为），后台页 303 跳登录正常。

## 🔄 客户端设置页合并（2026-10-09 第四轮，已构建）

用户拍板：「大模型配额」不单独设标签（配额直接显示在 AI 模型页里）；视觉/语音配置并入自定义模型；标签名改「AI模型」。

- Settings 标签精简：`大模型 (TokenHub)` → **`AI模型`**（= TokenHub 状态卡 + **配额面板内嵌**（TokenHubQuotaPanel 去独立外壳改小节标题「配额使用情况」）+ TokenHub 可用模型）；删除 `大模型配额`/`视觉配置`/`语音配置` 三个标签。
- 「自定义模型」标签底部追加 **视觉模型**（VisionSettings）与 **语音**（VoiceSettings）两个小节——自定义渠道一页完成 Key/默认/视觉/语音全部设置。
- electron + web 构建通过；随下个客户端包发布。

## 🔄 默认模型四下拉（2026-10-10 第五轮，benefit-auth 已部署生产）

用户需求：管理后台可配置「默认创建的 Key 使用的模型」四类——文本/视觉/语音转录/语音合成，各一个下拉；app 服务端读取配置应用到对应模块。

- **benefit-auth**（已部署）：settings `default_models` JSON（内置默认 = deepseek/deepseek-flash + deepseek-v4-flash-vision-exp + qwen-audio-3.0-asr-flash + edge-tts）；后台 TokenHub 菜单新增「🎛️ 默认模型」四下拉（含策划清单：已实测/当前可用/预留 标注）；公开只读端点 `GET /api/tokenhub/model-config`（仅模型名）。
- **建 Key 绑定**：`ensure_user_key` 新发放的 Key 绑定 text+vision 默认模型 + **恒含 embedding 模型**（kinfra-text-embedding-0.6b——向量检索同 Key 调 /embeddings，只绑 text/vision 会把它拦掉）；带绑定创建失败自动回落 BindType=all（失败开放）。生产实测：公网发放的 Key BindingItems 三项全 online。
- **普通 Key 绑定不可后改**（ModifyApiKeyInfo 无 Bindings 参数，已核对文档）→ 改默认模型只影响**新发放**的 Key；存量 Key 改模型 = 后台删除（重建时带新绑定），server 物化循环 5 分钟内自动轮换本地封套。
- **server 消费**（server.cjs 已构建，**随 201 下次部署生效**）：同步循环每轮拉取 model-config → 内存缓存 + meta `tokenhub_model_config` 持久（离线启动仍有值）；`getSystemDefaultModels()` 输出完整模型键；agent-core `pickWorkerModel/pickVisionModel` 增加第 4 参 `systemDefault`，优先级 = 用户选择（tokenhub 恒可用/自定义需 Key）→ 管理端默认 → 内置常量；6 处调用点 + programming-agent 接入；ASR `transcribeQwen/Mimo` 增加模型覆盖参数（管理端选的 ASR 模型与通道前缀匹配时生效，如 qwen-audio-* → qwen 通道）；TTS 非 edge-tts 选项为预留——选中告警一次并继续用 edge-tts。
- **约束重申**：语音两类模型受「TokenHub 数据面无音频端点」限制——下拉里 TokenHub ASR/TTS 项为预留，当前可用项只有 DashScope ASR（需 201 配 `ASR_FALLBACK_DASHSCOPE_KEY`）与 Edge TTS。
- 回归：issue174+126+165 24 例全绿；tsc 干净；server 0.5.23 构建过。

## 🔄 批量轮换（2026-10-10 第六轮，已部署生产）

用户需求：管理端更换默认模型（text/vision）→ **批量轮换所有存量 Key**，且**继承旧 Key 剩余配额**。

- **触发**：`POST /api/admin-portal/tokenhub/models` diff 出 text/vision 变化时自动执行 `rotate_all_keys`（前端 confirm 确认 + 显示成功/失败计数）；后台行操作新增「轮换」按钮支持单 Key 手动轮换（`POST /api/admin-portal/tokenhub/rotate`，30 分钟窗口内拒绝重复轮换）。
- **单个轮换 `rotate_user_key`**：① Describe 旧 Key 取剩余量（不可达则按原档位）② 建新 Key（绑定**新**默认 text/vision + 恒含 embedding；当期配额 = **继承的剩余量**）③ DB 行原子指向新 Key ④ 旧 Key 记 `pending_delete_key_id` 延迟回收。**双 Key 平滑**：先建新并入库，server 物化循环 5 分钟内自动切换，30 分钟窗口后才删旧 Key——家长零断服。
- **档位恢复**：新 Key 当期配额=剩余量会导致"全员降档到当天剩余"，故原档位记 `pending_restore_credits` + `restore_after_date=轮换次日`；后台 `restore_loop`（每 5 分钟，main.py startup 启动）次日把腾讯侧配额调回原档位（ModifyApiKeyInfo 即时生效）并清标记。
- **DB**：tokenhub_keys 加 4 列（pending_restore_credits/restore_after_date/pending_delete_key_id/rotated_at），_migrate 幂等补列。
- **验证**（真实腾讯云 + 桩单测）：改 text=glm-5.3-flash → rotatedCount=1、新 Key 绑定 [glm-5.3-flash, vision, embedding] 全 online、继承剩余 300 万精确落账、旧 Key 30 分钟窗口后真实删除；桩单测验证"已用 200 万/档位 500 万 → 继承剩余 300 万 + pending_restore=500 万 + 次日恢复调回"全对。
- **语义注意**：当天剩余继承 → 当天可用量不变；原档位次日恢复。改 asr/tts 下拉不触发轮换（不参与 Key 绑定），server 实时生效。

## ✅ server 0.5.23 已部署 201（2026-10-10 12:16，TokenHub 消费链路生产打通）

- 部署：本地 dist/server.cjs（38 处 tokenhub 标记）→ scp → 备份 `server.cjs.bak-fix8-20261010-121557` → 重启 learning-server，svc active。
- **启动即生产验证**：
  - `[tokenhub] startup: 系统默认模型已同步 text=tokenhub/deepseek/deepseek-flash vision=tokenhub/deepseek/deepseek-v4-flash-vision-exp asr=hy-asr-3.0-preview tts=edge-tts`（云端四下拉实时配置拉通）
  - `[tokenhub] 已物化家长 86a84278… 的 TokenHub Key（ak-20261010-0587…）`+ `startup: 扫描 1 位家长，新物化/更新 1`——存量家长经 cloud_token 向 benefit-auth 自动换取真实 Key 并写入加密封套 ✓
- ⚠️ 注意：云端「语音转录」默认当前被保存为预留项 `hy-asr-3.0-preview`（不可用）——服务端模型覆盖与通道前缀不匹配时自动忽略、用通道内置模型，不会坏；建议在管理页把 ASR 改回「千问 ASR Flash（当前可用）」。
- 待办：① 201 env `ASR_FALLBACK_DASHSCOPE_KEY`（零配置家庭的 ASR 兜底，需用户提供 DashScope key）；② 客户端重打包（AI模型/配额/用户管理前台）。

## ⚠️ 更正（2026-10-10）：「语音转录无音频端点」结论修正为「可经对话接口调用，卡在计费」

用户对「模型列表里有 ASR 却说不能用」提出质疑，补做探针推翻了原结论：

- **原结论（错）**：TokenHub 数据面无音频端点，ASR 不可用。依据是 `/v1/audio/*` 专用路由 404。
- **补测事实**：`POST /v1/chat/completions` + `input_audio` 内容块（OpenAI 多模态音频样式，data URL wav）喂给
  `hy-asr-3.0-preview` / `wand-asr-v1` → 返回 **402/401007「无免费试用额度且按量付费未开通」**——
  路由与模型路由都通，**卡在账号级计费**（控制台为语音模型开通后付费/领试用即解）。
- **已实施**：server ASR 链路新增 TokenHub 通道（chat+input_audio，家长托管 Key，额度同池），排在已配置通道之后、env 兜底之前；402/未开通自动回落 DashScope env 或家长已配通道。管理端「语音转录」下拉选 TokenHub 模型（hy-asr-3.0-preview/wand-asr-v1）即走此通道。已部署 201。
- 用户操作：到 TokenHub 控制台为语音模型开通后付费（或领取试用额度）后，管理页保持选 TokenHub ASR 模型即自动生效。

## 🎛️ 第五轮调整（2026-10-10 下午，已全部实施并部署：渠道开关 + 配额四类拆分）

用户三条新需求与落地：

1. **AI模型页极简**：不再说明模型来源、不再列模型让用户选默认——只留「启用开关 + 配额面板」。
2. **配额按模型类别拆分**（问腾讯 API 是否支持）——**实测支持**：`DescribeUsageRankList` `Dimension=model`
   返回每模型 Input/Output/Cache/TotalToken 按日序列（默认 top8，无分页参数；**账号整体口径**，
   所有用户 Key 合并、分钟级延迟，不能按家长拆）。落地双口径：
   - 家长端（实时）：本地 token_usage 按 `model` 列归类（`classifyModelCategory`：tts→asr/audio/sensevoice→
     vision/-vl/-5v/4v→其余 text），`GET /tokenhub/quota` 新增 `local.categories{today,byDay}`，
     配额面板展示「今日分类消耗」四卡 + 近 7 天表加 文本/视觉/语音识别 列。
   - 管理端（官方）：TokenHub 菜单新增「📊 按模型用量（官方口径·账号整体）」卡（1/7/14/30 天）。
3. **自定义模型开关与内置互斥**：`app_settings.modelChannel` 三态 **builtin**（默认，只用内置 TokenHub）/
   **custom**（只用自定义 provider）/ **off**（全停）。两 tab 各一面板开关镜像同一状态（开一个自动关另一个）。
   核心收口在 `resolveConfiguredModelKey(key, auth, channel)`（builtin 只认 tokenhub；custom 只认已配 Key 的
   自定义）+ `firstCustomModelKey`（custom 无默认时回落注册表序第一个已配 Key provider 的首模型，
   视觉要求 image 输入）；pickWorkerModel/pickVisionModel 渠道内解析，off/custom 无可用模型抛可读错误
   （model-sync catch → 本轮不发送）。编程 agent 同链路（resolveModelChannel + 渠道池解析）。
   ⚠️ 语义变化：旧「builtin 下自定义默认生效」被本互斥取代（存量自定义默认配置保留但不再生效，开 custom 即恢复）。
4. **ASR 用量落库**：TokenHub 语音识别与文本同池但无 agent 会话——`transcribeTokenhub` 等三个 provider 改返回
   `{text, usage}`（解析响应 usage），转录成功后 `recordAsrTokenUsage` 补一行 `session_file="asr", slot="asr"`；
   仅 TokenHub 通道记录（其他通道不消耗该配额）。TTS=edge-tts 免费，面板标注「不计配额」。

- 测试：`test/issue174-model-channel.test.ts` 新 9 例（渠道解析/渠道池/抛错/分类/落库/路由聚合）+
  issue174-tokenhub 更新到互斥语义（含「builtin 即使已配 Key 也忽略自定义」回归），20/20 绿；
  qwen-asr 8 例随返回结构同步。全量套件仅 4 个存量失败（parent-library/issue144/issue160/kb-sqlite
  ——均为并行未提交工作或真实数据依赖，与本次无关）。
- 部署：**server 0.5.24 → 201**（modelChannel/categories 标记在 bundle，启动日志正常：默认模型同步 +
  扫描 1 位家长物化 0 更新）；**benefit-auth fix11 → 云端**（usage_by_models 真实 API 验证 top8 返回 +
  管理卡上线，svc active）。注意：`SERVER_VERSION` 硬编码在 `routes/version.ts`，package.json 升版须同步。
- 待用户：客户端重打包发布（0.1.24 含本轮设置页改版）。

## 🎙️ 语音页按用户要求恢复自配 + TTS 引擎化（2026-10-10 傍晚，已部署）

- **ASR 候选链 bug 修复**：TokenHub 候选被重复注入 3 次（config.ts 循环 + 尾部 unshift + transcribe.ts 再 unshift）且 config.ts 那份 creds 不带封套 Key（必败一次请求）；收敛为「TokenHub 首位（带封套真实 Key）→ 家长默认通道 → 其余已配通道 → env 兜底」，issue165 增回归例。
- **语音输入恢复自配**（用户问「为什么不能自己配」——上轮零配置简化撤了 UI，链路本支持）：语音配置页恢复四通道 Key 录入（千问按量/套餐、MiMo 按量/套餐，打码回显、留空=自动复用自定义模型同厂商 Key），开关与链路说明保留。
- **TTS 去音色、加引擎**（用户拍板「不要选音色，用默认；但要能选其他 TTS 模型」）：朗读音色下拉删除，改引擎下拉（Edge 默认免费 / 千问 qwen3-tts-flash / MiMo mimo-v2.5-tts 各按量与套餐，未配 Key 的选项标注）；tts.ts 给 qwen/MiMo 补默认音色（原无音色直接抛错）；切引擎自动清已存音色。
- **本地 dev 实测**（解密 dev 库）：语音开关当前=关；开则 TokenHub（sk-Tbd****I5EK）402 回落 → 实际走千问按量（复用自定义模型 qwen Key）。201 env `ASR_FALLBACK_DASHSCOPE_KEY` 仍待用户提供。
- 部署：server 0.5.25 → 201（含并行会话 03dc9d3 开放API TTS 特性，与其声明部署基线一致）；本地 dev server 已重启同版。

## 🗣️ 语音跟随 AI 模型开关（2026-10-10 晚，用户拍板 + 本地已验证）

- **语义**：开启 AI 模型（builtin）→ 语音**仅**走 TokenHub；启用自定义模型（custom）→ 语音**仅**走自配通道（千问/MiMo，Key 留空复用自定义模型同厂商 Key）；off → 语音不可用。ASR 渠道门控在 server `readVoiceChannel`+`getTranscribeCandidates(channel)`；TTS 在 electron（切渠道时 pi:set_model_channel 自动把 tts provider 锁回 edge-tts，自定义模式下用户可选千问/MiMo 引擎）。
- **实测（本地 dev，真实语音 SAPI wav）**：custom 渠道转录 200「你好，今天天气怎么样。」（千问按量，复用自定义模型 Key）；builtin 渠道 → TokenHub wand-asr-v1 → **400 401006 模型未绑定**。
- **关键实测结论**：①`hy-asr-3.0-preview` 已从 TokenHub 服务列表**下线**（全模型 Key 也 400，不可再用）；②`wand-asr-v1` 路由可用，**用户已开通后付费**（402→绑定问题）；③托管 Key 绑定表只有 text/vision/embedding → 调语音被 401006 拦 → **需 benefit-auth 把 ASR 模型纳入建 Key 绑定 + 轮换存量 Key**（代码已备好：ensure_user_key 绑定 admin ASR 下拉（hy-asr 自动换 wand-asr-v1），管理页 ASR 下拉已修正——**未部署**，等用户拍板）。
- TokenHub TTS：无 /v1/audio/speech 端点，但 minimax-speech-02-turbo 等可经 chat+audio 模态调用（402=未开通计费，开通后可接入）。
- 本地状态：语音开关已开启；modelChannel=builtin；dev server 已重启（0.5.25 含渠道门控）。201/云端本轮未动。

## 💳 fix12 部署 + 批量轮换 + 暴露账号级试用耗尽（2026-10-10 晚，用户拍板"现在做"）

- 已部署 benefit-auth fix12（ensure_user_key/rotate_user_key 追加 ASR 绑定，hy-asr 自动换 wand-asr-v1；管理页 ASR 下拉修正）+ 云端 default_models.asr→wand-asr-v1 + rotate_all_keys（2 Key 全轮换成功、配额继承、旧 Key 定时回收）。绑定验证：两把新 Key 均含 wand-asr-v1。
- **关键发现（新旧 Key 一致，非轮换引入）**：`deepseek/deepseek-flash` 文本调用 402 401008「免费试用额度耗尽+后付费未开通」——此前账号一直跑免费试用，当日下午耗尽。**内置模式文本/视觉/语音全部等控制台开通后付费**；孩子端当前文本也会报配额错误（model-sync friendlyModelError 有可读提示）。
- wand-asr-v1 开通后反而 400「模型或服务不存在」（开通前 402）——所有 Key（含全模型探针）一致，多次重试稳定复现；需用户在控制台「在线推理服务列表」核对该服务状态与确切 ID。
- 本地端到端：custom 渠道语音 200 出文本（千问复用自定义模型 Key）；builtin 渠道管道正确（报错带引导）。

## 🔁 fix14：Key 改回全模型 + ASR 定版 hy-asr（2026-10-10 晚）

- 用户开通文本/语音后付费后实测：文本/视觉 200 ✅；**wand-asr-v1 网关下线**（400，弃用）；**hy-asr-3.0-preview 路由正常但开启后付费后同样 400「不存在」**——腾讯「语音服务开启后付费即坏」模式，与 wand 同款，需工单/控制台核对。
- 按模型 ID 绑定会破坏语音路由（绑定的 Key 400「不存在」，全模型 Key 402/200 正常）→ **fix14：家长 Key 改回 BindType=all + Quotas**（调用全由服务端发起，无暴露）。CreateApiKey 的 BindType 必填。
- 本地端到端现状：custom 语音 ✅（千问出文本）；builtin 文本 ✅ 200；builtin 语音 ✅管道正确、等腾讯侧修复 hy-asr 即通。

## ✅ 语音（内置 TokenHub）全线打通——asrproxy data 直传（2026-10-10 晚，fix16）

- 用户提供官方文档破案：ASR 专用端点 `/v1/wand/asrproxy/sync_transcribe`（异步 async_create/tasks 备选），请求 `{model, data:裸base64}` 或 `{model, input_url}` 二选一；同步回 `output.text` + `usage.total_tokens`。**此前 chat/completions 路由上的 400/402 全是误导（语音根本不在 chat 网关）**。
- 曾按 input_url 做过 benefit-auth 音频中转（fix15），用户明确否决（语音文件不得过云端）→ **fix16 撤销中转**，server `transcribeTokenhub` 直接 `{model, data: wav.base64}` 直传。
- 本地端到端（真实语音）：builtin 200「你好，今天天气怎么样。」（72 tokens，与文本同池）；custom 200（千问）；usage 落库 session_file=asr slot=asr → 配额面板「语音识别」分类出真实数据。23/23 测试绿。
- 注意：201 服务器还是旧 chat 路由实现，builtin 语音在其上不可用——部署最新 server 包后即通（用户暂缓 201 部署）。

## 🔊 服务端 TTS 接入 TokenHub（minimax-speech-* 系，2026-10-12）

- 用户在管理页选了 minimax-speech-2.8-turbo → 要求 server 端真正可用（此前分发点只告警回落 edge-tts）。
- **端点侦破**：chat/completions 不认语音模型（与 ASR 同款误导）；`/wand/tts/{action}` 路由存在但全部 action "not allowed"（服务名猜错）。真源 = 模型条目 `DescribeModelList.ModelSet[].ModelAPIInfo.Reference` 指向官方文档 **/document/product/1823/135796**：`POST /v1/wand/minimax-tts/sync_tts`，`{model, text, voice_setting:{voice_id,speed,vol,pitch}, audio_setting:{sample_rate,bitrate,format,channel}, output_format:"hex"|"url"}` → `{data:{audio:<hex>,status:2}, base_resp:{status_code}, usage:{total_tokens}}`。不支持流式。实测 2.8-turbo：59KB MP3/24kHz、820 tokens（41 字）。
- **实现**（server 0.5.29）：tts/index.ts 加 `pickTtsPlan`（minimax-speech-* 且有家长 Key → tokenhub）+ `synthesizeTokenhubTts`（hex→Buffer、base_resp 错误透出、rate/volume→speed/vol 夹取）；synthesizeReply 先查缓存（缓存键含模型）再合成，tokenhub 失败回落 edge-tts（回复音频不缺席）；open-api synthReplyAudio 仅 builtin 渠道注入家长 Key（custom/off → edge，不烧配额），用量 `recordTtsTokenUsage`（slot=tts）落库 → 配额面板「语音合成」分类出真实数据。isTokenHubModel 加 minimax-speech- 前缀；classifyModelCategory 加 minimax-speech→tts（原会误归 text）。
- 音色：固定官方示例系统音色 minimax_55e81114-ce7e-4ca1（MiniMax 音色体系与 edge 不同，设备 voice 参数不透传）；24kHz mp3 与 edge 原生一致，sampleRate 重采样路径复用。
- indextts-2 未接入（另一 API 形态）——管理页选中仍告警回落 edge；接入后在 pickTtsPlan 加分支即可。
- 验证：9/9 新单测（issue174-tokenhub-tts.test.ts，stub fetch/EdgeTTS）+ tsx 真网全链路（合法 MP3、540 tokens）+ 云端 model-config 确认下发 tts=minimax-speech-2.8-turbo。存量失败（open-voice 真网 2 例、kb 真实数据等）经 stash 对照确认为既有环境问题。

## 📣 客户端朗读静默根因 + 修复（server 0.5.30 / client 0.1.26，2026-10-12）

- 用户反馈 201 上"app 客户端播放没反应"：**两条 TTS 链路**——我接的 minimax 只在服务端开放 API
  （ESP32）；app 客户端朗读走 electron 本地 edge-tts，且 builtin 渠道锁死 edge-tts。本机实测
  **edge-tts 被微软 403 拒绝**（Unexpected server response: 403）→ 静默无声音。
- 修复：server 新路由 `POST /api/v1/tts/synthesize`（家长 JWT；builtin→TokenHub/回落 edge，
  custom/off→edge 不烧配额；用量落库 slot=tts）；客户端 tts.ts edge 分支优先 serverFetchBinary
  （动态 import 避免循环依赖），失败回落本地 edge；web 端浏览器 speechSynthesis 不受影响。
- 201 真机 e2e：家长 JWT → 200 audio/mpeg 45KB MP3；缓存二发 200。客户端 0.1.26 安装包已出
  （dist/学习伙伴 Setup 0.1.26.exe），**旧客户端需升级才有修复**。
- 测试：test/issue174-tts-route.test.ts 5/5（fastify inject：鉴权/渠道/回落/缓存/rate 透传）+
  test/issue174-tts-client.test.ts 3/3（server 优先/回落/自定义 provider 不走 server）。
  注意 light-my-request 二进制响应在 `body` 不在 `rawBody`；fastify 需从 server/node_modules 解析
  （createRequire(path.resolve("server/src/index.ts"))）。

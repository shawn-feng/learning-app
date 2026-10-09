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

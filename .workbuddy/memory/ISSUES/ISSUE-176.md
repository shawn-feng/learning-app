# ISSUE-176：benefit-auth 登录安全加固——防撞库 + 防 DDoS（接口裁剪 + 限流 + nginx 边缘防护）

- **类型**：安全加固（已实施并部署生产，2026-10-10）
- **优先级**：高
- **记录时间**：2026-10-10
- **关联**：ISSUE-174（TokenHub 统一模型接入，本轮为其安全收尾）

## 一、背景与威胁面

用户要求登录安全加防撞库和 DDoS。裁剪前盘点：

| 入口 | 裁剪前现状 | 风险 |
|---|---|---|
| `POST /api/account/login`（家长邮箱密码） | 零防护 + PBKDF2 12 万次迭代（≈100ms CPU/次） | **撞库主目标 + CPU 放大** |
| `/api/auth/*`（旧 cloud 账密族，bcrypt） | 零防护 | 高 |
| `POST /api/admin-portal/login`（管理端） | 有限流但按 127.0.0.1 分桶（反代后 client.host 恒为本机，全员共享一个桶，攻击者可锁死管理员） | 高 |
| `/api/license`、`/api/account/register` | 旧/无场景 | 攻击面 |
| nginx | **无任何限流/超时配置** | slowloris、CPU 放大直通 |

DDoS 主威胁 = 应用层 CPU 放大（密码哈希昂贵，脚本便宜）；带宽型洪水靠阿里云默认基础防护。

## 二、实施内容（已全部部署生产）

### 1. 接口裁剪（撞库面直接消失）

- **删除** `POST /api/account/login`、`POST /api/account/register`（邮箱密码通道；app 客户端只走抖音扫码，UI 无引用已确认）→ `account.py` 整文件删除
- **删除** `cloud_license.py`（旧 /api/license 订阅校验路由；权益折算逻辑 legacy.py 已自带）
- **`cloud_auth.py` 瘦身**：/api/auth/* 全部路由下线，仅保留 `get_current_parent`（sync.py 在用）
- **410 存根**（新 `deprecated.py`）：`/api/auth/*`、`/api/license` 返回 410 +「请升级客户端」（日志发现有旧客户端近 7 天仍调 /api/auth/login 8 次——保留可读错误而非 404，强制升级）
- **登录页纯扫码**：pages.py 删账号密码表单/JS/CSS，只留抖音扫码（自动建号）
- LAN server 侧 `/api/v1/auth/login|register`（邮箱密码）随下个 server 包删除（不暴露公网，纯清理）

### 2. 应用内防撞库（新 `app/ratelimit.py`）

原则：**昂贵操作（密码哈希、挑战生成）之前先检查**，超限直接 429/423。

- **真 IP**：读 `X-Real-IP`（修正 127.0.0.1 分桶缺陷；9001 仅绑 127.0.0.1，外部无法伪造该头）
- 管理登录：IP 滑动窗（15 分钟 >10 次拒，哈希前）→ 全局熔断（60s 内失败 ≥30 → 全站熔断 10 分钟）→ 账号锁（连续失败 5 次 → 423 锁 15 分钟，SQLite 持久重启不掉）→ 失败统一随机延迟 0.3~0.8s → 失败告警邮件（10 分钟节流）
- 验证码 verify：每 IP 每小时 ≤20 次；验证码挑战：每 IP 每日 ≤20 个（防刷邮件/刷码）
- `/api/app/token`：app_id+secret 错 5 次 → 锁 15 分钟
- 存储：滑动窗/熔断用内存（单 worker 进程内共享，扩多 worker 需换集中存储）；账号锁落新表 `login_lockouts`（epoch 时间戳，重启不掉锁）
- 阈值全部 env 可调（`RL_*`）

### 3. nginx 边缘（防 DDoS/慢连接）

- `limit_req_zone` 两档：全站 20 r/s/IP（burst 40）、登录/管理/app-token 1 r/s/IP（burst 5），超限 429
- `limit_conn` 每 IP 并发 20；`client_body/header_timeout 10s` + `send_timeout 15s`（slowloris）
- 代理段抽 `/etc/nginx/benefit-auth-proxy.conf` 共享 include

## 三、验证

- 本地 TestClient：账密路由 404、/api/auth/login 与 /api/license 410、登录页无账密表单、5 次失败 423 锁定（正确密码也被锁）、清锁恢复、app/token 第 6 次 429
- 生产：公网 health/login 页（纯扫码）/410 文案/model-config 全过；连发 8 次管理登录演示 → 401×5 后 423×3（应用层账号锁生效）
- nginx -t 通过 + reload 成功

## 四、明确不做 / 残余风险

- 带宽型 DDoS：需阿里云高防（付费），当前规模不上；默认基础 DDoS 防护已含
- 分布式低速撞库：账号维度锁 + 全局熔断压制，理论残余由 PBKDF2 成本兜底
- 三方验证码/CAPTCHA：观察后二期可选（L3）
- 扩多 worker：内存滑动窗需换集中存储（Redis/SQLite），文档已注明

## 五、部署

- fix1~sec1 共 2 个包 + nginx conf：`/opt/backups/app-before-sec1-*.tar.gz`、`nginx-before-sec1-*.conf`
- 新文件：`app/ratelimit.py`、`app/routers/deprecated.py`、`/etc/nginx/benefit-auth-proxy.conf`
- 删除文件：`app/routers/account.py`、`app/routers/cloud_license.py`；`cloud_auth.py` 瘦身至 36 行

## ✅ 管理后台修复 + 样式统一（2026-10-10 用户反馈，fix6 已部署）

1. **「按钮没反应」根因**：重构时 JS `confirm()` 多行文案在写入 py 源文件时 `
` 被 Python 三引号字符串解释成真实换行 → 生成的 JS 字符串跨行 → **整段脚本语法错误全灭**（所有按钮无响应）。修复：文案去换行改 JS 字符串拼接（零转义依赖），并新增构建期检查——本地用 `node --check` 校验生成的页面脚本（已纳入本次及后续部署自检）。
2. **样式统一**：登录页与后台共用同一套设计变量（`--pri #2563eb` 系、slate 中性色、统一圆角/阴影/聚焦环/按钮 hover），后台侧边栏+面板+统计卡+表格+徽章全面规范化；登录页保持深色但同源配色。
- 部署：fix6，备份 `/opt/backups/app-before-fix6-*.tar.gz`。公网验收：登录页纯扫码无残留、410 存根、model-config、新样式变量均确认。

## ✅ 用户管理菜单（2026-10-10 用户需求，fix7 已部署生产）

后台新增「👥 用户管理」菜单：全部注册用户 + TokenHub Key 全量信息 + 查询。

- **数据聚合**（新 `app/user_admin.py`）：users 表（账号）+ tokenhub_keys（发放/轮换）+ legacy_parents（201 parent_id 映射）+ DescribeApiKey（网关状态/当日已用/档位/限额包时间/绑定模型/IP 白名单/更新时间）+ **DescribeUsageRankList 按天扫描近 14 天**（每天哪些 Key 有调用 → 最近使用日期/活跃天数/14 天用量——"最近使用时间"的唯一云端来源，按天粒度、有分钟级以上延迟）。
- **查询**（服务端 `apply_query`）：关键字（邮箱/昵称/用户ID/Key/parentRef）、状态（正常/耗尽/禁用/管控异常/未发放）、当日已用区间、剩余区间、配额档位区间、最近使用（7 天内/14 天内/14 天未用/从未使用）、六种排序。
- **展示**：汇总卡（注册数/已发 Key/14 天总消耗/异常数）+ 表格（用户/注册发放/状态/Key 前几位/当日进度条/剩余/14 天用量活跃/最近使用/操作）+ 「详情」弹窗（该 Key 全量：绑定模型列表/IP 白名单/Uin/限额包起止/轮换状态等）+ **CSV 导出**（当前筛选结果，带 BOM）。
- 端点：`GET /api/admin-portal/users`（查询参数）、`GET /api/admin-portal/users/{id}/detail`（绕缓存最新详情）。
- 验证：本地真实腾讯云全流程（2 用户 1 有 Key 1 无 Key：列表聚合绑定模型/nokey 过滤/credits 排序/详情全量字段全过）；node --check 页面脚本通过。

## ✅ 初始配额/有效期设置 + 注册即发放 + 用户管理配额调整与续期（2026-10-10 用户需求，fix8 已部署生产）

1. **TokenHub 菜单改版**：移除用户/Key 列表（并入「👥 用户管理」）；新增「🎓 新用户初始配额与有效期」面板——初始每日 Token 量（默认 500 万）+ 有效期天数（默认 365），保存进 settings。
2. **有效期机制**：tokenhub_keys 新列 `expires_at`；发放时 = 创建日 + 有效期天数；后台循环（每 5 分钟）对过期 active Key 自动禁用（约 8 秒生效，状态记 expired）。到期前 7 天可在用户管理「续期」。
3. **注册即发放**：oauth.py 新用户创建（抖音扫码）后自动 ensure_user_key（失败不阻断登录，物化循环兜底）——注册完就有配额。
4. **用户管理增强**：表格加「有效期」列（剩 N 天/已到期）；行操作加「续期」（从当前到期日或今天延长，到期禁用的 Key 自动重新启用——E2E 实测腾讯侧 enable）+「配额调整」（setQuota 即时生效）；筛选加「7 天内到期/已到期」；排序加按有效期；详情弹窗加有效期字段。
5. 验证：真实腾讯云 E2E（禁用+过期 Key → 续期 30 天 → 腾讯侧 enable、新到期日 2026-11-09）；node --check 页面脚本通过。

## ✅ 重置周期可配 + Key 自愈重建（2026-10-10 第二批，fix9 已部署生产）

1. **重置周期可配**：TokenHub「新用户初始配额与有效期」面板增加「重置周期」下拉——按日重置（默认）/ 按月重置（可设每月起始日 1~31）/ 总量（不重置）。发放、轮换继承、管理端调额全部按 Key 自身周期执行（`modify_quota` 支持 d/m/lifetime + MonthStartDay）。
2. **Key 自愈重建**：`get_key/get_quota` 遇 ResourceNotFound（Key 在腾讯侧被删）→ 自动标记旧行 deleted 并重新发放。此前场景：手工清理腾讯侧 Key 后，因 benefit 库仍返回旧 Key、server 比对无变化 → 永久 401；现自愈闭环。
- 事故记录：本地清理腾讯侧孤儿 Key 时误删了生产家长的 Key（清理脚本按账号全量列出）——依赖上述自愈 + 手动触发 201 重启，12:38 新 Key 已物化恢复（ak-…c5254821，active，500 万/日）。教训：任何按账号全量列出并删除的操作前必须先过滤测试前缀。
- 验证：按月发放（CycleUnit=m/200万/月起 15 号）、调额（m/300万）、轮换继承（新 Key 保持 m 周期）、续期（过期 Key → 重新启用 + 顺延 30 天 → 腾讯侧 enable）全部实测通过。

## ✅ 调额支持重置周期（2026-10-10 用户需求，fix10 已部署生产）

用户需求：调额（配额调整）时也要能配置自动重置的周期。

- **后端**：`POST /api/admin-portal/tokenhub/quota` 增加可选 `cycleUnit`（空=保持现周期；d/m/lifetime）与 `monthStartDay`；`modify_quota` 按所选周期调腾讯侧限额包；**手工调整会清除排队的自动恢复档位**（管理员意图优先）；DB 行同步 `quota_cycle_unit`。
- **前端**：调额从 prompt 改为**弹窗**（配额 + 重置周期下拉[保持现有/按日/按月+起始日/总量]），用户管理行按钮传入当前周期；CSV 增加「重置周期」列。
- **验证**（真实腾讯云）：m 周期发放（200万/每月15号）→ 保持周期调额（m/350万）→ 切周期调额（d/100万）→ lifetime 调额（80万且清 pending_restore）全部实测通过；页面脚本 node --check 通过。

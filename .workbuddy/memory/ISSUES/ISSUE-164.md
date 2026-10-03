# ISSUE-164：抖音开放平台接入（扫码登录 / license 切 benefit-auth / 经营任务自动化）——评估与计划

- **类型**：需求 / 架构（评估记录 + 分期计划）
- **记录时间**：2026-09-28
- **状态**：🚧 评估完成；P0（平台侧申请经营任务权限）进行中——用户自行操作抖音控制台

## 需求（用户 2026-09-28 描述）

1. 用户用抖音账号作为家长账号登录 app；app 内增加抖音扫码页面，扫码后通过。
2. 用户账号的 license 及相关权限，在 benefit-auth 获取。
3. 用户通过完成任务获取权限，记录到 benefit-auth。

任务类型当前设定 5 种：**点赞视频 / 关注 / 完播 / 转发 / 评论**——需要抖音平台开放能力；用户查到「抖音经营任务」能力（mission-creation 文档），经评估与需求高度对口。

## 完成情况评估（历史证据：日期记忆 2026-08-17 / 2026-08-28；ISSUES 内此前无抖音相关 issue）

### 已完成（benefit-auth 中台侧）

- **中台已上线**：`/opt/benefit-auth`（:9001，Nginx 反代 `auth.aixuexihao.top`，systemd）；v0.2 多平台 OAuth（08-28）→ v0.3 账号密码登录 + v0.4 抖音视频互动数据分析（09-21 上线，commit `2a91a4c` 一线）。
- **抖音应用已转正**：2026-09-21 审核为「正式应用」（不再依赖 trial.whitelist 测试白名单）；登录 scope = `user_info, video.list.bind, video.data, video.comment`（`benefit-auth/app/platforms/douyin.py:24`）。
- **IdP 授权码流程已实现并端到端测试**：`/oauth/authorize` → `/oauth/token` → `/oauth/userinfo`（`routers/oauth.py:383/427/466`）；网站自身抖音扫码登录全链路 08-28 打通（「当前链接不合法」排障全程见 08-28 记忆，最终根因=移动端 H5 被平台封锁 `block_aweme_h5`，PC 扫码流可用）。
- **任务/权益模型完整**：apps/tasks/task_instances/entitlements/reviews 表 + 可插拔验证器（`app/verifiers.py`）+ 人工审核流 + `/api/app/tasks`、`/users/{id}/completions`、entitlements 核销（INTEGRATION.md v0.2）。
- **平台 token 续期**：抖音平台级 refresh_token 续期已实现（`platforms/base.py:87`，用于 platform_accounts.access_token 过期自动续）。

### 缺口（按需求映射）

1. **需求 3 的验证层实际已失效**：`verifiers.py:61-77` 仍调用已废弃旧路径 `/api/douyin/v1/user/info/`、`/api/douyin/v1/user/following/list/`、`/api/douyin/v1/user/video/list/`——08-28 已证实这些路径现返回 200+HTML 兜底页（当时只修了 `douyin.py`，验证器未同步迁移）→ 自动验证（关注/发布/粉丝）线上真实环境全失败；点赞/转发/评论因「平台无开放查询接口」降级人工审核（INTEGRATION.md §5 也写死 repost 必须 manual）。
2. **需求 1 客户端零代码**：设计文档 `benefit-auth/LEARNING-APP-AUTH-DESIGN.md`（08-28 评审通过：①`piauth://` 自定义协议回跳 ②IdP refresh_token 30d 一次性轮换 ③权益 app 本地换算 + auth_status 5 分钟轮询）未实施——Electron 端无任何抖音/中台登录代码。
3. **中台缺 IdP 配套端点**：`/oauth/refresh_token`（App 用 user JWT 续期，与平台级 token 续期是两回事）、`/api/app/users/{uid}/auth_status`、register 允许 `piauth://callback`。
4. **需求 2 license 未切换**：`server/src/config.ts:7`「暂接 www，benefit-auth 就绪后切换」——learning-server 认证代理（`server/src/auth/proxy.ts`）至今指向 cloud-service；订阅数据在 cloud-service app.db（ISSUE-160 刚为 test@qq.com 延期到 10-27）；benefit-auth :9001 未接入 license 链路。

## 经营任务能力调研（2026-09-28 评估用户提供的文档）

文档：`developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/video-management/business-task/mission-creation`

- **5 种任务全部原生支持**：`short_video_digg_event_info`（点赞）/ `account_follow_event_info`（关注）/ `short_video_finish_playing_event_info`（完播）/ `short_video_share_event_info`（转发）/ `short_video_comment_event_info`（评论）；另有直播类/收藏/投稿等事件。
- **配套 API**：活动创建 `POST /dy_open_api/apps/v3/activity/create/` / 修改 / 查询活动信息 / **查询用户是否完成** → 「点赞/转发/评论只能人工审核」的降级方案可整体退役，5 类任务全自动化。
- **约束**：scope `open.business.task_manage`；走 **client_token（应用级 token）**，与现有用户级 access_token 体系并行；单应用上限 20 个未开始活动；**主体资质要求（企业号/商家身份？）文档页未写明，需控制台确认能否申请——整个方案成立的前提**。
- **平台侧经验教训（08-28 记忆沉淀，申请时用得上）**：能力是「代码请求 + 平台批准」双控；测试应用能力表不显示经营能力，需上线转正后在能力管理/申请上线流程里申请；scope 名会改版（.bind 后缀），对齐以**平台官方模板**为准，勿信论坛帖。

## 后续计划

### P0 平台侧前置（用户操作，🚧 进行中）

1. 抖音开放平台控制台确认「经营任务」能力申请入口与主体资质要求；可申请则提交（历史审核 5~7 个工作日）。
2. 顺带确认 `video.list.bind` / `video.data` / `video.comment` 三能力的审批状态（09-21 转正后按「用户授权勾选」模式配置，审批结果未记录）。

### P1 经营任务接入 benefit-auth（补完需求 3）

1. 封装 client_token 获取 + 活动 CRUD + 「查询用户是否完成」。
2. 验证器重构：新增 `DouyinBusinessTaskVerifier`，5 类任务全自动化；顺带清理/替换 `verifiers.py` 废弃路径。
3. 任务创建流映射：App 建任务 → 中台同步创建抖音活动并保存 activity_id → 用户领取后轮询完成状态 → 写 completions/entitlements。

### P2 App 扫码登录 + license 切换（需求 1、2）

1. 中台补 `/oauth/refresh_token`（30d 一次性轮换）、`auth_status` 端点、`piauth://` 回跳注册（按 LEARNING-APP-AUTH-DESIGN.md）。
2. Electron 端实施登录页、协议注册、token 管理（设计现成，纯实施）。
3. learning-server 认证基址从 cloud-service 切 benefit-auth——前置：订阅数据迁移方案 + 吸取 ISSUE-160 教训（登录链路即校验订阅状态、切换需灰度+回滚预案）。

## 进展记录

- 2026-09-28：评估完成，本 issue 建立；用户开始 P0（申请经营任务权限）。
- 2026-09-28（下午）：**P1 技术对接完成并上线（v0.5，用户 P0 审批期间先行）**——
  - 新模块 `benefit-auth/app/business.py`：client_token 缓存获取 + 活动创建/查询 + 用户完成查询；
    **mock/live 双模式**（.env `DOUYIN_BUSINESS_TASK_MODE`，默认 mock）：能力未审批前完成查询一律
    未完成并带 mock 标记、不虚发权益，跳转链接照常；live 接线已用假 token 实测（抖音返回
    `err_no=28001008 access_token 过期`——端点/鉴权头/解析链路全通）。
  - 新验证器 `DouyinBusinessTaskVerifier`：`bt_*` 任务类型（bt_like/bt_follow/bt_finish/bt_share/bt_comment
    = 点赞/关注/完播/转发/评论）；apps.py 建任务白名单放开 bt_*。
  - 新端点 `POST /api/me/tasks/{instance_id}/check`（用户跳抖音完成后回来重验，platform token 过期先续期）。
  - 任务墙 UI：bt_* 中文类型标签 + 「去完成」跳抖音按钮 + 「我完成了，验证」按钮。
  - 种子脚本 `seed_demo_tasks.py`：5 条 demo-bt-* 演示任务（target_url 占位：发现页/用户搜索页，
    可 --video-url/--user-url 指定真实目标后重跑更新）。
  - **顺手修两个存量 bug**：`_auto_verify_if_possible` 把 aiosqlite.Row 当 dict 用（task.get/account.get）
    → 领取 auto 任务必 500、自动验证从未真正跑过；publish_video 验证路径迁 `/oauth/video/list/`。
  - 部署：OSS Python V1 签名（tmp/deploy/_oss_sign.py）+ 云助手 RunCommand；备份
    /opt/backups/app-20260928-125748.tar.gz / app-20260928-125935.tar.gz。生产验证：双入口 health 200、
    种子 5 任务落库、/me 新按钮在位、页面 JS node --check 通过、无 token 401。
  - **待用户真机验证**：www 扫码登录 → 任务列表 → 点「去完成」跳抖音对应界面。
  - **切 live 三步**（P0 批准后）：①控制台开通 open.business.task_manage / open.business.task_verify
    ②创建真活动并把 activity_id/business_task_id 回填任务 target_config ③.env 加
    DOUYIN_BUSINESS_TASK_MODE=live 重启。
  - 遗留：活动创建的 task_type_enum int 映射表未拿到（文档页字段未展开），live 建活动前需按官方
    枚举表补齐 `business.py` 映射；跳转链接目前是 PC web 版（移动端 H5/app schema 后续再议）。
- 2026-09-28（晚）：**三个经营能力审批通过（用户控制台截图：task_manage/task_verify/task_writeoff 全部
  「已通过」；task_manage 免配额无限制，task_verify/task_writeoff 需用户授权）**，P0 完成。推进：
  - **目标视频已定**：用户给出分享链接 → 解析 item_id=`7653986142022290726`
    （https://www.douyin.com/video/7653986142022290726）。
  - **scope 接线已部署**：`open.business.task_verify` 加入 douyin.py default_scopes + advanced_scopes、
    pages.py UPGRADE_SCOPES；OSS+云助手部署（备份 app-20260928-*.tar.gz），生产验证
    login authorize Location 已含新 scope、服务 active。（部署时序：老绑定用户需「升级授权」重新扫码才有此 scope）
  - **卡点：task_type_enum 枚举表拿不到**——官方文档页不公布枚举对照（WebFetch 三次确认，正文仅示例
    task_type_enum:1）；页面 SSR 是 471B 壳、正文走运行时 XHR 抓不到；搜索工具返回内容不可信。
    **盲探两轮（建活动试错）均回泛化 `err_no=28001007 参数不合法`**（err_msg 无细节，仅 log_id），
    已停止盲试（信噪比过低）。探测脚本存 tmp/deploy/_dy_enum_probe*.py。
  - **归属约束实证计划**：文档无视频归属要求，但请求示例含 `not_bc_check:false`（默认做 BC 校验）
    → 建测试活动时会暴露；用户目标视频疑似自有账号发布（内容为自家英语课推广文案）。
  - **待用户提供**：登录开放平台后打开任务创建文档页，把「请求示例」JSON 原文复制发出（或展开
    参数表截图，重点 common_event_info.task_type_enum 枚举说明 + 各事件对象必填字段）。
  - **拿到后闭环路径**：按真实 schema 修 business.py 的 activity_create payload → 建探测活动拿枚举
    映射 → 建真活动（5 类任务×目标视频）→ activity_id/business_task_id 回填种子任务 target_config +
    换真实跳转链接 → 服务器 .env 加 DOUYIN_BUSINESS_TASK_MODE=live 重启 → 用户重新扫码升级授权
    （拿 task_verify scope）→ 真机完成一个任务验证完成查询返回 true → 权益自动发放。
  - 备注：`ma.openapi.task_writeoff`（BC 授权关系）是核销侧能力，与"完成查询+发权益"主线无关，暂不接。
- 2026-09-28（晚，二）：**突破——关注任务真活动创建成功并已接线上产**：
  - **字段语义破解**（探测+控制台实证）：`account_follow_event_info.aweme_id` 要的是**抖音号**（非视频
    id——短码被解析为抖音号报"抖音号有误"，数字视频 id 报"aweme_id is invalid"）；格式层之后是 **BC 关系
    校验（28001028 缺少BC关系授权）**，顶层 `"not_bc_check": true` 可跳过；`condition_type=4`、
    `dependence(ItemID, 视频数字id)` 组合可用。
  - **控制台实建成功**（用户操作，not_bc=true + aweme_id=1262668803）：activity_id=323645137154，
    business_task_id=1260987846595983899（关注做给孩子看，窗口 30 天）。
  - **已部署**（OSS+云助手，输出逐行核对）：verifiers 真查询门控（target_config 含 activity_id/
    business_task_id 才走真查询，否则"暂按模拟处理"提示）+ UPGRADE_SCOPES 收窄为
    `user_info,open.business.task_verify`（避开未审批视频 scope，重授权页不再报「非法应用」）+
    demo-bt-follow 回填真 id + .env `DOUYIN_BUSINESS_TASK_MODE=live` + **activity modify 把开始时间改到
    现在**（modify 返回 success，不用等次日 0 点）。
  - **待用户**：/me 页点「升级授权」重新扫码（拿 task_verify）→ 领取关注任务 → 抖音完成 → 回来点
    「我完成了，验证」→ 真查询。若完成查询仍报 BC 类错误 → 需走 BC 授权流程（第三能力）。
  - **待定**：探测 1（点赞 enum=1）控制台结果未收到——决定其余四类是否可 API 自动化；
    服务器 token 实测仅 user_info,trial.whitelist；视频能力（video.list.bind）应用级未审批
    （error 22 非法应用），v0.4 视频功能需控制台申请后才可用（独立事项）。
- 2026-09-29：**五类任务全部接通真活动（用户控制台逐个创建 + 服务端接线）**：
  - **点赞破局**：enum=1（ShortVideoTask）报 task_type not support 的真因=**视频维度不被支持**
    （video_url/item_id 维度），改 **anchor_id 维度（抖音号 1262668803）+ dependence(AnchorID=2) +
    not_bc_check=true** 即创建成功。完播/转发/评论同配方全部成功。
  - **五类活动映射**（均已 modify 至「现在起 30 天」窗口 + 回填 target_config）：
    关注=323645137154/1260987846595983899；点赞=436510947842/1260987846596009788；
    完播=263940867074/1260987846596010274；转发=263911051522/1260987846596011210；
    评论=263940928770/1260987846596011211。
  - 服务器 live 模式运行中；五条任务在 /me 任务墙均带「去完成」（跳目标视频页）+「我完成了，验证」。
  - **待用户**：①/me 升级授权（现 token 仅 user_info,trial.whitelist，重授权后拿 task_verify）
    ②五类任务各测一遍（领取→去完成→抖音真实操作→回来验证）。完成查询若报 BC 类错误 → 走
    「建立账号BC授权关系」（ma.openapi.task_writeoff，账号主人授权即可）。
  - **经验沉淀（对任何抖音开放平台对接通用）**：①文档字段示例值是掩码占位，真实形态只能实证；
    ②控制台「在线调试」是最权威的探针（字段级报错+官方 token），比服务端盲试快一个数量级；
    ③逐字段报错是阶梯——每个新错误都是往下剥了一层；④aweme_id/anchor_id 等账号类字段填**抖音号**
    字符串；⑤not_bc_check=true 跳过品牌-创作者关系校验（对自有账号的推广任务适用）。
- 2026-09-29（午）：**✅ 全链路首次真实闭环达成**——账号「闻闻来读书」（第二个绑定账号，新用户 UUID，
  多账号设计按预期工作）扫码登录 → 升级授权（token scopes=user_info,open.business.task_verify，
  收窄版授权页工作正常）→ 领取完播任务 → 跳视频真实完播 → 「我完成了，验证」→ live 真查询返回
  true → granted + 权益（10 积分）发放。**服务端独立复核**（账号 token 重查平台）再次返回
  task_complete_status_map={task:true}——完成状态真实、非缓存。完成查询未报 BC 错（not_bc=true
  创建的活动查询侧畅通）。剩余：其余四类同法实测；正式运营配置（文案/奖励值/批量建任务接口）。
- 2026-09-29（下午）：**每日推广视频自动化上线 + 任务墙排序**：
  - **campaign 模块**（app/campaign.py）：每 2 小时（CAMPAIGN_INTERVAL_H）拉发布者（做给孩子看）
    最新视频 → item_id 变化则：①重建转发活动（平台把转发绑到创建时最新视频，账号维度四类无需重建）
    ②旧转发活动 modify 结束 ③更新五条任务 target_url/video_title ④写 settings 表 campaign_video。
    视频列表依赖 video.list.bind 能力（**应用级未审批**——error 22 非法应用），未批时静默降级保留当前
    配置（首轮已实测降级路径）；能力批准 + 发布者重授权（补 video.list.bind scope）后自动生效。
  - 日志在 /var/log/benefit-auth.log（unit StandardOutput 重定向，journal 里只有 systemd 行——排查别走错）。
  - settings 键值表新增（campaign_video 等配置存储）。
  - **任务墙排序**：可做（未领取/已领取）在前，已完成/未通过沉底（pages.py 前端排序）。
  - **待用户**：控制台申请 video.list.bind 能力；批准后发布者账号重新授权。
  - 转发/评论完成登记问题仍观察中（App 内重测一次转发后仍 false；评论 4h+ 未登记）——若确认平台
    侧不归因，这两类切人工审核兜底或走 BC 授权。

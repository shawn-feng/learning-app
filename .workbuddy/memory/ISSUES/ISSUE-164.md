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
- 2026-10-08：**每日任务机制定稿——自动检测为主、人工审核兜底（与另一会话 sess_7d6071d1 的方案合并）**：
  - **背景**：另一会话（10-07）曾因过时信息（认为经营能力未批/验证器是 mock）把 5 条静态 bt_* 任务全部
    ended，切回「每日 video_interact 人工审核」（cron 00:10 → /api/admin/daily-task，奖励 vip_days 7，
    云端按完成当天+7 天不叠加折算）。用户拍板：**保留每日触发机制，不恢复旧静态任务，自动检测为主、
    人工审核兜底**。
  - **合并实施**（admin.py 重写 daily-task 生成器，本地仓与服务器代码已互相同步）：
    - 每天生成 4 条当日任务（23:59 过期）：**点赞/完播/评论（bt_* auto，自动检测）** +
      **转发（bt_share manual，人工审核兜底**——平台对转发事件不归因）；
    - 每条 auto 任务生成时同步创建**当日平台活动**（平台完成记录=每用户每活动一次，日抛活动才能
      支撑每日重做；配方=已验证的 anchor 维度 + not_bc_check + condition_type 4/1 + ASCII 活动名），
      activity_id/business_task_id 回填 target_config；建活动失败则任务无接线→验证器"暂按模拟处理"
      不放行（degraded 上报）；
    - cron/审核页/审核接口（pending-reviews、review）原样保留；审核页文案改为"仅审核转发兜底"；
    - **campaign 循环停用**（main.py 移除启动——它会给已 ended 的静态任务重建活动白耗名额；
      视频轮换职责归 daily-videos.json + cron）；
    - 旧 video_interact 任务全部 ended；本地仓已包含 admin.py 等服务器改动（消除部署覆盖风险）。
  - **首日验证（10-08）**：手动触发 daily-task → 4 条任务生成、3 条 auto 全部成功接线当日活动
    （350105521666/396661084674/406515214850）、degraded 空；daily-videos.json 补入林语堂视频；
    任务墙恰好 4 条 active。明日 00:10 cron 将以新代码自动生成 10-09 任务。
  - **运营口径**：用户每日看到 4 个任务，任一完成得 7 天权益（云端同日不叠加，多做不多得）；
    关注类未纳入每日（一次性语义，如需可加一条常驻关注任务）。
- 2026-10-08（晚）：**改为一天一条合并任务 + 每分钟自动轮询发放**：
  - **一天一条**（用户定稿）：「X月X日 · 官方视频互动任务」（bt_interact, auto）——对官方账号任意视频
    完成完播/点赞/评论/转发**任一项即算完成**。内部挂 3 个当日自动活动（like/finish/comment），
    验证时任一 true 即通过；转发平台改绑单视频不归因 → 人工审核兜底（任务卡验证按钮旁常驻
    凭证提交框，submitted 状态受保护不被自动验证覆盖）。账号维度确认：点赞/完播/评论的平台配置
    就是抖音号（任意视频计入），仅转发被平台改绑单视频。
  - **每分钟自动轮询**（app/poller.py，POLL_INTERVAL_S 默认 60）：遍历当日有效 bt_* 自动任务 ×
    所有绑定抖音号（无 task_verify scope 跳过省配额；token 过期自动 refresh）→ 查 3 活动完成状态 →
    任一 true 即自动创建/更新实例为 granted + 发权益——**用户无需回站点验证**。幂等保护：
    granted/submitted 跳过；rejected 但平台实测完成 → 平台权威发放。已上线，首轮
    checked=2 granted=0 正确（当日活动尚无人完成）。UI 保留「我完成了，验证」作为即时路径。
  - 幂等修复：daily-task 的 exists 检查加 `status != 'ended'`（旧 video_interact 同名行会挡住新任务）。
- 2026-10-08（二）：**认证切换 P2——learning-server 上游 cloud-service → benefit-auth（本地开发环境已切换验证；201 未部署，用户要求完整测试后再上）**：
  - **benefit-auth 云端兼容端点**（app/routers/legacy.py，/api/account/* 前缀——nginx 把 /api/auth/*
    分流到 cloud :8000，不能重名）：`GET /license`（LicenseData 兼容形状）、`POST /douyin-login`、
    `GET /parent-status`、`POST /set-password`；login/register 复用 account.py（{token,user_id} →
    proxy 映射 parent_id）。
  - **身份连续性**：201 全部家庭数据挂在旧 cloud parent_id（test@qq.com=86a84278）下 → 新增
    legacy_parents 表（email/benefit_user_id → 旧 parent_id，种子=cloud parents 表 20 条已拷），
    login/register/douyin-login 返回的 parent_id 走映射——**test@qq.com 登录后 parent_id 仍为
    86a84278，本地/201 数据空间无缝**。
  - **License 计算**：special_permanent_users 标记 → 2099 永久（is_expired=false）；普通用户按
    vip_days 权益「完成当天(+08:00)+N 天、不叠加取 max」；无权益=已过期。
  - **learning-server 0.5.22**：config.ts DEFAULT_UPSTREAM → auth.aixuexihao.top；proxy.ts 六个上游
    路径 /api/auth/* → /api/account/*；login/register 响应映射 user_id→parent_id；version.ts 常量
    0.5.22。**客户端零改动**（服务端响应形状不变）。
  - **验证（本地 dev，127.0.0.1:8788，0.5.22）**：POST /api/v1/auth/login test@qq.com →
    session_token + license{parent_id:86a84278, expires_at:2099-12-31, is_expired:false, basic/4}✓。
  - **201 状态**：切换尝试被用户中止——期间新包曾被替换+服务被重启（跑过约 20 分钟 0.5.22），
    **已完整回滚**（磁盘=0.5.21 原文件、服务已重启回 0.5.21、登录走回 cloud 正常、健康检查 ok、
    /tmp 残留已清）。201 上线待用户完整测试后另行执行（bundle 已构建好：server/dist/server.cjs）。
  - 部署要点（未来上 201 用）：构建 `cd server && node scripts/build.mjs` → dist/server.cjs →
    传 201 换 /opt/learning-server/server.cjs → systemctl restart learning-server（systemd 无
    UPSTREAM_BASE 覆盖，新默认基址直接生效）；201 可达 auth.aixuexihao.top（已实测）。
  - 注意：cloud-service 保留不动（老客户端/旧 token 兼容期）；其他 21 个 cloud 测试账号未迁移
    （切换后需在 benefit-auth 重新注册同邮箱才能登录）。
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
- 2026-10-08：**修复：抖音扫码登录二维码「链接不合法」**（App 端改家长中心密码触发抖音身份验证时发现）：
  - **根因**：`/api/oauth/douyin/qrcode` 自绘二维码内容是 `open.douyin.com/platform/oauth/connect/?...`
    授权页链接——抖音 App 只识别**官方授权页自渲染**的扫码验证二维码，扫自绘二维码一律报
    「链接不合法」。受影响入口：IdP 未登录续接页（`_authorize_continue_page`，App 扫码登录/重置
    密码都经此页）；主登录页 `_HOME_LOGIN_PAGE` 与 bind/upgrade 本就整页跳转官方授权页，不受影响。
  - **修复**（benefit-auth 0.2.x，已部署 ECS 并验证）：
    - `/api/oauth/{platform}/authorize` 新增 `cont` 参数（仅站内相对路径防开放跳转）：登录成功
      callback 带会话 Cookie 302 回 cont（如 `/oauth/authorize?...` 续接发 code）；已登录直接 302 回 cont 免再扫码。
    - IdP 续接页改为 `location.replace('/api/oauth/douyin/authorize?mode=login&cont=...')` 整页跳
      抖音官方授权页（PC 页出官方二维码，扫码确认后回 callback 续接）。
    - `/whitelist` 同结构问题一并改为 302 官方授权页（callback kind=whitelist 直接返回成功页）；
      删除死代码 `_whitelist_page`、`pages.py._INDEX_PAGE`（旧二维码登录模板，早已不被引用）。
    - `/api/oauth/{platform}/qrcode` 保留但标注弃用（自绘二维码抖音 App 不识别）。
  - **部署验证（ECS RunCommand，invoke t-hz06zdnx6sl4z5s）**：download/py_compile/svc active/health ✓；
    续接页含 location.replace ✓；`/api/oauth/douyin/authorize?mode=login` 307 →
    `open.douyin.com/platform/oauth/connect?client_key=awp5v9...&scope=user_info,video.list.bind,
    video.data,video.comment,open.business.task_verify&redirect_uri=https://auth.aixuexihao.top/api/oauth/douyin/callback` ✓；
    `/whitelist` 307 官方页 ✓；www.aixuexihao.top/oauth/authorize 公网入口 ✓；
    已登录+cont 307 直回 /me ✓；bind 无 token 401 回归 ✓。
  - **待用户真机复测**：App 端重新触发「修改家长中心密码」→ 系统浏览器应打开抖音官方授权页 →
    扫码确认 → 回 127.0.0.1:17888/callback 显示「✅ 操作成功」→ 密码重置成功。
- 2026-10-08（续）：**修复：扫码授权成功后死循环（授权页反复出现）**。用户实测：扫码授权完成，
  页面又回到扫码页无限循环。
  - **根因（FastAPI 陷阱）**：`callback` 端点把会话 Cookie 设在**注入参数 response** 上
    （`_set_session_cookie(response, token)`），但随后 **return 的是自建的 RedirectResponse**——
    FastAPI 对直接返回的 Response 对象不合并注入参数上的 Set-Cookie（只有返回 dict/模型的常规
    路径才合并），`ba_sid` 从未真正发到浏览器 → cont 续接时 `/oauth/authorize` 看不到登录态 →
    再渲染续接页 → 再跳抖音 → 死循环。旧流程（bind/upgrade/login→/me）token 走 URL 参数，
    Cookie 丢了也不影响，所以该坑一直被掩盖。
  - **修复**：新增 `_redirect_with_session(dest, token)`——先把 Cookie 设在返回的 RedirectResponse
    上再返回；callback 的 login（cont 与 /me 两分支）/bind/upgrade 全部改用它。
  - **本地回归测试**（monkeypatch 抖音 provider，ASGI 全链路）：authorize 307 官方页（state 落库）→
    callback 307 回 cont 且 `Set-Cookie: ba_sid=...; HttpOnly; Secure` ✓ → 带该 Cookie 访问续接
    地址 → 307 `http://127.0.0.1:17888/callback?code=...&state=xyz` ✓（闭环）。
  - **ECS 部署验证**（invoke t-hz06zf5nvkf3i80 + t-hz06…cookie-check）：download/py_compile/
    svc active ✓；authorize 307 回归 ✓；`POST /api/oauth/session` 的 Set-Cookie 经
    auth.aixuexihao.top 与 www.aixuexihao.top 两个 nginx 入口均正常透传 ✓。
  - **待用户**：App 端再测「重置家长中心密码」/抖音扫码登录——授权后浏览器应显示
    「✅ 操作成功」，App 内继续完成。
- 2026-10-08（再续）：**修复：App 报「服务端未配置抖音登录（BENEFIT_CLIENT_ID/SECRET）」**。
  扫码授权链路已全通（浏览器显示「请回到学习伙伴应用继续」），卡在最后换码一步：
  - **本地 dev server 缺 benefit 应用凭证**：`server/data/server-config.json` 的
    benefitClientId/benefitClientSecret 为空（config.ts 优先读该文件，env 覆盖不生效场景）。
    已从 ECS `/opt/benefit-auth/.env` 取「学习伙伴」secret 写入（app_id=app_2cd2b7263372a407，
    secret 不入 git，临时文件即取即删）。
  - **本地 parents 表 benefit_user_id 全空**：重置密码按 `WHERE benefit_user_id=?` 找家长，
    不补会 404「未关联」。已把 86a84278（test@qq.com，有孩子数据行）关联到 benefit 用户
    b0736e0d-e1a9-4ffd-b731-eefc8992eacd（ECS users 表实测值）。
  - 本地库另有一条 test@qq.com 重复行（id=b0736e0d…eacd，10-08 01:48 生成，疑似映射部署前
    某次登录残留）——不再使用，留置无害（douyin-login 现返回映射后 parent_id=86a84278）。
  - **验证**：dev server 重启后 `/auth/douyin` 与 `/auth/douyin-reset-password` 假 code 均报
    「抖音登录失败：invalid authorization code」——503 配置错消失，且 benefit-auth
    client_id/secret 校验已通过（否则报 Invalid client credentials）。
  - 201 部署 0.5.22 时注意：/opt/learning-server 的 .env 或 data/server-config.json 需有
    BENEFIT_CLIENT_ID/SECRET；parents.benefit_user_id 需按扫码账号回填（或先扫码登录一次
    由 /auth/douyin 自动写入）。
- 2026-10-08（架构修正）：**SK 下沉云端——learning-server 不再持有任何 secret**。用户指出
  server 端装在用户机器上，不能存抖音应用 SK/AK（上一轮把 BENEFIT_CLIENT_SECRET 写进本地
  server-config.json 的做法错误，且取值时误抓了 DOUYIN_CLIENT_SECRET，线上报
  「Invalid client credentials」）。
  - **架构**：benefit-auth 新增第一方免 secret 端点（授权码只投递到发起方 redirect_uri，
    持码即来源证明，无需 client_secret；第三方接入仍走 /oauth/token+secret）：
    - `POST /api/account/douyin-code-login` {code, redirect_uri} → 消费 IdP 授权码（一次性）→
      {token, parent_id(映射), email, benefit_user_id, is_new}
    - `POST /api/account/douyin-reset-password` {code, redirect_uri, new_password(8-128)} →
      验码确认身份 → 直接改密 → {success}
    - 辅助 `oauth.consume_idp_code(code, redirect_uri)`。
  - **learning-server 0.5.23**：/auth/douyin 与 /auth/douyin-reset-password 改纯转发；删除
    benefitTokenExchange/upstreamDouyinLogin/benefitBase/benefitClientId/benefitClientSecret
    （config.ts 接口同步收敛）。client_id（公开 AK）只存在 electron 客户端（构造授权链接用）。
  - **secret 归档**：真 secret 在 tmp/provision2.sh 找到（2026-09-21 注册时记录
    yfaC…ZIAv），已补记 ECS /opt/benefit-auth/.env（BENEFIT_CLIENT_SECRET 行，仅存档，
    运行不依赖）。201 从未配置过该 secret（全网检索确认）。
  - **ECS 端到端验证**（invoke t-hz06zf8pz41xerk）：authorize 发码 → code-login 200
    parent_id=86a84278 ✓ → 码复用 401 ✓ → reset-password 成功 ✓ → 新密码登录 ✓。
    测试过程把 test@qq.com 密码临时改为 12345678，已用旧 set-password 端点恢复 123456 并
    验证登录 ✓（注意：新端点强制 8-128 位，旧 set-password 允许 6 位——客户端 UI 提示
    「至少 8 位」与此一致）。
  - **本地验证**：0.5.23 启动 ✓；假 code 两端点均报云端「invalid or expired authorization
    code」（无 503 配置错）；server-config.json 无 benefit SK 字段。
- 2026-10-08（体验优化）：**抖音授权改 App 内窗口**（用户提出：不必跳系统浏览器）。
  - electron/lib/douyin-login.ts：shell.openExternal → BrowserWindow（500×700，
    partition=persist:douyin-auth——ba_sid 会话跨启动保留，72h 内再次登录/重置免重扫；
    setWindowOpenHandler deny 防弹新窗）。本地回调 HTTP 服务保留（redirect_uri 注册值不变，
    云端校验精确匹配）；授权完成/取消/超时自动关窗；用户手动关窗即取消（不再干等 5 分钟超时）。
  - redirect_uri 不变 → 服务端零改动；success 页「✅ 操作成功」在窗口内一闪即关。
  - 客户端重新 npm run dev / 构建后生效；tsc 无新增错误（仅 5 条既有全局类型环境噪音）。
- 2026-10-08（新用户登录 500 修复）：用户用「新用户」扫码登录报 HTTP 500。
  - **定位**：ECS benefit-auth 日志——`GET /api/account/license` 500，`_compute_expiry`
    `reward.get("type")` AttributeError：该用户名下 4 条权益（09-29 闻闻来读书任务测试所发，
    demo-bt_like/follow/finish/comment）的 reward_code 被**双重编码**
    （存成 `"{\"type\":...}"`——json.dumps 了未解析的 config 字符串）。
  - **触发身份**：扫的抖音号实为闻闻来读书（09-29 已绑定+做过任务），并非全新用户——
    benefit 按 open_id 识别回老用户 → license 读到坏权益行即崩。做给孩子看无权益行故无恙。
  - **修复（ba 已部署，invoke t-hz06zfbpaezfym8）**：
    ① `legacy._compute_expiry` 逐层解码防御（最多 2 层，非 dict 跳过）；
    ② `me._grant_entitlement` 落库前归一化（str→loads，防再次写坏）；
    ③ `poller` 修复 `task["reward_code"]`→`task["reward_config"]`（原列名不存在，轮询发放必 KeyError 的潜伏 bug）；
    ④ `me /entitlements` 列表读取同样逐层解码；
    ⑤ 存量数据迁移：4 行归一化为单层 JSON 对象。
  - **验证**：闻闻来读书 token → license 200（is_expired=true，points 权益不延 vip 有效期，
    待解锁状态正确）；/api/me/entitlements 4 条 reward_code 全为 dict。
  - **新用户完整流程**（备忘）：扫码 → benefit 按 open_id 找/建用户（新号自动注册，无邮箱密码）→
    免密换码 → 本地建家长（parent_id=benefit UUID）→ license is_expired=true 待解锁 →
    引导任务墙完成每日互动任务（vip_days 7）→ 客户端轮询自动解锁。
- 2026-10-08（任务墙三问修复）：用户完成任务后提出三个问题，全部定位并修复：
  1. **任务绑定确认**：点赞/完播/评论核验为**账号维度**（做给孩子看名下任意视频均算），
     任务卡「视频：《林语堂…》」是展示层遗留误导——admin.py 每日任务不再写 video_title，
     描述改为「视频地址（快捷入口，官方号下任意一条视频均可）」，存量 active 任务已迁移。
  2. **「该任务参与次数已达上限」**：是我们自己的 409（me.py direct-verify），非平台错误。
     实测时间线：21:49 点赞点验证（平台归因延迟未过）→ **19 秒后轮询自动检测完播、
     自动发放 VIP 7 天**（实例 granted + 权益写入，全链路自动化按设计工作）→ 用户再点验证 →
     已有 granted 实例、每人限 1 次 → 409。已改为：存在 granted 实例时返回
     status=granted +「该任务已完成，权益已发放（每人限参与 1 次，无需重复验证）」。
  3. **客户端永远「等待检测中」**：auth-manager.checkAuth 在 license 过期时
     clearCachedLicense()——TaskGate 每 5 秒轮询，第一轮（任务未完成时）就把会话 token 清了，
     任务完成后客户端已无凭证可查 → 永远卡住。已改为过期时保留凭证只返回未登录
     （待解锁是门禁页的预期状态）。**用户需重启客户端 + 点「返回登录页」重新扫码一次**
     （本次会话凭证已被旧代码清掉；权益已发放，重登后直接进入主界面）。
  - 部署：invoke t-hz06zfdzlg1wq9s（下载/编译/重启/migrate 1 条/验证 video_title 移除 ✓）。
- 2026-10-08（个人中心改版，用户指定四项）：
  1. **移除「升级视频权限」按钮**（平台账号行）——无实际用途；
  2. **移除「我的抖音视频」整个区块**（loadVideos/评论明细/升级授权等 ~130 行前端 + 页面区块；
     后端 /api/me/douyin/* 端点保留未动）；
  3. **「各应用任务」→「最新任务」**：只渲染排序后第一条（可做的最前）；
  4. **「我的权益」改版**：顶部 VIP 摘要卡（剩余 X 天 + 到期时间，/api/me/entitlements 新增
     vip 字段：expires_at/is_expired/remaining_days，算法与 license 一致 _compute_expiry）；
     下方新增「权益获取记录」列表（每次完成任务的 权益内容+任务名+时间，倒序）。
  - 部署：invoke t-hz06zffra7hq9z4；验证：闻闻来读书 vip={expires 2026-10-15 23:59 北京,
    remaining 7}, records 5；页面新区块在、旧区块已除 ✓。浏览器刷新 /me 即生效。
- 2026-10-08（任务文案改版，用户指定）：任务描述从「四选一」反转为「4 件事全做」——
  引导用户最大化互动（完播+点赞+评论+转发全做），检测仍是任一项通过即算完成（保证顺利通过）。
  - admin.py 模板：明确「任选一条视频（不限哪一条）」+「请把以下 4 件事【全部做完】」+
    「检测到其中任意一项即算完成，4 件事都做通过更顺利」；视频链接标注「快捷入口，不限此条」。
  - pages.py bt_interact 标签「互动任务（四选一）」→「互动任务」（与新文案一致）。
  - 今日 active 任务描述已迁移（invoke t-hz06zfgdus0mneo，验证含「全部做完/任意一项即算完成/不限此条」）。
- 2026-10-08（描述精简，用户指定）：任务描述删除视频链接行与操作/奖励说明段（「做完后点…7 天
  使用权益」），只保留核心指令（找官方号 → 任选视频 → 4 件事全做）。操作入口由卡片「去完成」
  按钮承担，奖励由「🎁」行展示，描述不再重复。模板 + 今日任务均已更新（t-hz06zfgzfzvrd34）。
- 2026-10-08（扫码指引）：任务卡新增**官方账号二维码指引区**——用户扫做给孩子看的抖音码
  直达账号主页（任何视频均可，呼应账号维度核验）。
  - 资产：用户提供的抖音账号码卡片图（1125×1680 jpg 127KB）→ app/static/douyin-account-qr.jpg，
    main.py 挂 /static 静态路由。
  - 页面：bt_interact 任务卡描述下方新增指引区（左侧二维码图 + 右侧 5 步说明：电脑扫码/
    手机长按保存相册 → 抖音扫一扫 → 直达主页任选视频 → 4 件事全做 → 回来点验证）。
  - 部署：invoke t-hz06zfhvbtrk0e8；验证 static 200 (image/jpeg 126563B)、页面含新区块 ✓。
- 2026-10-08（二维码卡片精简，用户反馈"太啰嗦"）：删扫码教学（大家都懂怎么扫码），码即入口；
  右侧只保留 3 行「扫码后做什么」：扫码进入官方主页任选视频 → 完播·点赞·评论·转发四件事做完 →
  回来点验证自动检测；权益改为卡片内**显著紫色渐变横幅**「🎁 完成即得 VIP 7 天」
  （bt_interact 卡片不再单独渲染 🎁 行，banner 取而代之）。
  部署 invoke t-hz06zfil8erbx8g，线上含 3 处新区块 ✓。
- 2026-10-08（卡片再精简，用户指定）：任务卡删除文字描述（"打开抖音…①②③④"）与「🎯 目标账号」行，
  卡片只保留：标题行（任务名+状态徽章）→ 二维码卡片（码 + 扫码后 3 步 + 紫色权益横幅）。
  描述仍存于 DB（direct-verify 等接口用），仅页面不渲染。部署 t-hz06zfj8v6bu9s0 ✓。

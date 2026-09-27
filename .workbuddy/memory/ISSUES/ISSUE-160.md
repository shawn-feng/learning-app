# ISSUE-160：网页端刷新即注销（需重登家长账号）——本地陈旧 expires_at 硬登出 + 服务端离线降级缓存叠加

- **类型**：bug / 鉴权（Web 端首报，Electron 同病）
- **记录时间**：2026-09-27
- **状态**：✅ 已实施（双端 checkAuth/authCheck 重写，见实施记录）

## 现象

网页端登录成功后，**刷新页面即被踢回登录页**，需要重新输入家长账号密码；用户预期：家长账号在有效期内，刷新不应退出。

## 根因（2026-09-27 排查，201 只读探针 + 本地日志佐证）

1. **服务端鉴权链路本身是通的**：本地 dev 日志 /auth/license 全 200；201 用其自身 jwtSecret 签 token 打 /auth/license 也 200。session token（7 天 TTL）有效、jwtSecret 未因部署轮换（0.5.17 部署前后备份对比一致）。
2. **真正的根因是两层缓存叠加**：
   - 201 的 `/auth/license` 走「向公网刷新授权 → 失败则降级返回本地缓存」路径（routes/auth.ts:121-140）。**201 连不上公网认证服务**，于是返回的是 parents.license_json 里的降级旧缓存——`expires_at: 2026-09-24`（已过期 3 天）、`is_expired: false`（缓存时刻还 valid）。
   - 客户端 checkAuth/authCheck（Electron auth-manager.ts:176-205 / web shim auth.ts）在云端复核**之前**，先按**本地缓存**的 expires_at 做硬登出判断：`expires_at < now` → 清凭证回登录页。本地缓存的 expires_at 同样停在 09-24。
   - 合成效果：**登录成功（login 不检查 expiry）→ 下一次刷新/重启，本地硬检查立刻判过期 → 清缓存踢回登录页**，死循环。
3. 「网页端还是有问题」（用户同日消息）：201 的 web/dist 包是 **09-24 15:53** 的旧 bundle——ISSUE-159 的 materials 回填修复与全部新 UI 都不在其中，需重新部署 web 包。

## 方案（已实施）

checkAuth/authCheck 重写为**服务端权威 + 离线降级**：
- 无本地凭证 → 登录页（不变）；
- GET /auth/license（带 token）：
  - **200** → 用返回的 license **续写本地缓存**（email/token 保留本地，cached_at 刷新）并放行；响应 `is_expired=true` → 清凭证登出（服务端权威）；
  - **401**（token 失效，或服务端可达公网且公网判定授权失效）→ 清凭证回登录页；
  - **网络错误/服务端不可达（含 502 降级无缓存）** → 离线降级放行，保留登录态。
- 删除「本地 expires_at < now 即登出」的前置硬检查——有效期判定以服务端为准，本地缓存只作离线兜底。

语义说明：服务端降级返回的旧缓存 `is_expired=false` 时客户端放行——即「服务端没判你失效，你就在」。等 201 能连公网时，/auth/license 会刷新到真实授权状态：若云端已续期 → 缓存自动更新；若云端判定过期 → 401 → 正常登出。

## 回归

- `test/issue160-auth-persist.test.ts` 4 用例：①本地 expires_at 已过期 + 服务端 200 → 放行并续缓存（死循环主案）；②服务端 401 → 清凭证；③网络错误 → 离线降级放行；④200 但 is_expired=true → 登出。
- 双端 build、web-shim 覆盖、全量相关测试通过。
- **生效条件**：web 端需重新部署 web/dist（201 当前 bundle 是 09-24 的）；Electron 随下个客户端包发布。

## 追踪（2026-09-27 下午）：修复按设计工作，用户仍见「刷新即登出」——根因是云端订阅真实过期

- 用户反馈修复后仍被登出；澄清测试环境为**本地 dev web 端（localhost:8788）**，非 201。
- 排查链（全程只读实证）：
  1. server-dev.log：/auth/license 全 200、无 401——服务端从未拒绝会话；
  2. 新 authCheck 仅两种情况登出：响应 `is_expired=true` 或 401；
  3. 本地 jwtSecret 签 token 实测 /auth/license → `200 + is_expired:true`（expires_at 2026-09-24）；
  4. 直打云端 `https://www.aixuexihao.top/api/license`（账号 cloud_token）→ 同样 `200 + is_expired:true`；
  5. ECS 只读探针：认证链路 = learning-server → cloud-service（/opt/learning-cloud，:8000，www 反代；benefit-auth :9001 未接入，配置注释「暂接 www」）；cloud-service 的 app.db subscriptions 表 test@qq.com 行 `status=active, starts_at=2026-08-25, expires_at=2026-09-24`（30 天订阅已过期 3 天）。
- 结论：**ISSUE-160 修复无问题**（服务端权威生效）。登录链路不校验有效期 → 过期账号能登录；网页每次刷新核验 → 云端判定过期 → 按设计登出。桌面端「正常」是因为旧代码只在启动时检查 + 登录不校验 + 不重启（重启同样会被踢）。
- 待用户决策：A）云端 UPDATE 该订阅 expires_at 延期（先备份 app.db）；B）过渡期语义调整——benefit-auth 接入前不强制 cloud-service 试用期过期。
- 旁证：云端订阅表 22 行全为测试账号，无真实家庭账号；201 连不上云端走降级缓存，家庭用户不受影响。云服务缺续期/管理接口（后续 benefit-auth 一并解决）。
- 补充澄清（同日）：dev 桌面客户端数据目录 = 仓库根 data/（getDataDir 非 packaged 分支），连 127.0.0.1:8788；其 license.json 显示 15:03:15 登录成功（token iat == parents.updated_at 秒级一致），**内容已是 is_expired:true** —— 即云端已判过期但登录照常放行，桌面端"正常"只是登录后整个会话不再校验（下次启动 authCheck 仍会踢）。%APPDATA%\learning-app\app-data 是安装版客户端的独立数据（指向 201，9-24 后未动），与本地 dev 测试无关。

## 解决（2026-09-27 15:5x）：云端订阅延期 30 天（方案 A）

- 用户决策：benefit-auth 未上线前，先把 cloud-service 里 test@qq.com 的订阅延长 1 个月；接入 benefit-auth 后再切权威授权源。
- 执行：ECS 上先备份（/opt/learning-cloud/database/app.db.bak-20260927-renew）→ UPDATE subscriptions SET expires_at = 2026-10-27T07:54:04Z（now+30d，与注册发订阅 30 天口径一致；原值 2026-09-24T02:02:43Z）WHERE id=f7c4af20… AND parent_id=86a84278…，rowcount=1。
- 双重复验：云端 /api/license 200 + is_expired:false；本地 /auth/license 200 + is_expired:false（服务端缓存随上游刷新）。
- 客户端无需任何操作：新 authCheck 每次刷新都会以服务端最新判定覆盖本地缓存，刷新即恢复并保持登录。
- 遗留：① 登录链路不校验订阅状态（过期账号能登录、首次校验才被踢）——建议后续登录时即拦截提示；② cloud-service 无续期/管理接口，随 benefit-auth 一并解决；③ 201 部署（server.cjs + web/dist）仍待用户确认，与本问题无关。

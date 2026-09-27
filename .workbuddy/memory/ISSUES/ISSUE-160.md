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

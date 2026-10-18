# [ISSUE-188] 会话 JWT 滑动续签 + VIP 到期「任务门禁」不重登（免扫码恢复）

- **类型**：体验修复 / 认证生命周期（客户端 + learning-server + benefit-auth 三端）
- **优先级**：高（ISSUE-187 的直接成因；`app 用 7 天就要重扫` / `VIP 到期被踢回登录页` 都是它）
- **状态**：✅ 已实现 + **learning-server 0.5.39 已部署 201（2026-10-18 17:39，滑动续签线上冒烟通过）** + **客户端 0.1.32 已本地打包（未发布）**；ECS benefit-auth 未部署（设备级 365 天 cloud token 待另走 ECS）
- **记录时间**：2026-10-18
- **关联**：ISSUE-187（SSE 死句柄重建，需本 issue 一起上线才完整）、ISSUE-160（授权过期不踢人）、ISSUE-164（任务门禁保留凭证）

---

## 一、用户需求（2026-10-18 原话）

> 可以按照 A 方案进行。同时再调整一下，当 vip 到期时，客户端 app 不需要重新登录，只提醒要完成任务，当登录的抖音账号完成任务后，app 就可以使用，不需要重新扫码登录。

三条要求拆开：
1. **A 方案**：会话 JWT 滑动续签（`/auth/license` 等已鉴权请求回签新 token）；
2. VIP 到期**不踢回登录页**，改「去完成任务」门禁；
3. 完成当日抖音任务后**自动恢复**，全程**不重新扫码**。

## 二、两层「7 天」先分清（这是需求的核心歧义）

| | **vip_days（账号权益）** | **session JWT（登录会话）** |
|---|---|---|
| 签发方 | benefit-auth（`/api/account/license` 实时算） | learning-server（`signSession`，`tokenTtlDays=7`） |
| 有效期 | 完成日 +7 天（23:59:59+08，取 max 不叠加）；特批 2099 | 固定 7 天，**原实现只在登录时签一次** |
| 过期现象 | 权益到期（可完成任务恢复） | 所有请求 401；SSE 重连 401 → ISSUE-187 死句柄 |
| 本 issue 改的是 | **不改**（benefit-auth 权益算法保持原样） | **改**：滑动续签 + 到期走门禁 |

> 现场（10-17）：账号权益 2099 永久、JWT 12:39 到期 → 13:07 SSE 重连 401 → 全天 4 小时
> `/prompt` 全 200 而客户端 0 事件（ISSUE-187）。所以「7 天」是 JWT 的，不是 vip_days 的。

## 三、A 方案：会话 JWT 滑动续签（learning-server + 客户端）

### 服务端
- 新增 `server/src/auth/session-renew.ts`：
  - `renewIfNeeded(token, {secret, ttlDays})`：`verifySession` 成功后，若 `exp - now ≤ TTL/2`（7 天 TTL → 剩 ≤ 3.5 天）则 `signSession` 回签（身份 parent_id/email/plan 原样）；
  - 全局 `onRequest` 钩子：只对 `/api/v1/*` 生效；token 取 `Authorization: Bearer` 或 `?token=`（SSE）；`laxk_` 开放 API Key、无 token、无效 token 一律跳过；
  - 回签结果写响应头 **`X-Session-Token`**（不改变原响应体，向后兼容）。
- `server/src/auth/jwt.ts`：`verifySession` 回填 `exp`（判据需要）。
- `server/src/index.ts`：路由注册前挂 `registerSessionRenewHook`。
- **为什么不会请求一次换一枚**：换完剩余回到 7 天，下一次要 3.5 天后才再换；桌面端 config-sync 每 2 分钟一条请求，天然保活。

### 客户端
- 新增 `electron/lib/session-token-store.ts`：`adoptSessionToken(token)` 把新 token 写回 `license.json`（无凭证/同值/坏文件 → no-op）。
- `electron/lib/server-client.ts`：五个 fetch 家族在拿到响应后统一检查 `x-session-token` 并采纳。
  - 之后 HTTP 自动用新 token；SSE 的 `sessionToken()` 每次重连都重读 `license.json`，也自动用新 token。
- `electron/lib/auth-manager.ts` `checkAuth`：采纳后用**缓存里的最新 token**（否则会用旧 token 覆盖新 token）。
- Web shim 同步：`web/src/shim/core/server-fetch.ts` 同样采纳该响应头（页面刷新/轮询即可保活）。

## 四、VIP 到期 → 任务门禁（不重登、免扫码恢复）

### 判定与路由
- `checkAuth` 返回扩展为 `{authenticated, license, me_url?, reason?}`：
  - `reason = "license-expired"`：服务端 200 且 `is_expired=true` → **保留凭证 + 缓存最新 license**（含 expires_at/email）+ 带 `me_url`；
  - `"session-invalid"`（401）→ 清凭证回登录页；`"offline-ok"` → 网络错误离线放行。
- `src/App.tsx` 启动分支：`authenticated` → 主页；`license.is_expired` → **任务门禁页**（不是登录页）；否则 → 登录页。
- 新增 app 级周期检测（5 分钟）：仅在 `home` / `dashboard` 时调 `authCheck`，权益到期即切门禁；不打断正在学习的孩子（`learn` 页不检测）。
- `src/pages/TaskGate.tsx`：新增 `expired` 文案——「学习权益已到期，完成今天的抖音互动任务即可恢复——账号仍处于登录状态，**不需要重新扫码登录**」；仍每 5 秒轮询，解锁即进主页。

### me_url（免扫码的关键）
- `server/src/routes/auth.ts` `GET /auth/license` 响应新增 **`me_url`**：
  - `parents.benefit_user_token` 在时 → `${upstreamBase}/me?token=<benefit 用户 token>`（页面免登录）；
  - 否则裸 `${upstreamBase}/me`。
- 新纯函数 `server/src/auth/me-url.ts`（含单测）；`douyin-login.ts` 登录响应也复用服务端 me_url（旧服务端字段缺失时本地兜底）。

### 为什么「完成任务后自动可用」成立
- 门禁页每 5 秒 `authCheck` → 服务端每次都向 benefit-auth 重新取 license → 完成任务后 `is_expired=false` → 自动进主页；
- benefit-auth 侧本来就是「完成任务 → 发 `vip_days` 权益 → license 实时算」，无需额外改动。

## 五、必须一起改的一条：cloud token 72h → 设备级长效（benefit-auth）

**发现**：learning-server 存的是 benefit-auth 的 `user token`，而 `USER_TOKEN_TTL_HOURS = 72`。
若不改，「app 连续使用 3 天后重启/刷新 license」就会因 cloud token 过期收到上游 401 → 服务端 401 →
客户端清凭证 → **又变成重新扫码**，本 issue 的目标无法成立。

**改动**（`benefit-auth/app/security.py`）：
- 新增 `DEVICE_TOKEN_TTL_DAYS`（env 可调，默认 **365 天**）与 `create_device_token()`；
- `account.py`（login/register）与 `legacy.py`（douyin-login / douyin-code-login）返回的 `token` 改设备级长效；
- 网页会话 Cookie / `/me` 页仍用 72h 用户 token（`oauth.py` 不动）——长效 token 只存 learning-server 侧，不进浏览器 URL（除 me_url 的查询参数）。
- `main.py` 版本 0.2.1。

> 说明：这是「不重新扫码」能长期成立的前提；若 TTL 不延长，本 issue 只能保证 3 天内。

## 六、验证

- 新增 `test/issue188-session-renew.test.ts`（11 例）：续签判据（>TTL/2 不换、≤TTL/2 换且身份/TTL 正确、过期/伪造/异 secret/laxk_ 不换）、token 提取（Header + SSE query）、钩子头行为（API/非 API/新鲜 token/URL `?token=`）、`buildMeUrl`。
- 新增 `test/issue188-session-token-adopt.test.ts`（4 例）：采纳写回/同值幂等/未登录 no-op/坏文件不覆盖。
- 新增 `test/issue188-vip-gate.test.ts`（7 例，源码契约）：App 启动按 `license.is_expired` 进 task-gate（且早于 parent-login 分支）、门禁收 `expired`/`ME_FALLBACK_URL`、home/dashboard 5 分钟复检；TaskGate「不需要重新扫码」文案与 5s 轮询；`/auth/license` 返回 `me_url`、`index.ts` 在路由前挂续签钩子。
- 更新 `test/issue160-auth-persist.test.ts`：`is_expired=true` 从「清凭证登出」改为「保留凭证 + 返回 license/me_url」（ISSUE-188 语义）。
- **真实 Fastify 注入探针**（`tmp/diag-201/probe-renew.ts`）：近到期 token → 响应 200 且带 `X-Session-Token`；新鲜 token → 不带（确认 onRequest 设的 reply 头能到客户端）。
- 相关回归：`server-agent-client` 27 + `issue187` 4 + `app` 4 + `functional` 16 + `issue167` 5 + `issue179` 5 + `issue145` 5 + `issue146` 26 + ISSUE-188 三文件 22 + issue160 4 = **111/111 全绿**。
- 构建：`npm run build` 主进程/预加载通过、产物含 `x-session-token`/`adoptSessionToken`；**渲染层与 web 构建在本机仍卡 esbuild 删临时文件 EPERM（环境问题，未动这两处逻辑）**，需在 macOS/CI 构建验证；`server` tsc 仅既有 3 文件类型债；`benefit-auth` 三文件 `py_compile` 通过；所有改动文件 UTF-8 无 BOM/无乱码（PS 重写踩坑后复核）。

## 七、部署清单（**2026-10-18 已执行：201 已部署 0.5.39 + 客户端 0.1.32 已本地打包；benefit-auth/Web 未部署**）

| 目标 | 内容 | 状态 |
|---|---|---|
| benefit-auth（ECS） | `security.py`/`account.py`/`legacy.py`/`main.py` + 重启 `benefit-auth.service` | ⏳ **未部署**（设备级 365 天 cloud token 待 ECS；不部署时滑动续签已生效，存量 72h token 仍会 401 一次） |
| learning-server（201） | `server.cjs` **0.5.39**（含 session-renew 钩子 + `/auth/license` me_url） | ✅ **已部署（2026-10-18 17:39）**：version/health/标记/超集全过，线上冒烟已回 `x-session-token`；备份 `server.cjs.bak-20261018-173934` + `data/backups/deploy-0.5.39-20261018-173934` |
| 客户端 | **0.1.32**（含 ISSUE-187 死句柄重建 + 本 issue 客户端半边 + ISSUE-189 音量门） | ✅ **已全平台打包（未发布）**：Windows NSIS（本机）+ Linux deb/AppImage + macOS x64/arm64 dmg（GitHub Actions，tag `v0.1.32`），产物均归拢到 `dist/`；mac x64 首跑 npm ci 超时已重跑成功 |
| Web（201 `web/dist`） | 重新构建换装（shim 采纳 + `authCheck` me_url） | ⏳ 未部署（`web:build` 已通过，可选同批） |

**存量 cloud token 的过渡**：未重扫的家长在 72h 后仍会 401（这是旧 token 的既成事实）。服务端可选降级：对「上游 401 但有本地缓存」返回缓存 + `degraded`（现状是直接 401）——本 issue **未改**，避免掩盖真实失效；如需「老 token 也免扫码」，需另做 refresh token 或在过渡期放宽。

## 八、边界与未做

- **滑动续签不涉及权益**：VIP 到期照样走门禁/任务；续签只解决「登录会话」过期。
- **长时间不打开 app**：超过 365 天（设备 token）或 JWT 连续 7 天无任何请求（如合盖休眠）后仍需重新扫码——这是没有 refresh token 时的固有边界；如需彻底免扫码，二期做 refresh token（哈希存 `parents`，客户端仅存服务端）。
- **老客户端**：0.1.30 不读 `X-Session-Token`，服务端回签对它无效（不报错）；必须升级 0.1.32 才享受滑动续签与门禁体验。
- **SSE 响应头**：SSE 路由用 `reply.raw.writeHead` 自行写头，续签头对 SSE 不生效（无需生效——SSE 重连读的是 license.json 里被 HTTP 请求续签后的 token）。
- **未做**：web 端 `authCheck` 的 `reason` 字段（App 只用 license.is_expired，够用）；门禁页「立即再检测」按钮（5s 轮询已足够）。

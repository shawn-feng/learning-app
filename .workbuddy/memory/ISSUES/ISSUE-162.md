# ISSUE-162：日志导出入口补全——孩子端可导客户端日志；家长端可导客户端 + 服务端日志

- **类型**：可观测性 / 日志导出（ISSUE-044 遗留增强）
- **记录时间**：2026-09-27
- **状态**：✅ 已实施（见实施记录）

## 需求（用户原话）

「可以在客户端导出日志，孩子端可以导出客户端日志，家长界面可以导出服务端和客户端日志。增加导出按钮，放到在设置里。」

## 现状（实施前）

- 家长端「通用设置 → 诊断」已有「导出应用日志」按钮（ISSUE-044 v1，`app:exportLog` → 主进程弹保存框导出 `data/client-log.jsonl`）。
- 孩子端无任何日志导出入口。
- 服务端日志（`server/data/logs/server-log.jsonl`，ISSUE-044 v1 落盘）只能在服务器本机 tail，客户端/网页端无法取回——家庭部署场景（201 在家里、客户端在别的机器）排查时拿不到服务端日志。

## 方案

1. **服务端**（`server/src/routes/logs.ts` 新增）：
   - `GET /api/v1/logs/server`（authParent JWT）：读 `server-log.jsonl` 全文返回 `{content}`；文件缺失返回 `{content: ""}`（不算错误）。
   - `GET /api/v1/logs/client`（authParent JWT）：客户端日志不在服务端（在每台客户端本机），恒返回 `{content: "", note: "client-log 在客户端本机"}`——占位语义，防端点混淆。
2. **Electron**（ipc-handlers + preload）：
   - `logs:exportServerLog`：用 `currentSessionToken()` 带 Bearer 调 `/api/v1/logs/server`（`serverFetch` 文本模式），主进程弹保存框写 `server-log-YYYY-MM-DD.jsonl`；401/网络错误透传服务端 error。
   - `logs:fetchServerLogTail`（limit?）：同链路取最近 N 条（诊断面板后续用）。
   - 客户端日志导出沿用现有 `app:exportLog`（两端共用）。
3. **UI**：
   - 家长端 `GeneralSettings.tsx`「诊断」区：在现有「导出应用日志」旁加「导出服务端日志」按钮（服务端不可达/未登录时显示服务端返回的错误文案）。
   - 孩子端 `Learn.tsx`「AI 伙伴设置」弹框底部加「诊断」小节：「导出本机运行日志」按钮（复用 `app:exportLog`，与家长端同链路；不暴露服务端日志——孩子凭据无权读取）。
4. **web shim**（`misc.ts`）：
   - `appExportLog` 保持「不支持」（浏览器无本地日志文件）；
   - 新增 `logsExportServerLog`：直接 `http("/logs/server")` 拿 content → 浏览器 download blob（文件名同 Electron）；服务端日志在 web 端反而畅通（同源带 token 即可）。
   - web 端无孩子端独立部署形态（同页面两角色），孩子端按钮在 web 下走同一导出，失败文案对齐。

## 隐私/权限红线

- 服务端日志含访问日志（ip/path），**只对家长 JWT 开放**；孩子端不提供服务端日志入口。
- 日志本身不含对话正文与密钥（ISSUE-044 红线沿用）。

## 实施（2026-09-27）

- `server/src/routes/logs.ts`：两条只读路由 + `index.ts` 注册（`registerLogsRoutes`）。
- `electron/lib/ipc-handlers.ts`：`logs:exportServerLog` / `logs:fetchServerLogTail`（复用 dialog 保存范式）；`electron/preload.ts`：`logsExportServerLog` / `logsFetchServerLogTail`。
- `src/components/GeneralSettings.tsx`：诊断区第二枚按钮（Download icon）+ 独立结果提示。
- `src/pages/Learn.tsx`：AI 伙伴设置弹框底部「诊断」区（FileDown 按钮）+ `logExportMsg` 状态。
- `web/src/shim/domains/misc.ts`：`logsExportServerLog`（blob 下载）/ `logsFetchServerLogTail`（真拉服务端）。
- 回归：`test/issue162-log-export.test.ts`（fastify inject + 真 sqlite + JWT，覆盖 ① server 日志 200 形状/含已写行；② 空文件 200 content:""；③ 缺 token 401；④ client 占位端点 200 note 语义；⑤ 日志写入→导出→内容一致性）。

## [ISSUE-051] 会话同步：珊珊（本地环境）持续报 500 internal server error
- **类型**：Bug（服务端同步接口抛未捕获异常 → 500）｜**状态：已修复并部署（2026-09-06，server 0.3.3 上线 201）**
- **现象**：本地环境会话同步面板里，珊珊这个孩子**一直**报同步错误，错误类型为 `http:500`（internal server error）；其他孩子正常或偶尔失败。客户端侧代码本身不会抛 500，500 必然是服务端 `POST /api/v1/sessions/:childId/sync` 在处理 珊珊 的某一文件时抛了**非 ApiError 的异常**（fastify 自动转 500）。
- **最强根因假设（高度关联 珊珊 在用英语课程子会话）**：
  - 客户端自 ISSUE-029 起，会话 jsonl 走子目录（`sessions/<childId>/.pi/agent/sessions/english-<title>/xxx.jsonl`），`walkJsonlFiles` 上传时 `name` 用**带 `/` 的相对路径**（如 `english-12-yellow-01/xxx.jsonl`）以区分同名文件、避免游标冲突（`electron/lib/session-sync.ts:81,97-113`）。
  - 服务端 `sanitizeSessionFile(name)`（`server/src/db/sessions.ts:19-25`）用 `path.basename(name)` 校验：`base !== name`（带斜杠即不相等）→ **直接 `throw new Error("非法会话文件名")`**。
  - 该 `throw` 不是 `ApiError`，在 `routes/sessions.ts:93-96` 的 `appendAndIndexSession` 调用里被 `handleAuthError` 放行（返回 false）→ `throw err` → fastify 兜底成 **500**。珊珊用英语子会话 → 名字带 `/` → 必 500。
- **次要根因假设（需排查时顺手排除）**：
  - `server.sqlite` 缺 `session_messages` / `session_files` 表（迁移未跑）→ `appendAndIndexSession` 内 `db.prepare/insert.run` 抛 SQL 错 → 500（但会**所有**孩子同步都失败，与"仅珊珊"矛盾，概率低）。
  - 磁盘/权限：`fs.appendFileSync` / `fs.statSync` 写 `data/sessions/<parent>/<child>/` 失败 → 500（局部性，可能只命中珊珊目录）。
  - 单行超 `bodyLimit`（8MB，`routes/sessions.ts:51`）被 fastify 拒 → 但那是 413 不是 500，排除。
- **排查/确认步骤**：
  1. 看客户端 `data/sync-log.jsonl` 里 珊珊 的 `errType` 是否 `http:500`（确认是服务端拒）。
  2. 看本地服务端日志（ISSUE-044 统一日志；或 server 进程 stdout）搜 `非法会话文件名` 或 500 的 stack —— 若有 `非法会话文件名: english-.../xxx.jsonl` 即坐实根因①。
  3. 核对服务端 db 是否含 `session_messages`/`session_files`（`sqlite3 server/data/server.sqlite ".tables"`）。
- **修改入口**：
  - **主修**：`server/src/db/sessions.ts:19-25` `sanitizeSessionFile` 需允许路径分隔符——逐段 `path.basename` 校验每段、拒绝绝对路径/`.`前缀段/超长，再用 `path.posix.join` 归一；或直接改为"扁平化"把 `/` 换成 `_`（但会丢子目录隔离，治标）。**更稳的做法**：校验每段合法后保留相对路径，`getSessionsDir`/`appendAndIndexSession` 的 `path.join(dir, file)` 自然重建子目录，且 `session_messages.file`/游标键用相对路径保持与客户端一致。
  - **加固**：`routes/sessions.ts` 的 `appendAndIndexSession` 调用应把非 `ApiError` 异常也转成明确 400/422（非法文件名）而非 500，避免任何异常被静默升级成 500 掩盖真实错误。
  - 客户端 `collectDeltas`（`session-sync.ts:91`）可加：同名文件冲突检测日志（辅助确认是否还有碰撞）。
- **优先级**：高（珊珊会话数据持续无法上云，家长回看/每日汇总会漏 → 与 ISSUE-043 同源问题；本地环境即可复现，建议先于 043 收尾修复）。
- **记录时间**：2026-09-05
- **✅ 修复落地（2026-09-05，改动全在 `server/src/db/sessions.ts`，本地验证通过，未部署）**：
  - **主修① sanitizeSessionFile 允许子目录相对路径**：改为逐段校验（归一反斜杠→posix、拒绝对路径/盘符/`.`/`..`/隐藏段/空段/末段非`.jsonl`/段>96/总长>512），返回保留子目录的相对路径（如 `english-论语-第三课/abc.jsonl`）。客户端 english 子会话相对路径不再被 `path.basename` 误判非法。
  - **主修② appendAndIndexSession 补 mkdir**：`path.join(dir, file)` 落盘前 `fs.mkdirSync(path.dirname(full),{recursive:true})`，子目录文件可新建（原 appendFileSync 遇不存在子目录会 ENOENT）。
  - **加固③ 非法文件名 → ApiError(400)**：sanitizer 的 throw 由普通 `Error` 改为 `ApiError(400,"非法会话文件名: …")`（import `../auth/proxy.js`，无环），经 `routes/sessions.ts` 既有 `handleAuthError` 走 400 干净返回，不再被 fastify 兜底成 500 掩盖。真实磁盘/sqlite 异常仍 rethrow → 500 + fastify logger 记 stack（正确）。
  - **连带④ readServerDailyConversation 递归**：worker recording 读当天对话改为递归收集 `dir` 下全部 `.jsonl`（english 子会话在子目录），否则嵌套会话文本漏进每日汇总。
  - **验证**：`tsc --noEmit` 0 错；esbuild `dist/server.cjs` 重建成功；tsx 自测 17/17 sanitizer 边界通过（含 `a\..\evil.jsonl` 反斜杠穿越拒、中文课程名相对路径过）+ 端到端 sqlite/mkdir/幂等/递归读 PASS（子目录文件落盘、session_messages.file 存相对路径、session_files 幂等、daily 读到嵌套文本）。
  - ⚠️ 未提交（并行会话 ISSUE-049/050 有未提交改动，勿混入本提交）；本地改动文件仅 `server/src/db/sessions.ts`，dist 已重建但 gitignored。
- **✅ 部署落地（2026-09-06）**：commit `c7d6edb`（单文件 sessions.ts）本地提交；版本 0.3.2→0.3.3（version.ts+package.json，commit `91f9151`）；`node scripts/build.mjs` 重建；本地 `smoke-sessions.mjs` 全过；paramiko 部署到 201（备份 `server.cjs.bak-20260906-0913`）→ systemctl restart → **验证 version=0.3.3、health ok、码点 sanitizeSessionFile/readServerDailyConversation=2 在位**。ISSUE-052/053 为 electron 客户端改动，未含在本 server 部署内。

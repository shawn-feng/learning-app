# ISSUE-173：kb-lint 检查评估——校验对象已不存在、运行条件已失效，建议退役（保留可复用部分或整体删除）

- **类型**：架构 / 清理评估（用户问：kb-lint 这个检查还有必要存在么？）
- **结论（评估）**：**没必要存在了，建议退役**。它是「Markdown 文件时代 + 客户端本地 agent」的数据质检工具，其依据、校验对象、运行条件三者都已随架构演进失效。
- **kb-lint 是什么（electron/lib/kb-lint.ts，283 行）**：
  - 依据 `LEARNING-DATA-SPEC.md 5.5`（**该文档已随 2026-08-24 commit 0d68e77「旧文档清理」删除**——lint 引用的规范本体已不存在）；
  - 校验规则 v4：①kb.sqlite 存在 ②courses.status ∈ {⬜,✅} ③daily/courses 标签 ∈ tags 定义表 ④topics 非空 ⑤**`learning/<topic>/method.md` 里的 kb 工具引用规范**（旧工具名检查/调用参数检查/裸 write/edit 检查）；
  - 运行：Electron 主进程启动时 + 每 24h（main.ts:211-231），报告落各孩子 `lint-report.md`；另有 CLI scripts/kb-lint.mjs。
- **逐条失效证据（已核实）**：
  | 规则 | 失效原因 |
  |---|---|
  | ① kb.sqlite 存在 | 服务端 `openKb` 对每个会话/分配**自动建库建表**（kb.ts:491-495），「未初始化」状态不可能出现 |
  | ② status ∈ {⬜,✅} | status 由 kb_update/进度回写写入，写入端固定取值，无需 lint；且掌握度已迁 `mastery_level` 四档（ISSUE-135），lint 未覆盖新列 |
  | ③ 标签词表 | 写入端 kb_insert/kb_update 已带校验；客户端自由打字场景不存在 |
  | ④ topics 非空 | 分配流程保证；空主题是合法状态（新孩子） |
  | ⑤ method.md 工具引用 | **校验对象已不存在**：`learning/<topic>/method.md` 是文件时代的提示词载体，服务端化后 prompt 收归服务端（parents/*/… + ISSUE-083/144 场景技能机制）；201 与本地两台孩子的目录里**已无 learning/ 目录**（实测） |
  - **运行条件失效**：lintAllChildren 扫描 `data/children/`——这是**客户端本机**目录；服务端化后真实数据在服务端 `data/kb/<pid>/<cid>.sqlite`，服务端 bundle **不含 kb-lint**（grep=0），201 上 lint 从未跑过（唯一 lint-report.md 停在 2026-08-28 Electron 时代）；客户端本机的孩子目录只剩 kb.sqlite/uploads/profile 等，lint 对着过时快照跑。
  - **写入端已收口（lint 的存在意义被替代）**：kb_insert/kb_update 的语义解析+去重+校验（ISSUE-142 路线 A 后保留的正规通道）、child-db-tools 白名单、ISSUE-131 归并后的路径收口——数据质量由写入端 schema 保证，事后 lint 无增量价值。
- **处置建议（供拍板）**：
  - **A（推荐）直接退役**：删 `electron/lib/kb-lint.ts`、main.ts 的 lintOnce/24h 定时、`scripts/kb-lint.mjs`、各孩子目录残留的 lint-report.md；`kb-schema.ts` 里仅被 lint 用的 KB_DATA_TOOLS/KB_TOOL_REQUIRED 一并清理（kb-sqlite.ts 的查询函数如仍被引用则保留）；
  - **B 保留影子**：若想要「数据质检」能力，把有价值的两条规则（status 值域、标签词表）**迁入写入端**（kb_update/child_db_write 校验里已有类似逻辑，补齐标签词表检查即可），lint 主体退役——比事后扫描更早拦截；
  - **C 不动**：纯死代码，无害但持续误导（每次排查数据问题都会看到 lint-report.md 的 08-28 时间戳，误以为质检在跑）——不建议。
- **回归**：删除后 Electron 启动/24h 定时不再产 lint-report.md；`grep lintAllChildren` 全仓归零；客户端 CLI（scripts/kb-lint.mjs 若有人手跑）失效需同步删；服务端数据链路零影响。
- **优先级**：低（清理项；建议随下次客户端发版顺带）
- **记录时间**：2026-09-28

## ✅ 已退役（2026-10-06，方案 A 执行）

**删除**：
- `electron/lib/kb-lint.ts`（git rm）；
- `electron/main.ts`：import + 启动 lintOnce + 24h setInterval（:212-231 整块）；
- `scripts/kb-lint.mjs`（CLI）；
- `test/kb-lint-method.test.ts`（纯 lint 测试）；
- `electron/lib/kb-schema.ts` 的 lint 专用导出：`KB_DATA_TOOLS` / `KB_AUX_TOOLS` / `METHOD_KB_TOOLS` / `KB_TOOL_REQUIRED`（全仓 grep 确认仅 kb-lint 引用；头注释同步标注退役与工具参数语义真源去向）；
- 本机 `data/children/*/lint-report.md` 残留 7 份；
- `app-logger.ts` 注释里的 kb-lint 模块标签示例。

**保留**：`kb-schema.ts` 的 `DAILY_BLOCKS` / `TAG_BLOCKS` / `PROGRESS_STATUS_VALUES`（数据契约常量，B 方案的潜在迁入物）；`scripts/rename-progress-to-course.mjs`（历史一次性迁移工具，files 集合里有失效路径但有 existsSync 守卫，不篡改历史脚本）。

**验证**：全仓 grep `kb-lint|lintAllChildren|lintOnce|lint-report|KB_*TOOLS*|KB_TOOL_REQUIRED` 归零（仅余 kb-schema 退役注记与上述历史脚本路径）；electron-vite / web 双端构建过；kb-tools + kb-sqlite + app 测试 34 例绿（kb-sqlite 首跑 6 失败为依赖本地 8788 dev 服务端的瞬时抖动，与本次无关——复跑两次 30/30 稳定全过）；服务端零涉及。

# ISSUE-123：孩子库 courses/topics 与家长库的同步机制梳理——无定时同步（分配时快照 + 库域分工解耦），关联靠 topic_key（真引用）+ uuid（分配时冻结副本）；遗留三类漂移风险

- **类型**：记录 / 梳理（库间数据流；含潜在问题，供后续演进引用）
- **问题**：① 孩子库的 courses/topics 表会定时与家长库同步吗？② 孩子库 courses 表用哪个字段与家长库关联？
- **答案（已核实代码）**：
  - **① 不会定时同步——设计上就不需要了**。2026-09-18「库域分工」重构（`db/kb.ts:60-90` schema 注释）：**孩子库 courses = 纯学习进度表**（教学字段副本已删，真源在家长库），**topics = 主题分配表**（仅 name/topic_key/learn_type/孩子级规则）。同步的写入口只有**分配时**：家长分配主题/课程 → `kb.topics.upsert` / `kb.courses.upsert`（`routes/db.ts:580/615`）一次性写入孩子库；此后孩子库进度字段（status/last_review/review_count/tags）由学习过程就地更新，**worker 只读孩子库 courses**（`worker/kb-tools.ts:215`），没有任何定时比对/回填任务。
  - **② 关联字段（两层）**：
    - **`courses.topic_key` = 真引用**（schema 注释明写「topic_key 为真引用（→ topics.topic_key），topic 保留作显示名」）→ 孩子库 `topics.topic_key` → 家长库 `topics.topic_key`；
    - **`courses.uuid` = 家长库 courses.uuid 的分配时冻结副本**：写入时由 `resolveCourseUuid()`（`routes/db.ts:31-43`）现查家长库（先 topic+title 精确、**落空退 title 单字段全局匹配**）并把结果**冻进行里**（可空，查不到存 ""）；
    - `courses` 主键 = **(topic, title) 显示名对**——名字一改就对不上。
- **遗留漂移风险（无定时同步的代价，按影响排序）**：
  - **R1 分配后家长库改名/重建 → 关联断裂**：孩子库 (topic,title) 主键和冻结 uuid 都不随之更新；家长改课程名后，孩子库旧行成为孤儿（进度还在，但按新名字查不到、uuid 指向旧课程）；
  - **R2 分配后家长库新增课程 → 孩子库缺失**：考核计划创建依赖**孩子库**有该课程行（`parent-plans.ts:776` 按孩子库 courses 校验），新加课程未重新分配即报「课程在孩子库里不存在」——同步缺口的最常见症状；
  - **R3 title 兜底匹配误连**：`resolveCourseUuid` 的 title 单字段回退在跨主题重名课时会连错 uuid（静默）。
- **候选演进（如需彻底解，供拍板）**：A 轻量对账——worker 每天比对家长库 (topic_key,title,uuid) 与孩子库行，改名词/新课程自动更新孩子库（保进度字段，仅修引用列）；B 读取时联查——孩子端课程列表改为「家长库真源 LEFT JOIN 孩子库进度」，孩子库只存进度（主键改 uuid 或 topic_key+title）——彻底无副本但改动面大；C 维持现状 + prompt/文档声明「改课程结构后需重新分配」。R3 无论选哪个都建议把 title 兜底改为仅同 topic 内匹配。
- **R1 深化：title 变更到底怎么同步（2026-09-21 追问，前提先立锚点）**：
  - **前提：同步锚点 = uuid，改名必须保 uuid——现状做不到**。`parent_upsert_course` 是 `ON CONFLICT(topic, title)` 的 upsert（`parent-tools.ts:445`）：**改 title = 不冲突 = 新插一行、新 uuid，旧行残留家长库**（新旧两行并存）。所以第一步是**在写入侧立「保 uuid 改名」语义**：家长库加显式 rename 动作（`UPDATE courses SET title=? WHERE topic=? AND title=?`，uuid 原地不动；可做成 `parent_upsert_course` 的 `rename_from` 参数或独立 `parent_rename_course` 工具）；db 通道 `parent_db_write` 的 UPDATE 分支天然保 uuid，但 prompt 应引导改名走显式动作而非"删旧建新"。
  - **同步动作（写时联动为主 + 对账兜底）**：
    - **写时联动（及时）**：rename/UPDATE title 成功后立刻遍历该家长所有孩子库执行 `UPDATE <kb>.courses SET topic=?, title=? WHERE uuid=?`——进度字段（status/last_review/review_count/tags）原地保留，只修显示名与主键；跨主题移动同式。收口点：rename 动作 + db 通道 courses.title 更新。
    - **对账 worker（兜底 + 修存量）**：每日按 uuid 比对家长库与各孩子库，(topic,title) 不一致则更新；家长库已删课程的孩子库行标记孤儿（进度保留、不出现在有效列表）。
  - **救不回的场景**：改名已经以「删旧建新」发生（uuid 变了）→ 按 uuid 对不上，只能按 (topic_key, title_old) 工具辅助人肉确认迁移，或接受进度重新累积——这正是必须先立「保 uuid 改名」约定的原因。
- **R1 落地工具设计：家长 agent `parent_sync_courses_to_child`（2026-09-21 定稿；title 可变不能当记录标识，uuid 才是——同步按 uuid）**：
  - **参数**：`child`（必填，单孩子，多孩子多次调用）；`topic?` / `titles?` 可选过滤，都不传=全量。
  - **流程三步**：
    1. **补 uuid**：扫孩子库 courses 中 uuid 空的行，按 (topic, title)→家长库解析回填（复用 `resolveCourseUuid`，顺手把 title 兜底收窄为同 topic 内，修 R3）；解析不到的行**不动**、列清单交家长甄别（多为家长库已删课程）；
    2. **按 uuid 同步，三态**：取家长库所选课程（uuid/topic/title/sort_order + topics 解析 topic_key），逐行到孩子库——**uuid 命中已有行** → 只更新显示/排序字段（topic/title/sort_order/topic_key），**进度字段（status/last_review/review_count/tags）一概不动**（孩子的进度不是家长库的数据）；**未命中但 (topic,title) 撞上孩子库 uuid 为空的旧行** → **归并**（给旧行补 uuid + 更新显示字段——防 (topic,title) 主键冲突/重复行，是与 kb.courses.upsert 的核心差异：现有 upsert 的 UPDATE 列表带着进度字段，直接复用会盖掉孩子进度）；**都没有** → 新插入（进度初始 ⬜）；
    3. **返回摘要**：新增/更新/归并/补 uuid 各多少 + 无法匹配清单（孤儿行原样列出）。
  - **边界**：同步永不触碰进度字段与 topics 的孩子级规则（learn_type/rules_json 只核对一致性）；不做删除方向同步（家长库删课，孩子库进度行保留为孤儿，历史进度不丢，是否清理交家长）；topics 分配表按需核对、tags 按需。
  - **实现注意**：白名单 + `createParentAgentTools` return 数组两处注册（ISSUE-089 教训）；重跑幂等；归并防重复行是关键正确性点（归并后进度回写 `WHERE topic=? AND title=?` 仍指向同一行）。
  - **定位**：R1 的落地抓手，也是方案 B（uuid 化主键）的前置——先让 uuid 全员有值、孩子库可按 uuid 寻址。
- **设计问答：有 uuid 了，为什么主键/唯一校验还是 (topic, title)？（2026-09-21 追问）**
  - **uuid 是后补的引用列，不是原生身份**：家长库 courses 建表（`parent-lib.ts:24-36`）主键就是 (topic,title)、**没有 uuid 列**——uuid 是后来迁移补的（`assess-content.ts:62-64`：`ALTER TABLE ADD COLUMN uuid` + 存量 `randomblob(16)` 回填 + 唯一索引），目的是给「孩子库进度 ↔ 家长库真源」的跨库关联一个稳定锚，**不是为了取代名字身份**。孩子库 courses.uuid 同为后补、可空（老行/解析失败存 ""，做主键前得先全量回填）。
  - **产品语义全程按名字寻址**：家长/孩子/agent 说课程都是名字；考核计划 scope_json 存的是课程名（ISSUE-104 的 `[{title,kps}]`）；考核创建校验按孩子库 title 列表（parent-plans.ts:776）；资料路径 `materials/<topic>/…` 也是名字。(topic,title) 主键让**分配天然幂等**（重复分配=更新进度，不产生重复行）。
  - **换 uuid 主键 = ISSUE-123 方案 B 的治本路线**（孩子库只存进度、课程列表改家长库真源联查），收益是改名天然稳定，代价是所有按名字寻址的读路径同批迁移——所以一直没做，短期以「(topic,title) 主键 + topic_key 真引用 + 保 uuid 改名」折中。
- **名字寻址路径全量清单（2026-09-21 排查，R1 改名断裂的影响面 = 以下全部）**：
  - **A. title 单字段寻址（⚠️ 无 topic 限定 + LIMIT 1，跨主题重名课取行不确定）**：
    - `session-registry.ts:371` `courseContextBlock()`——**教学会话进入时**查孩子库进度（status/last_review/title 单字段）；同函数 ：385 以同一 title 查家长库教学字段。查不到即「未分配该课」，改名后教学上下文静默丢进度；
    - `routes/exam.ts:620/675`——考核域按 title 查课程状态（两处单字段）。
  - **B. title IN 列表批量校验（改名后即报「课程不存在」）**：考核计划创建 `parent-plans.ts:783`、孩子自请 `plan-tools.ts:586`、重考 `exam-retake.ts:149`、面板 REST `exam.ts:1063`——四处同款。
  - **C. (topic,title) 双字段精确寻址**：
    - 写：`routes/db.ts:615` kb.courses.upsert（ON CONFLICT(topic,title) 分配/进度）、`:688-735` kb.courses.update（进度回写 `WHERE topic=? AND title=?`）、`exam.ts:684`（考核提交取 uuid）；
    - 读：`plan-tools.ts:178`（学习计划关联课程内容）、`embeddings.ts:477`（嵌入存在性检查）。
  - **D. 列表读（名字驱动展示/排序，不按名字定位单行）**：course_progress 视图（kb.ts:329-354）、exam.ts:386/493/923、parent-tools.ts:293/352、plan-tools.ts:387/536。
  - **现状对照**：孩子 agent 的 `kb_query table=course`（`worker/kb-tools.ts:209-260`）已落 ISSUE-111 向量兜底（精确落空→家长库向量候选），**但 A/B 两组（教学上下文、考核校验）没有任何兜底**——名字一改即静默失联或硬报错。方案 B（uuid 化）落地前，这份清单就是改名操作的「待联动面」。
- **优先级**：低-中（当前分工把漂移面已压到最小；R1/R2 在「家长频繁改课程结构」时才显痛，ISSUE-076 的陈旧行即同类症状）
- **记录时间**：2026-09-21
- **状态**：✅ 已实施并已上线（2026-09-21：**服务端 0.5.2 已于 15:24 部署到 201**，含第二轮「同步范围＝已分配主题」修正；冒烟 28/28）；uuid 主键化（方案 B）与考核计划 scope 自动改写仍待定

## 实施记录（2026-09-21）

### 落地内容
1. **`parent_rename_course`（新，家长会话）—— 改名唯一正确入口**
   - 参数：`topic` + `title` 定位；`new_title` 必填；`new_topic` 可选（接受 topic_key 或中文名）。
   - 流程：家长库定位（含 uuid）→ 撞名检查（家长库目标位已被占用则拒绝）→ **先在每个孩子库按旧名字补 uuid**（`UPDATE ... WHERE (uuid IS NULL OR uuid='') AND topic=? AND title=?`，此时旧名字还在，是唯一能补锚点的时机）→ 按 uuid 改显示名（`SET topic, topic_key, title`）→ 家长库原地改名（`UPDATE SET topic, title`，**uuid 不动**）。
   - 孩子库冲突（已有同名行但 uuid 不同）→ **跳过并点名汇报**，不猜。
   - 知识点/题库挂载在 `course_uuid` 上 → 改名后考核内容不受影响（冒烟已断言）。
   - 返回里**提醒**：已有考核计划的 `scope_json` 存的是旧课程名，需家长核对/重排（未自动改写，见下）。
2. **`parent_sync_courses_to_child`（新，家长会话）—— R1 的落地抓手**（按 ISSUE-123 定稿实现）
   - 参数：`child` 必填（一次一个孩子）；`topic` / `titles` 可选过滤。
   - 步骤 1 补 uuid：扫孩子库 uuid 为空的行，按 `(topic,title)` 在**同主题内**解析回填（顺带修 R3）；解析不到的进孤儿清单。
   - 步骤 2 三态同步：uuid 命中 → 只更新 `topic/topic_key/title/sort_order`（**进度字段一概不写**）；撞上 uuid 为空的旧行 → 归并（补 uuid + 显示字段，防重复行）；都没有 → INSERT（进度初始 ⬜）；uuid 不同但同名 → 跳过 + 点名。
   - 步骤 3 汇报：新增/更新/归并/补 uuid/无需改动 计数 + 跳过项 + 孤儿行 + **主题未分配提醒**（课程入库但孩子看不到，不代分配）。
   - 幂等（二次运行零改动，冒烟断言）；不 DELETE 任何行。
3. **`resolveCourseUuid` 收窄（R3 修复，`routes/db.ts`）**：删掉 **title 单字段全局 `LIMIT 1`** 兜底（跨主题重名会静默连错 uuid），改为**同主题内精确匹配**；同时 topic 参数接受 `topic_key` 与主题中文名（家长库 `courses.topic` 存的是 topic_key）。行为变化：主题确实对不上的存量场景由「可能连错」变为「解析为空」——宁可留空待 sync 步骤 1 报出，也不静默错连。
4. **`parent_upsert_course` 显式写入 uuid**（新行）：原实现不写 uuid，新课程要等下次 `openParentLib` 的幂等回填才拿到锚点，存在 NULL 窗口；现在 INSERT 即带 `randomUUID()`，冲突分支**不动 uuid**（保护锚点）。
5. **prompt（`parent-registry.ts`）新增「课程改名与『家长库 → 孩子库』同步」段**：改名必须走 `parent_rename_course`、点名禁止用 upsert 改名、sync 的触发时机与边界、汇报要求；顺带修掉该段里过期的「status/last_review/review_count 由系统维护」表述（库域分工后家长库已无这些列）。
6. **文档**：技术实现文档新增 **§3.5「家长库 ↔ 孩子库的课程关联与同步」**（无定时同步 / 两层关联锚点 / 改名保 uuid / R1~R3 清单 / 名字寻址影响面指向本文件）、§3.4 工具行、§8.2/§8.3 工具清单、§17 第 17 行、附录 A.1 + 新增 A.3.4。

### 验证
- `server` `tsc --noEmit` **0 错**；`node scripts/build.mjs` 通过（v0.5.0，23.2MB，产物含 `parent_rename_course` ×4 / `parent_sync_courses_to_child` ×3；**注意 esbuild 把非 ASCII 转义成大写 `\uXXXX`，用中文 grep 产物必然落空**）。
- 冒烟脚本（临时库，2~3 个假孩子 + 家长库 8 门课）**34 条断言全 PASS**，覆盖：
  - 改名：进度字段（status/last_review/review_count/tags）两个孩子库均原样保留、uuid 不变、旧行不残留、知识点仍挂同一 uuid、孩子库同名冲突跳过、家长库目标名被占用拒绝、课程不存在友好提示；
  - 同步：命中 uuid 只改显示名且进度保留、uuid 空行补锚点、缺课新增（⬜ 初始）、uuid 冲突跳过、孤儿清单、主题未分配提醒、**幂等二次运行零改动**、topic（中文名）/titles 过滤、孩子不存在提示；
  - R3：同主题精确匹配取对 uuid、同名词条不连到别主题、跨主题不再兜底（uuid 为空）、topic 传中文名仍能解析。
- 脚本跑完即删；输出留 `tmp/smoke-123-result.txt`。

### 部署（2026-09-21 14:54，用户明确同意后执行）
- 版本 0.5.0 → **0.5.1** 部署到 201：停机约 3 秒；`/api/v1/version`=0.5.1、health ok、`ERR_COUNT=0`；包内 `grep -o` 命中 `0.5.1`×1 / `parent_rename_course`×4 / `parent_sync_courses_to_child`×3。
- 备份：bundle `server.cjs.bak-20260921-1454`；数据 `data/backups/deploy-0.5.1-20260921-1454/`（44M，**已实测非空**，13 项）。回滚见 `DEPLOY-201-server-0.4.1-迁移方案-2026-09-15.md` §12.1。
- **只读 dry-run 探针（真实数据，0 写入，`tmp/deploy/probe-sync-diff-051.mjs`）**：
  - 【闻闻】孩子库 1198 行 → 同步将 **新增 147**、更新显示/排序 30；孤儿 1（`lunyu/测试课程`，uuid 空且按名字解析不到）；**主题未分配 6**（english、taodi、xiaojing、xiaozhuan、lianzhi、xiguan）。
  - 【珊珊】孩子库 1329 行 → 同步将 **新增 15**、更新显示/排序 31；孤儿 0；主题未分配 3（feizhougu、other、wenwen_chinese）。
  - 家长库课程 1344 门。→ **R2（家长库有、孩子库没有）在真实数据上确实存在**，正是本工具要修的；「更新显示/排序」只改显示、进度不动。
- 未改客户端。

## 第二轮修正（2026-09-21 用户纠正）：同步**必须以「主题已分配给孩子」为边界**

### 用户报的问题
「课程同步工具有问题，不能全部同步，因为有些学习主题没有分配给对应的孩子。例如**非洲鼓**就没有分配给珊珊。这个工具不能这样用。」

### 问题确认（真实数据实测）
- 首版 `parent_sync_courses_to_child` 的默认范围是「家长库全部课程」（只对未分配主题给了一句提醒），**越了界**：孩子能不能看到某课完全由「主题是否分配给他」决定（`kb.topics.list` → 按 topic_key 逐主题列课），把未分配主题的课写进孩子库 ① 孩子看不到 ② 日后一分配该主题，会一次性冒出上百门「从没分配过」的课。
- **用户已经在 201 上真跑过一次**（证据 = 孩子库行数变化）：闻闻 1198 → **1345**（+147）、珊珊 1329 → **1344**（+15），与「未分配主题课程数」完全吻合。即两个孩子库里各多出 147 / 15 行**未分配主题的课**。
- 其中闻闻的 147 门分布：英语(english) 51、小篆(xiaozhuan) 37、练字(lianzhi) 25、孝经(xiaojing) 18、陶笛(taodi) 13、习惯养成(xiguan) 3；珊珊的 15 门：非洲鼓(feizhougu) 13、杂项学习(other) 1、闻闻的校内语文(wenwen_chinese) 1。**全部为「未动过」的行**（status ⬜ / last_review 空 / review_count 0 / tags 空）。

### 修正内容
1. **同步范围＝该孩子已分配的主题**（`child` 孩子库 `topics` 的 topic_key，同时兼容中文名匹配）：范围内按 uuid 三态同步（逻辑不变），**范围外的主题整体跳过**。
2. **`topic` 参数落到未分配主题 → 直接拒绝**（不再是「照做并提醒」），返回里列出该孩子已分配的主题 + 指路「先在家长端分配主题」。
3. **孩子一个主题都没分配 → 明确拒绝**（原来会静默返回空范围）。
4. **步骤 1「补 uuid」也只在已分配主题内**（范围外的一律不动）。
5. **汇报三分类**：① 已分配主题与范围内课程数；② `⏭️ 未分配主题已整体跳过：N 个主题、共 X 门课（逐个列名+门数）` + 正确做法提示；③ `ℹ️ 孩子库里另有 N 行属于未分配主题（孩子看不到；历史遗留，本次未改动）`。
6. **`parent_rename_course` 不受此限**（它只按 uuid 改**已存在**的行，不新建行、不扩范围）——保留「改到未分配主题 → 该孩子看不到」的提醒。
7. `parent_sync_courses_to_child` 的 description 与 prompt 段同步改写：明写「同步范围＝已分配主题」「未分配主题整体跳过、不代分配」「要让孩子学某主题 → 先在家长端分配」。

### 验证
- `server` `tsc --noEmit` **0 错**；`build.mjs` 通过（v0.5.2）。
- 冒烟脚本 **28 条断言全 PASS**（新语义）：返回标注范围；只检查已分配主题下 5 门；未分配主题（孝经 2 门）整体跳过并说明；`topic=孝经`（未分配）→ 拒绝且列出已分配主题；无分配主题的孩子 → 拒绝并指路；**未分配主题的存量行完全未动**（uuid/进度都保留）；未分配主题的同名课未被写入；已分配主题内补 uuid / 更新显示名时**进度不动**、缺课新增 ⬜；幂等；改名回归（uuid 不变、进度保留、旧行不残留）；R3 回归。
- 真实数据只读 dry-run（修正后）：**范围内新增 0 / 更新 0**（说明首跑已把范围内的对齐了），未分配主题 6 个/147 门（闻闻）、3 个/15 门（珊珊）整体跳过。

### 162 行存量的处置：**用户明确「暂时不删除」（2026-09-21）**
它们**全部无进度痕迹**（是首跑刚插进去的），删除风险极低；但「删除方向」不在本工具语义内（工具永不 DELETE），需要单独一次性脚本。用户决定先留着——不影响孩子看到的内容（未分配主题对孩子不可见），只是孩子库里躺着 162 行看不见的课。若日后要清，做法＝只删「topic 未分配给孩子 **且** status='⬜'、last_review=''、review_count=0、tags='' 」的行，删前先备份。

### 未做 / 待定
- **考核计划 `scope_json.courses` 的名字跟随**：改名后旧计划里的课程名失效（`GET /exam/config` 取不到题）。本轮只在改名返回里**提醒**家长核对，未自动改写（怕动到孩子已排的考核）；如需要可加「pending 计划按 uuid 替换课程名」的联动。
- **方案 B（uuid 主键化 + 读取时联查）**：未做，仍以 `(topic,title)` 主键 + `topic_key` 真引用 + 保 uuid 改名折中。本轮的 sync/rename 已让 uuid 全员有值，是方案 B 的前置。
- **同步范围原设计错误已修并上线（0.5.2，2026-09-21 15:24）**：见上方「第二轮修正」——原「默认全量」越界，0.5.1 上线后用户首跑即产生 162 行未分配主题的存量行（无进度）。0.5.2 改为「只同步已分配主题」并拒绝未分配主题；**已部署 201，部署后只读复核数据未变**（147/15 行仍在，用户决定暂不删）。

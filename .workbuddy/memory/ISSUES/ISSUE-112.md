# ISSUE-112：计入积分的考核得分率为 0（珊珊 2026-09-17 考核 9/10 应得 90%，积分流水里得分率记 0）——✅ 已解决（2026-09-19）
- **类型**：bug / 数据排查（积分结算链路：`worker/plan-domain.ts` 考核组得分率）
- **描述**：本地环境珊珊 2026-09-17 的考核，实得 9 分 / 总分 10 分（考核记录页可见），得分率应为 90%；但积分变动记录里这条考核流水的**得分率是 0**。需要排查到根因并修复（含存量数据是否需治愈）。
- **计算链路（已查证代码）**：
  1. **得分率唯一来源**：`computeExamRate()`（`worker/plan-domain.ts:426-444`）——查孩子库 `exam_plans`（`creator=? AND active=1 AND count_in_rate=1 AND (status='done' AND substr(done_at,1,10)=日期 OR status='missed' AND substr(due_at,1,10)=日期)`），再对每计划 `SELECT SUM(point_got), SUM(point_max) FROM exam_plan_courses WHERE plan_id=?`，**rate = max>0 ? got/max : 0**。
  2. **逐题明细回写**：考核 attempt 挂接（`plan-domain.ts:340-384`）把主库 `exam_attempts.per_question` 逐题写进 `exam_plan_courses`，字段取 `q.pointGot` / `q.pointMax`，**取不到写 NULL**。
  3. **流水**：`settleRewards` 日终结算昨日（`:452-465`），`settleGroup` 仅在 `stat.total>0` 时结算，流水 `rate` 列 = `stat.rate`，reason 文案 `考核得分率 (rate*100).toFixed(0)%`（`:551`）。
  - **关键推理**：流水行存在且 rate=0 ⇒ 当天 `exam_plans` 命中 ≥1 行但 **`SUM(point_max)=0` 或 `SUM(point_got)=0`**（`rate=max>0?got/max:0` 的两个 0 分支）。9/10 的分数在 `exam_attempts.score=9`，但**得分率根本不看 attempts.score，只看 exam_plan_courses 的逐题求和**——两层口径脱节是结构隐患。
- **候选根因（按可能性排序，需查本地数据甄别）**：
  - **H1 逐题明细缺失/字段为空**：该 attempt 的 `per_question` 为 `[]`（提交端旧构建/该题型路径未带逐题数据）或逐题里无 `pointGot/pointMax` 键 → 挂接写 NULL → SUM 全 0 → rate=0。提交路由原样存储客户端数组（`routes/exam.ts:1341` `JSON.stringify(body.perQuestion ?? [])`），客户端 ExamView 正常会带 camelCase `pointGot/pointMax`（`ExamView.tsx:467-471`）——需核对该 attempt 实际存了什么。
  - **H2 归属日字符串不匹配**：`substr(done_at,1,10)=日期` 依赖 `done_at`（=attempt `submitted_at`）的格式/时区恰为 `YYYY-MM-DD` 前缀（`routes/exam.ts:1338` 客户端来什么存什么）；若格式异常或跨时区偏移，done 计划落到别的日期，当天组只剩/混入 **missed 行**（missed 行无逐题，got=max=0）→ max=0 → rate=0，且 creator='parent' 组在 rate=0 时可能命中负档 → 写出 rate=0 的扣分流水（`childNoDeduct` 只保护 child 组）。
  - **H3 计划重复/错挂**：客户端未传 `scheduleId` 时挂接会造 `exam_<attemptId>` 影子计划（`plan-domain.ts:342`），原 worker 固定考核计划另行 missed → 同日多计划混合，口径被空计划稀释。
- **排查入口（本地 珊珊 kb.sqlite + 主库，按序执行即可甄别）**：
  ```sql
  -- ① 当天命中的计划（computeExamRate 的原始命中集）
  SELECT id,title,creator,status,count_in_rate,done_at,due_at,attempt_id,score FROM exam_plans
   WHERE active=1 AND count_in_rate=1
     AND ((status='done' AND substr(done_at,1,10)='2026-09-17') OR (status='missed' AND substr(due_at,1,10)='2026-09-17'));
  -- ② 这些计划的逐题求和（rate 的分子分母）
  SELECT plan_id,COUNT(*) n,SUM(point_got) g,SUM(point_max) m FROM exam_plan_courses
   WHERE plan_id IN (①的id) GROUP BY plan_id;
  -- ③ 该 attempt 的原始明细（per_question 是否为空/有没有 pointGot 键）
  SELECT id,schedule_id,score,submitted_at,length(per_question) len,substr(per_question,1,300) pq
   FROM exam_attempts(主库) WHERE child_id='珊珊id' AND submitted_at LIKE '2026-09-17%';
  -- ④ 流水与统计对照
  SELECT * FROM points_ledger WHERE biz_date='2026-09-17' AND reason LIKE '%考核%';
  SELECT * FROM reward_daily_stats WHERE date='2026-09-17' AND source='exam';
  ```
- **修复方向（待根因确认后细化）**：
  ① **口径兜底**：`computeExamRate` 的分子分母脱钩时兜底——`exam_plan_courses` 无明细/全 NULL 时回退用 `exam_plans.score`（挂接时已回写 attempts.score）对计划满分（scope 题数×point_max），而不是直接 0；
  ② 挂接时校验：per_question 解析为空或逐题缺 point 字段时打警告日志（当前静默吞掉，`:364-369`）；
  ③ 视根因决定存量治愈：①②修复后，珊珊这条流水/`reward_daily_stats` 是否重算（结算一次性语义，ISSUE-099 有先例：兜底回捞治愈存量）。
- **优先级**：高（积分是孩子的核心激励，算错直接打击信任；且暴露「流水 rate 与真实成绩脱节」的结构问题）
- **记录时间**：2026-09-17

---

## ✅ 解决记录（2026-09-19）

- **根因（实锤，非 H2/H3）**：2026-09-14 考核 v2 重构后，**提交路由先行置 done**——`routes/exam.ts` 提交时直接 `UPDATE exam_plans SET status='done', attempt_id=?, score=?, done_at=?`（原注释还写着「逐题明细由 worker 幂等回填」）；而 worker `applyExamAttempts`（`plan-domain.ts`）的幂等判据是 `hasPlan.attempt_id === a.id` 就 `continue`——**把「路由已回填 attempt_id」误判为「worker 已挂接」，逐题明细（exam_plan_courses）从未写入**。数据实证：珊珊 09-14 起所有考核计划 courses=0（09-03~09-09 的 sch_ 计划全有明细），computeExamRate 分母 0 → rate 恒 0。attempt 原始 per_question 完整（pointGot=9/pointMax=10 都在），排除「客户端数据缺失」。
- **修复（`server/src/worker/plan-domain.ts`）**：
  1. **幂等判据修正**：跳过条件 = attempt_id 匹配 **且** `exam_plan_courses` 已有行；否则继续走「置 done + 先清后插明细」路径（对已回填的天然幂等）。
  2. **口径兜底**：`computeExamRate` 增加 mainDb 参数——某计划 courses 分母为 0 时，回退读主库 `exam_attempts.per_question` 逐题求和（ΣpointGot/ΣpointMax），得分率不再与真实成绩脱节。
  3. **空明细告警**：per_question 为空/解析失败不再静默，打 logWarn 留痕。
- **存量治愈**（`server/scripts/heal-issue112-exam-rate.mts`，幂等可复跑，本地 `server/data` 已执行）：
  - 回填 7/8 个受影响计划的逐题明细（1 个 attempt per_question 本身为空，无可回填）；
  - 按修复后口径重算已结算行并原地修正：**09-17 流水 -15 → +10（90% 良好）**；09-14（真实 1%，仍不合格 -15）、09-15（真实 60%，仍不合格 -15）金额不变、rate 元数据修正；09-14 child 组 rate 0→47.5%（childNoDeduct 保护，0 分不变）；余额链与 points_balance 重算（-95 = Σ流水，对账一致）。
  - 09-11 旧流水 rate=0 未动：该场计划事后被软删（active=0），按当前数据重算本就是 0，且 19%/0% 同落「不合格 -15」档，金额本来就对，不属本次回归窗口。
- **验证**：新增 `test/issue112-exam-rate.test.ts`（3 用例：①路由先行置 done 后 runPlanStat 全链路回填+按 90% 发分；②结算幂等；③明细缺失时 settleRewards 直调走兜底），连同 plan-scope/exam/kb-domain-split 共 24 测试全过；server tsc 零错误。
- **备注**：生产/其他孩子库如同样受灾（09-14 后提交过考核），升级新版后跑一次 heal 脚本即可（按 children 全量扫，幂等）。

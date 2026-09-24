# 项目记忆索引（pi 学习伴侣 / learning-app「学习伙伴」）

> **本文件只做文档索引，不记录项目细节。** 所有架构、实现、坑、流程细节都在下列文档中；写新内容时进对应文档，重复的不要写回这里。
> **维护规则（2026-09-13 变更）**：**技术实现真源 = `技术实现文档-功能实现与数据流转-2026-09-13.md`**（功能 + 实现 + 数据流转 + 数据结构 + 工具读写字段，唯一真源）。功能/架构每次调整后**只更新它**；`ARCHITECTURE.md` / `EXAM-ARCHITECTURE.md` 已**停止维护**，仅作历史参考，不要再改。

## 核心文档

| 文档 | 位置 | 内容 |
|---|---|---|
| **技术实现文档-功能实现与数据流转-2026-09-13.md** | 仓库根 | **技术实现唯一真源**：§0 架构与数据真源总览 → 各功能模块（agent 操作 / 数据流转 / 数据结构 / 工具读写字段）+ 附录 A 字段级映射 + §17 缺口清单（**每次调整后更新**） |
| ~~ARCHITECTURE.md~~ | 仓库根 | **已停止维护**（历史参考）：内容多处已被 9/12~9/13 的 agent 上移 / 评测上移 / 会话索引改动取代，勿据其判断现状 |
| ~~EXAM-ARCHITECTURE.md~~ | 仓库根 | **已停止维护**（历史参考）；考核现状以技术实现文档 §6/§7 为准 |
| **MATERIAL-BRIDGE-PROTOCOL.md** | 仓库根 | 资料页 ↔ 宿主/AI 统一通讯标准（PiBridge：API/信封/动作目录/tts 能力/编程 agent 约定/宿主实现要点） |
| **PACKAGING.md** | 仓库根 | 打包 + 部署（201 / ECS / OSS）+ 发布流程 + 运维坑 + 开发期构建验证速查 |
| **ISSUES.md** | `.workbuddy/memory/` | 问题清单（2026-08-30 SPLIT 架构起重新编号） |
| ISSUES-archive-2026-08-30.md | `.workbuddy/memory/` | 旧一体化架构时期的 ISSUE-001~052 归档 |
| **DESIGN-server-agent-migration-2026-09-12.md** | 仓库根 | agent 上移定案（**必须切服务端、客户端零 agent、不做过渡/门控**）+ 目标架构 + 契约 + 阶段验收 |
| **DESIGN-generic-entity-api-2026-09-18.md** | 仓库根 | **⭐ 通用实体数据 API 设计稿（namespace 注册表 + 统一数据三工具）**：C1~C5 契约 + 安全红线 + 注册表 `refs`/`paths` 设计 + 三库布局 + `parent-data` 独立 agent + **现状审计（仅 C1 达标）** + 漂移实测 + F13/F14/F2/F1/F7/F10/F10-b 实施顺序。**该机制后续所有改动以此稿为准**（落地后需回写技术实现文档 §8） |

> **索引校正（2026-09-18 实测）**：下列旧索引条目在当前工作树中**已不存在**——`ARCHITECTURE.md`、`EXAM-ARCHITECTURE.md`、`SPLIT-REQUIREMENTS.md`、`DESIGN-SPLIT.md`、`SPLIT-DATA-STRUCTURE.md`、`REQUIREMENTS.md`、`EXAM-REQUIREMENTS.md`、`ENGLISH-AGENT-REQUIREMENTS.md`、`PARENT-AGENT-REQUIREMENTS.md`、`RESEARCH-*`、`DESIGN-english-scene-courses-*`、`DESIGN-reward-points-*`、`DESIGN-plan-domain-rewrite-*`、`DESIGN-server-agent-migration-*`、`需求盘点-三大需求场景分析-*`、`调研笔记-叶圣陶语文方法论.md`。当前仓库根实际存在的文档只有：`技术实现文档-功能实现与数据流转-2026-09-13.md`、`MATERIAL-BRIDGE-PROTOCOL.md`、`PACKAGING.md`、`WEB-前端设计方案与实施规划-2026-09-15.md`、`DEPLOY-201-server-0.4.1-迁移方案-2026-09-15.md`、`学习伙伴-用户使用说明书.md`、`DESIGN-generic-entity-api-2026-09-18.md`。**下述「需求/设计/调研文档」列表仅作历史线索保留，勿据其判断文件存在性。**

> **规划归档约定（2026-09-23 用户要求，同日扩大适用范围）**：**功能规划与「治本方案/设计稿」一律不再单独出文件，全部写成 ISSUE** —— 详情进 `.workbuddy/memory/ISSUES/ISSUE-xxx.md`，索引行进 `ISSUES.md`。已适用：**学习/考核掌握闭环 = ISSUE-135**（原 `DESIGN-mastery-loop-2026-09-22.md` 全文迁入，文件已删除）；**工具参数序列化治本方案 = ISSUE-134**（原 `DESIGN-tool-arg-coercion-2026-09-23.md` 全文迁入，文件已删除）。

> **讨论就地记录约定（2026-09-23 用户要求）**：**按域/模块逐块讨论的场景梳理类文档，讨论过程与结论必须就地写在该域（该模块）小节的正下方**，不另立末尾章节、不集中堆放；文档末尾只保留**跨域**的「待确认口径」。已适用：`docs/孩子使用场景梳理-2026-09-23.md`（**域 A 讨论 = §2 的「### 域 A」表格下方 `#### 域 A 讨论`**；原另立的 `## 6 域 A 专项讨论` 已撤销，`## 7 待确认口径` 顺延回 `## 6`）。后续域 B/C/… 讨论照此办理。

## 需求 / 设计 / 调研文档（仓库根）

> ⚠ 2026-09-18 起：本节多数条目在当前工作树中**已不存在**（见上方「索引校正」）。新增文档请以实际存在为准。

- **`DESIGN-generic-entity-api-2026-09-18.md`** —— **⭐ 通用实体数据 API 设计稿（当前生效）**：见上表
- `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md` / `SPLIT-DATA-STRUCTURE.md` —— 客户端+服务端拆分架构的需求、设计与数据结构
- `REQUIREMENTS.md` / `EXAM-REQUIREMENTS.md` / `ENGLISH-AGENT-REQUIREMENTS.md` / `PARENT-AGENT-REQUIREMENTS.md` —— 各模块需求
- `RESEARCH-aliyun-ssecp-child-assessment-2026-09-07.md`、`DESIGN-ssecp-speech-assessment-2026-09-07.md`、`RESEARCH-pronunciation-assessment-2026-08-31.md` —— 语音/发音评测调研与设计
- `DESIGN-english-scene-courses-2026-09-10.md` —— 英语「学习+场景合一」课程方案（33 集 wowenglish → 9 场景课，一课两阶段单页）
- `DESIGN-reward-points-2026-09-10.md` —— 积分奖励机制设计（分档规则/数据模型/兑换双路，待评审）
- `DESIGN-plan-domain-rewrite-2026-09-10.md` —— **计划域重构设计（三张计划表 + 排期表 + daily 两列 + worker 改造 + mastery 清理，待评审；实施前必读）**
- `DESIGN-server-agent-migration-2026-09-12.md` —— **⭐ agent 全量上移服务端迁移设计（2026-09-12 已定案：不要过渡 / agent 只在 server / client 零 agent；目标架构 + 职责边界红线 + 接口契约 + 共享包 packages/agent-core + P0~P4 阶段与验收；实施前必读，落地后改写 ARCHITECTURE.md）**
- `需求盘点-三大需求场景分析-2026-09-10.md` —— 三大需求场景盘点 + 数据交互现状 + 表结构评估/优化清单 + 计划域提案评估与定案（§5~§13 为决策记录真源）
- `调研笔记-叶圣陶语文方法论.md` —— 语文教学思路调研

## 日志

- `.workbuddy/memory/YYYY-MM-DD.md` —— 每日工作日志（append-only，>30 天的提炼进本索引后删除）

## 环境备忘（PACKAGING.md 刻意不留明文的部分）

- 201（192.168.1.201）SSH 凭据：`shanshan` / `123456`（sudo 同）；部署脚本模板在 `tmp/deploy/*.py`
- 201 服务端运行方式：`/usr/bin/node /opt/learning-server/server.cjs`（systemd `learning-server`，以 root 跑，pkg 已弃用）；数据目录 `/opt/learning-server/data`；健康端点 `/api/v1/health`。部署＝stop → 备份（bundle→`server.cjs.bak-<ts>`，数据→`data/backups/deploy-<ver>-<ts>/`）→ 换 bundle → daemon-reload + restart，停机约 6 秒。**当前已部署 0.5.9（2026-09-24 11:16）：0.5.8 = ISSUE-135 P0-a/P4 掌握闭环（0.5.6+0.5.7 修复线上 500）+ 0.5.8 掌握分析任务改显式添加；0.5.9 = ISSUE-143 发音评测音频双根解析修复**（`readAudioBytes` P2 归并后只查旧根 → 0.5.5 起评测全 404「音频文件不存在」；改用 `resolveStoredFileAbs` + 失败留痕 warn；随包 ISSUE-142 孩子侧专用报告工具 + ISSUE-144 家长场景 skill P0~P4+P7）。部署验证口径：`/api/v1/version` 版本号 + bundle 标记 + `journalctl` ERR_COUNT=0 + 自签家长 JWT 直连 127.0.0.1:8788 跑端到端（`data/server-config.json` 有 `jwtSecret`，纯 Node `crypto` HS256，模板 `tmp/deploy/verify_059_api.js`；⚠ 考核明细/files 表 `created_at` 是 **UTC** ISO，按本地日期 LIKE 会漏行）。** 备份：bundle `server.cjs.bak-20260924-1116`（0.5.8）、数据 `data/backups/deploy-0.5.9-20260924-1116/`；更早 `server.cjs.bak-20260923-1205`（0.5.8）等。
- **0.5.8 = 掌握分析任务改为「显式添加」**：删除 worker tick + `GET /scheduler/tasks` 的自动播种（含 `mastery_task_seeded:*` 标记），改为 `MASTERY_TASK_TEMPLATE` + `GET /api/v1/scheduler/task-templates`（只读）+ `POST /api/v1/scheduler/tasks {template:"mastery_analysis"}`（固定 id 幂等）。**教训：别替家长做主创建会花 LLM 调用的定时任务**；201 上原任务行已删除，跨 tick 复查未重建。⚠️ 部署此类「去掉自动行为」的改动时，**必须先换 bundle 再删数据行**（反了会被旧版 tick 在两分钟内重建）。
- ⚠️ **孩子库懒迁移**：新表/新列只在 `openKb()` 时建。worker 启动后 3s 的 catch-up 会遍历主库 `children` 里的活跃孩子 → 自动迁移；**孤儿库/`kb/test-parent/` 不会被碰**（2026-09-23 实测 5 个库中 3 个如此），属正常，不要误判为迁移失败。部署脚本模板 `tmp/deploy/deploy_server_0XX*.py`；**远程多步脚本一律上传 `.sh` 再 `sudo bash` 执行**（`bash -c` 内嵌 `$变量` 会被外层 shell 提前展开成空 → 备份静默空操作，09-21 踩过）。
- ⚠️ **201 磁盘（2026-09-24 清理后实测）**：根分区 116G 用 105G＝**96%，仅剩 5.1G**。**09-24 已按用户指令清理一周前的部署备份**（文件名日期 < 09-17）：bundle bak 19 个（304M）+ deploy 快照 4 个（150M）。**仍在的可回收项**：09-17 后的 bundle bak 21 个（约 490M）与 11 个 deploy 快照（约 440M，含 0.5.6 的 DROP 前 exam_attempts 快照——删前需用户单独确认）、非部署快照（09-11 操作前快照×4、lunyu-sync-20260920、08-30 孩子数据备份、yunlvcao 原始 mp4 8.4M）、`learning-server.pkg030` 83M（pkg 已弃用）。清理仍需用户逐项确认。
- 201 客户端：deb 装到 `/opt/学习伙伴/xuexihub`（root 属主），**进程属主=shanshan、桌面会话 `:0`**，用户数据 `/home/shanshan/.config/learning-app`。升级＝`pkill -TERM -f '/opt/学习伙伴/xuexihub'` → `sudo dpkg -i /tmp/learning-app_<ver>_amd64.deb` → `DISPLAY=:0 XAUTHORITY=/home/shanshan/.Xauthority setsid nohup '/opt/学习伙伴/xuexihub' >/tmp/xuexihub-<ver>.log 2>&1 < /dev/null &`（**GUI 可远程重启**）。旧 deb 存 `/tmp` 用于回滚。**当前已部署 0.1.15（2026-09-15）。**
- OSS AK/SK：仓库根 `aliyun-aksk.txt`

## 操作约定（用户明确要求）

- **2026-09-14：未经用户明确同意，不得部署到 201**（哪怕改动已构建完成、哪怕属 issue 修复的验证环节）。Windows 本地构建/验证可以自主做，201 的部署与生产验证动作必须先询问。
- **2026-09-23：本仓库禁用 `git stash`**（实测事故：`.git/refs/` 消失 + 对象库被清空 + `pack-*.pack` 缺失 → 仓库不可用）。
  需要临时撤回改动做基线对照时，改用**复制文件到 `tmp/`**；工作树本身未受影响。修复路径见同用户 `~/.workbuddy/MEMORY.md`。
- **2026-09-23 git 已修复（方案 A）**：以远端 `2d98290`（09-21 19:47）为基线重建 → `6b038d9`（工作区重建：16 个丢失提交的
  内容，消息里留档其短哈希）+ `53f954b`（ISSUE-135 P0-a），已 push 到 **github 与 gitee 两端（master = 53f954b）**。
  永久失效的 hash：`08f45a5`/`2b12265`/`16f7550`/`2573c12` 等（内容现归 `6b038d9`）。仓库已设 **`gc.auto=0`**（防再剪枝）。
  备份留档：`tmp/git-backup-20260923/`（含原始 reflog 243 条）、`tmp/iss135-backup/`。`master` 未设 upstream，
  推送用 `git push github master && git push origin master`。

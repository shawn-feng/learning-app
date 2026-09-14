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

## 需求 / 设计 / 调研文档（仓库根）

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
- OSS AK/SK：仓库根 `aliyun-aksk.txt`

## 操作约定（用户明确要求）

- **2026-09-14：未经用户明确同意，不得部署到 201**（哪怕改动已构建完成、哪怕属 issue 修复的验证环节）。Windows 本地构建/验证可以自主做，201 的部署与生产验证动作必须先询问。

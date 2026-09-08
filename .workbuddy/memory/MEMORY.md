# 项目记忆索引（pi 学习伴侣 / learning-app「学习伙伴」）

> **本文件只做文档索引，不记录项目细节。** 所有架构、实现、坑、流程细节都在下列文档中；写新内容时进对应文档，重复的不要写回这里。
> **维护规则**：功能/架构每次调整后必须同步更新 `ARCHITECTURE.md`（app 技术架构 + 功能 + 实现细节真源，保持最新、删废弃信息）。

## 核心文档

| 文档 | 位置 | 内容 |
|---|---|---|
| **ARCHITECTURE.md** | 仓库根 | app 技术架构、功能清单、实现细节、数据真源、实现红线（**每次调整后更新**） |
| **PACKAGING.md** | 仓库根 | 打包 + 部署（201 / ECS / OSS）+ 发布流程 + 运维坑 + 开发期构建验证速查 |
| **ISSUES.md** | `.workbuddy/memory/` | 问题清单（2026-08-30 SPLIT 架构起重新编号） |
| ISSUES-archive-2026-08-30.md | `.workbuddy/memory/` | 旧一体化架构时期的 ISSUE-001~052 归档 |

## 需求 / 设计 / 调研文档（仓库根）

- `SPLIT-REQUIREMENTS.md` / `DESIGN-SPLIT.md` / `SPLIT-DATA-STRUCTURE.md` —— 客户端+服务端拆分架构的需求、设计与数据结构
- `REQUIREMENTS.md` / `EXAM-REQUIREMENTS.md` / `ENGLISH-AGENT-REQUIREMENTS.md` / `PARENT-AGENT-REQUIREMENTS.md` —— 各模块需求
- `RESEARCH-aliyun-ssecp-child-assessment-2026-09-07.md`、`DESIGN-ssecp-speech-assessment-2026-09-07.md`、`RESEARCH-pronunciation-assessment-2026-08-31.md` —— 语音/发音评测调研与设计
- `调研笔记-叶圣陶语文方法论.md` —— 语文教学思路调研

## 日志

- `.workbuddy/memory/YYYY-MM-DD.md` —— 每日工作日志（append-only，>30 天的提炼进本索引后删除）

## 环境备忘（PACKAGING.md 刻意不留明文的部分）

- 201（192.168.1.201）SSH 凭据：`shanshan` / `123456`（sudo 同）；部署脚本模板在 `tmp/deploy/*.py`
- OSS AK/SK：仓库根 `aliyun-aksk.txt`

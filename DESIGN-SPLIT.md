# 客户端 + 服务端拆分设计方案（DESIGN-SPLIT）

> 状态：**设计草案 v0.3**（2026-08-27；评审点 1/2/3/4/5 已拍板，6/7 保留建议）
> 依据：`SPLIT-REQUIREMENTS.md` v0.3（需求已收敛）
> 范围：学习伙伴拆分为「客户端 App + 服务端 App」双组件架构；本期不含实施
> 关联：独立于 cloud-service / pi-web；认证对接公网（暂接 www，后续迁 benefit-auth）

---

## 1. 设计目标与约束（来自需求）

| 约束 | 需求条款 |
|------|---------|
| 核心目标 = 多设备共享数据 | D1 |
| 双独立安装包，版本各自升级 | D4 / D14 |
| 服务端无 UI 常驻，云上 ECS 或家庭局域网 | S5 |
| 写操作必须在线；已缓存资料断网可离线浏览 | D2 / D3 |
| 会话 jsonl 留在客户端本地，不上服务端 | D9 |
| 认证复用公网中台（客户端→服务端→公网） | D5 / S4 |
| 孩子跟随家长授权，不单独公网认证 | D12 |
| Materials 版本 = 最新时间戳比对，无版本切换 | D11 |
| 大文件存服务端磁盘 | D10 |
| 不做存量迁移 | D13 |

---

## 2. 总体架构

```
┌─ 客户端 App（Electron，改造现有学习伙伴）──────────────┐
│ 家长界面 / 孩子界面（不变）                            │
│ AI Agent 本地调用（pi-session.ts 保留，jsonl 本地读写）│
│ 本地缓存：配置缓存 · materials 缓存 · 服务端连接配置    │
│ 数据访问层（本地 SQLite → 远程 API 调用）              │
└──────────────┬────────────────────────────────────────┘
               │ HTTPS（云上）/ HTTP（局域网）
               ▼
┌─ 服务端 App（Node + TS，无 UI 常驻）──────────────────┐
│ 认证代理 → 公网（benefit-auth / www）                │
│ 数据库（SQLite：parents/children/kb/agents/parent_lib）│
│ Materials（内容 + 最新时间戳）· 大文件（磁盘）          │
│ 配置中心（模型参数 / scheduler 等，revision 比对）     │
└───────────────────────────────────────────────────────┘
```

**组件职责**

| 组件 | 职责 | 不做什么 |
|------|------|---------|
| 客户端 | UI、AI agent 本地调用、会话 jsonl 本地读写、缓存管理、离线浏览 | 不持有业务数据库、不做公网认证 |
| 服务端 | 数据唯一真源、认证代理、materials 版本、大文件、配置下发 | 不跑 AI agent、不存储会话 jsonl、无界面 |
| 公网（benefit-auth/www） | 家长账号认证、授权与套餐 | 不接触孩子数据 |

---

## 3. 通信协议设计

### 3.1 传输层
- 云上：HTTPS + JSON；家庭局域网：HTTP（可配置，默认 HTTP + 可选 Token 鉴权）。
- API 版本前缀：`/api/v1/`，服务端与客户端各自独立升级、通过版本协商对齐（见 §10）。

### 3.2 会话凭证
- 客户端登录成功后，服务端签发自己的 **session token**（JWT，含 parent_id、有效期）。
- 后续所有请求携带 `Authorization: Bearer <token>`；服务端校验 token + 归属（child_id 必须属于该家长）。

### 3.3 端点一览

| 分组 | 端点 | 说明 |
|------|------|------|
| 认证 | `POST /auth/login` | 家长凭证 → 服务端转发公网认证 → 返回 session token + 套餐信息 |
| 认证 | `POST /auth/register` | 家长注册（转发公网） |
| 认证 | `GET /auth/license` | 查询当前授权/套餐（服务端缓存公网返回，按需刷新） |
| 配置 | `GET /config/revision` | 返回配置 revision（时间戳/序号），2 分钟轮询入口 |
| 配置 | `GET /config` | 返回完整配置（模型参数、scheduler 等），revision 变化时拉取 |
| 孩子 | `POST /children` `GET /children` `PATCH /children/:id` | 家长创建/管理孩子（数据在服务端） |
| 数据 | `POST /db/query` `POST /db/exec` | 数据库读写（RPC 风格，见 3.4） |
| 资料 | `GET /materials/index` | 带客户端本地索引比对，返回需更新的清单 |
| 资料 | `GET /materials/content/:id` | 拉取单个 material 内容（含大文件流式） |
| 文件 | `POST /files` `GET /files/:id` | 大文件（录音/图片/视频）上传下载 |
| 版本 | `GET /version` | 服务端版本 + min_client_version（客户端启动比对） |

### 3.4 数据库读写协议（RPC 风格）
- 客户端不再持有 SQLite，改为远程操作。为避免客户端与服务端各自维护一套 SQL 兼容层，采用 **服务端暴露语义化操作**（`/db/query`、`/db/exec`），操作类型与现有 kb-sqlite / parent-library 的 API 一一对应（如 `daily_entries.queryByDate`、`topics.upsert`、`agents.getHistory`）。
- 语义化 RPC 的理由：① 客户端改造面最小——本地模块（kb-sqlite.ts、parent-library.ts、agents）内部改为调远程接口，对外签名不变；② 服务端可做 childId 归属强制校验（所有操作注入 `child_id ∈ 该家长`）；③ 避免 SQL 字符串跨网络传输的安全风险。
- 数据模型：服务端每孩子一个 schema 分区（见 §5），查询一律带 child_id。

---

## 4. 认证与授权设计

### 4.1 现状（改造基线）
- `electron/lib/auth-manager.ts`：家长登录直连 `getCloudApiBase()/api/auth/login`（www.aixuexihao.top），缓存 license（token + parent_id）。

### 4.2 目标链路（客户端 → 服务端 → 公网）

```
客户端               服务端                公网（benefit-auth / www）
  │ POST /auth/login   │                    │
  │ email+password ───►│ POST 认证接口 ─────►│ 验证账号/套餐
  │                    │◄── license ────────│
  │◄─ session token ───│ 签发 session token  │
```

- **服务端承担**：接收家长凭证 → 转发公网认证接口 → 取回 license → 签发自有 session token（后续请求不再直连公网，减少公网依赖）。
- **上游接口（已拍板）**：**暂接现有 `www.aixuexihao.top/api/auth/*`**（现状已验证可用，auth-manager.ts 同款接口）；benefit-auth 中台（auth.aixuexihao.top，需求 D5）作为后续迁移目标，其对应接口就绪后再切换。
- **套餐/授权**：服务端缓存公网返回的授权与套餐，随 session 下发给客户端；服务端可定期（如登录时 + 每 24h）向公网核验。
- **孩子**：家长在服务端创建（`children` 表），孩子端使用不带独立凭证，所有操作以「家长 token + childId」执行；服务端强制 child_id 归属校验（防越权）。

---

## 5. 服务端数据模型（SQLite schema 草案）

技术：`node:sqlite`（Node 22 内置，与现有一致，无新依赖）。

| 库 | 表 | 说明 |
|----|----|------|
| 主库 | `parents` | 家长账号（id、公网 uid、email、套餐、授权缓存） |
| 主库 | `children` | 孩子（id、parent_id、name、创建时间） |
| 主库 | `settings` | 家长配置（模型参数、默认模型、provider 清单等，revision 列） |
| 主库 | `scheduler` | 定时任务配置（现 scheduler-config.json 平移） |
| 主库 | `materials` | 资料清单（id、path、type、size、updated_at） |
| 主库 | `files` | 大文件元数据（id、path、size、mime、owner_id） |
| 主库 | `agents` | AGENTS 版本（prompts / prompt_history，平移现有 agents.sqlite） |
| 孩子库（per-child 分区，或统一 child_kb 表带 child_id 列） | `daily_entries` / `courses` / `topics` / `tags` | 平移现有 kb.sqlite 表结构（kb-sqlite.ts:83-127），数据归属列强制校验 |

> 注：表结构与现有 kb.sqlite / agents.sqlite / parent-library.sqlite 一一对应，实施时可将现有 schema 平移 + 加归属列，无需重新设计业务字段。
> **会话 jsonl 不在服务端**（D9 硬边界）——服务端不设计任何会话历史表。

---

## 6. Materials 同步机制

### 6.1 服务端
- materials 内容存服务端磁盘目录；`materials` 表记录 `updated_at`（文件更新时间，发布即更新时间戳）。
- 无版本列表、无回滚（D11）。

### 6.2 客户端
- 本地缓存目录 + 本地索引（逐项 id → updated_at）。

### 6.3 同步流程
```
客户端 GET /materials/index?client_index={id:ts,...}
  → 服务端 diff，返回需新增/更新的 material 清单
  → 客户端逐个 GET /materials/content/:id 拉取，更新本地索引
  → 已缓存且未变更的不重复下载（省流量）
```
- 配置轮询（2min）与 materials 索引比对可在同一轮询中合并完成。
- 断网时：读本地缓存即可浏览（D3，读不联网）；缓存命中不访问服务端。

---

## 7. 配置下发与 2 分钟轮询

### 7.1 配置内容
- 模型/provider 参数（现 Settings.tsx 的 provider 清单、`pi-runtime.ts` 模型注册的运行时参数、默认模型）。
- scheduler 定时任务配置、家长可调项。

### 7.2 机制
```
客户端每 2min → GET /config/revision
  → 与本地缓存 revision 一致 → 无操作
  → 不一致 → GET /config 全量拉取 → 更新本地缓存 → 记录新 revision
```
- revision 用单调递增序号或时间戳，服务端每次配置变更自增。
- **生效策略（待评审）**：建议**下次会话生效**——进行中的 agent 会话不中途换参数，避免行为漂移；新会话用新配置。若需热更新另行评估。

---

## 8. 客户端改造方案

### 8.1 保留不动
- 家长/孩子界面、AI agent 本地调用（pi-session.ts）、会话 jsonl 本地读写（data/children/<childId>/sessions/）、media-protocol（本地缓存资源渲染）。

### 8.2 改造点

| # | 模块（现状） | 改造 |
|---|------------|------|
| 1 | 数据访问层 | 引入统一 DataAccess 接口：本地实现（现状直接 SQLite）→ **远程实现**（调 §3.4 RPC）。kb-sqlite.ts / parent-library.ts / agents 内部替换，对外签名不变，UI 层无感 |
| 2 | 配置来源 | app-settings.json / scheduler-config.json 本地直读 → 服务端下发 + 本地缓存 + 2min 轮询（§7） |
| 3 | Materials | 本地路径直读 → 远程拉取缓存 + 本地索引（§6） |
| 4 | 认证 | auth-manager.ts 直连 www → 改连服务端 `/auth/*`（§4） |
| 5 | 新增：连接配置 | 设置页新增「服务端地址」配置（云上 HTTPS 或局域网 HTTP）；首次连接向导 |
| 6 | 网络失败 UX | 延续现有约定：显式报错、禁止静默降级；离线时写操作提示不可用，缓存资料可浏览 |

---

## 9. 服务端实现方案

- **技术栈（已拍板）**：Node.js + TypeScript（与现有 electron/lib 同栈，kb-sqlite 逻辑可直接平移复用）；HTTP 框架 **Fastify**（轻量、schema 校验、流式下载支持好）。
- **模块划分**：

| 模块 | 职责 |
|------|------|
| `auth` | 转发公网认证、签发/校验 session token、套餐缓存 |
| `db` | 数据访问（平移 kb-sqlite / parent-library / agents 逻辑），child_id 归属强制 |
| `materials` | 资料清单、时间戳、内容流式下载 |
| `files` | 大文件上传（multipart/流式）、下载、磁盘管理 |
| `config` | 配置 revision 管理与下发 |
| `version` | 版本协商（§10） |

- **运行**：无 UI 常驻进程。**Windows：NSIS 安装器装进 Program Files，`pkg` 单文件 exe，注册为 Windows 服务（NSSM 包装）——开机即启、免登录、崩溃自动重启**（已拍板）；**Linux：systemd 托管**（免 Docker，延续既有运维偏好）。同一套代码两平台运行（pkg 出 Windows exe、Linux 直接跑 node / 目录包）。
- **服务端更新**：本期手动覆盖升级（重装新包覆盖，Windows 服务重启即可）；自动更新列为后续增强。
- **存储**：数据目录（数据库 + materials + 大文件）统一在服务端数据目录下。

---

## 10. 版本兼容约定

- API 前缀 `/api/v1/`：破坏性变更升 v2，v1 保留过渡期。
- 服务端启动时声明 `{ version, min_client_version }`；客户端启动调用 `GET /version` 比对：
  - 客户端 < min_client_version → 弹提示「客户端版本过低，请升级」并允许继续浏览缓存资料；
  - 服务端 < 客户端要求 → 提示「服务端版本过低，请升级服务端」。
- 版本独立升级（D4），不要求两端同版本，只要求兼容区间。

---

## 11. 部署方案

| 场景 | 方案 |
|------|------|
| 云上 ECS（Linux） | 服务端包 → systemd 常驻 → HTTPS（Let's Encrypt，复用既有经验）→ 公网域名/端口 |
| 家庭局域网 Windows | **NSIS 安装包直接安装 → 注册为 Windows 服务（NSSM）→ 开机自动启动**（无需登录、崩溃自动重启）；客户端设置页填局域网地址（如 `http://192.168.x.x:8788`） |
| 家庭局域网 Linux | 服务端包 → systemd 常驻；客户端填局域网地址 |
| 自用模式 | 同一台机器同时装客户端 + 服务端两个包（D8），客户端连本机地址 |

---

## 12. 安全与数据边界

- 传输：云上强制 HTTPS；局域网 HTTP 可选（家庭信任域）。
- 鉴权：所有服务端请求需 session token；**child_id 归属强制校验**（服务端唯一入口，防越权访问他人孩子数据）。
- 大文件：上传鉴权 + 类型白名单；磁盘路径与材料目录分离管理。
- 硬边界：**会话 jsonl 永不上服务端**；学习记录永远在服务端（家长端可见性唯一通道）。
- 公网依赖：仅认证/授权环节依赖公网（登录 + 定期核验），日常读写不依赖公网（只依赖服务端）。

---

## 13. 实施里程碑

| 阶段 | 内容 | 验证 |
|------|------|------|
| M1 服务端骨架 | 服务端包初始化、`/version`、健康检查、认证代理（登录/注册/license） | 客户端登录成功拿到 session token |
| M2 数据层远程化 | db RPC（kb/agents/parent_lib 平移）、children 管理 | 孩子学习记录读写走服务端，UI 无感 |
| M3 配置下发 | revision + 2min 轮询 + 本地缓存 | 改配置后客户端 ≤2min 生效（新会话） |
| M4 Materials | 索引比对 + 增量拉取 + 离线浏览 | 缓存后可断网浏览资料 |
| M5 大文件 | 上传/下载 + 磁盘管理 | 录音/图片跨设备可见 |
| M6 双包构建 | 客户端包改造 + 服务端包产物 | 两包独立安装、各自升级 |
| M7 端到端 | 多端同时在线、断网 UX、版本协商 | 家长端 + 孩子端 + 双设备验证 |

---

## 14. 评审决策点

✅ = 已拍板（2026-08-27）；⏳ = 保留建议，待拍板

| # | 决策点 | 结论 | 说明 |
|---|--------|------|------|
| 1 | 数据读写协议 | ✅ 语义化 RPC（/db/query + /db/exec） | 改造面最小，UI 无感 |
| 2 | 认证上游接口 | ✅ 暂接现有 www `/api/auth/*` | benefit-auth 就绪后迁移 |
| 3 | 配置生效策略 | ✅ 下次会话生效 | 不打断进行中会话 |
| 4 | 服务端技术栈/框架 | ✅ Node + TS + Fastify | 与现有同栈 |
| 5 | 服务端包形态 | ✅ 纯 Node `pkg` 单文件 + NSIS 安装器；Windows 装为系统服务（NSSM），Linux systemd | 免安装目录包已排除 |
| 6 | 服务端默认端口 | ⏳ 8788 | 可配 |
| 7 | materials 大文件通道 | ⏳ 统一 /materials/content 流式 | 备选：大文件走 /files 独立通道 |

---

## 15. 本期明确不做

- 会话 jsonl 上服务端 / 跨设备会话接续（D7/D9）
- 存量数据迁移（D13）
- Materials 多版本切换/回滚（D11）
- 与 cloud-service / pi-web 打通（D14）
- 孩子独立公网认证（D12）

# 学习应用实施计划

> 最后更新：2026-08-11

---

## 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                 Cloud Service (Python)                   │
│  FastAPI + SQLite + 文件存储                               │
│  - 家长认证 / 许可证 / 云端同步                            │
└────────────────────────┬────────────────────────────────┘
                         │ HTTPS
┌────────────────────────┴────────────────────────────────┐
│                Electron App (Local)                      │
│  ┌──────────────────────────────────────────────────┐    │
│  │ Main Process (Node.js)                           │    │
│  │  ┌────────────┐ ┌───────────┐ ┌──────────────┐  │    │
│  │  │ Auth Mgr   │ │ Pi Engine  │ │ Scheduler    │  │    │
│  │  │ (cloud+    │ │ (shared    │ │ (recording/  │  │    │
│  │  │  local)    │ │  Runtime +  │ │  tracker +   │  │    │
│  │  │            │ │  sessions)  │ │  catch-up)   │  │    │
│  │  └────────────┘ └──────┬─────┘ └──────────────┘  │    │
│  │  ┌────────────┐ ┌──────┴─────┐ ┌──────────────┐  │    │
│  │  │ Skill Mgr  │ │ Sync Mgr   │ │ Path Guard   │  │    │
│  │  │ (import)   │ │ (cloud)    │ │ (extension)  │  │    │
│  │  └────────────┘ └────────────┘ └──────────────┘  │    │
│  └──────────────────────┬───────────────────────────┘    │
│                    IPC bridge                            │
│  ┌──────────────────────┴───────────────────────────┐    │
│  │ Renderer (React)                                 │    │
│  │  Parent: Login / Dashboard / SkillEditor / Config│    │
│  │  Child: Select / Learn (Chat + ContentPanel)     │    │
│  └──────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

## 项目结构

```
learning-app/
├── package.json
├── electron/
│   ├── main.ts                      # 主进程入口
│   ├── preload.ts                   # IPC context bridge
│   ├── lib/
│   │   ├── pi-runtime.ts            # 共享 ModelRuntime
│   │   ├── pi-session.ts            # 孩子/家长 AgentSession 管理
│   │   ├── auth-manager.ts          # 云端认证 + 许可证缓存
│   │   ├── child-auth.ts            # 本地孩子密码
│   │   ├── user-init.ts             # 新用户/孩子初始化
│   │   ├── skill-manager.ts         # 技能导入
│   │   ├── scheduler.ts             # 定时任务 + 补执行
│   │   ├── sync-manager.ts          # 云端同步
│   │   └── ipc-handlers.ts          # IPC 通道处理
│   └── extensions/
│       └── learning-guard.ts        # Pi 扩展：路径守卫
├── src/                             # React 渲染层
│   ├── App.tsx
│   ├── pages/
│   │   ├── ParentLogin.tsx
│   │   ├── Dashboard.tsx
│   │   ├── ChildSelect.tsx
│   │   ├── Learn.tsx
│   │   ├── SkillEditor.tsx
│   │   └── Settings.tsx
│   └── components/
│       ├── ChatWindow.tsx
│       ├── ContentPanel.tsx
│       ├── ModelSelector.tsx
│       └── ProgressView.tsx
├── templates/                       # 技能模板
│   └── skills/
│       ├── recording/SKILL.md
│       ├── study-tracker/SKILL.md
│       └── learning-topic-setup/SKILL.md
├── cloud-service/                   # Python 后端
│   ├── app/
│   │   ├── main.py
│   │   ├── auth.py
│   │   ├── license.py
│   │   ├── sync.py
│   │   └── database.py
│   ├── requirements.txt
│   └── Dockerfile
└── data/                             # 运行时数据（.gitignore）
    ├── license.json
    ├── shared/
    │   ├── auth.json
    │   └── skills/
    ├── children/
    └── task-state.json
```

---

## 分阶段实施

### Phase 1: 项目脚手架（2 天）

**目标**：可运行的 Electron + React 空壳 + Python 后端空壳

**任务**：
1. 创建 Electron + React 项目（electron-vite）
2. 安装依赖：`@earendil-works/pi-coding-agent`, `typebox`, `node-cron`, `react-markdown`, `dompurify`
3. Python 项目：FastAPI + SQLite 脚手架，`requirements.txt`
4. 建立目录结构（`electron/`, `src/`, `cloud-service/`, `templates/`, `data/`）
5. 验证 Pi SDK 在 Electron 主进程中可 import 和基本调用

**验证标准**：
- Electron 窗口能打开显示 React 页面
- Python 服务能启动返回 health check
- Pi SDK 在 main process 中能 `createAgentSession()` 不报错

---

### Phase 2: 云端服务（2 天）

**目标**：家长认证 + 许可证 + 同步 API 可用

**数据库表**：
```sql
parents (id, email, password_hash, created_at)
subscriptions (id, parent_id, plan, max_children, features, starts_at, expires_at, status)
devices (id, parent_id, device_name, last_active)
sync_files (id, parent_id, child_id, file_path, content_hash, updated_at)
```

**API 端点**：
```
POST   /api/auth/register          # 注册
POST   /api/auth/login             # 登录 -> JWT
GET    /api/license                # 获取许可证
POST   /api/license/verify         # 校验许可证（离线缓存用）
POST   /api/sync/upload            # 上传孩子数据
GET    /api/sync/download/:child   # 下载孩子数据
GET    /api/sync/status/:child     # 获取文件同步状态
```

**关键实现**：
- 密码用 bcrypt 哈希
- JWT token 签发与校验
- SQLite 通过 aiosqlite 异步访问
- 文件存储：本地文件系统，按 parent_id/child_id 组织

**验证标准**：curl 能完成注册 -> 登录 -> 获取许可证流程

---

### Phase 3: Electron 认证与数据层（3 天）

**目标**：家长能登录，能添加孩子，孩子数据目录初始化

**任务**：

1. **Auth Manager**（`electron/lib/auth-manager.ts`）
   - App 启动 -> 检查本地 `data/license.json` -> 有效则直接进 App，无效则跳转登录
   - 登录流程：家长输入邮箱密码 -> 调云端 API -> 返回 JWT + 许可证 -> 缓存到 `data/license.json`
   - 离线模式：检查许可证过期时间，未过期允许离线使用

2. **孩子管理**（`electron/lib/user-init.ts`）
   - 添加孩子：创建 `data/children/{childId}/` 目录
   - 初始化文件：`profile.json`, `study-topics.md`（空模板）, `study-rules.md`（空模板）
   - 复制技能模板到共享目录（如尚不存在）
   - 创建 `.pi/settings.json` 指向共享技能目录

3. **孩子认证**（`electron/lib/child-auth.ts`）
   - 选择头像 + 输入密码 -> 验证本地 hash -> 进入学习界面
   - 密码用 bcrypt 哈希存储在 `profile.json`

4. **IPC 桥**（`electron/lib/ipc-handlers.ts`）
   - 建立 main <-> renderer 通信通道
   - 认证相关：`auth:login`, `auth:logout`, `auth:check`
   - 孩子相关：`child:add`, `child:list`, `child:select`, `child:auth`

**孩子 profile.json 结构**：
```json
{
  "childId": "uuid",
  "name": "小明",
  "avatar": "🦊",
  "passwordHash": "bcrypt...",
  "age": 8,
  "grade": "二年级",
  "interests": "恐龙、画画",
  "aiName": "知识狐",
  "aiPersonality": "温和耐心，喜欢用故事引导",
  "createdAt": "2026-08-11"
}
```

**验证标准**：家长注册 -> 登录 -> 添加孩子 -> 孩子登录进入空白学习界面

---

### Phase 4: Pi 引擎集成（3 天）

**目标**：孩子能与 AI 伙伴对话，AI 有个性化身份，内容面板可用

**4.1 共享 ModelRuntime**（`electron/lib/pi-runtime.ts`）
```typescript
let runtime: ModelRuntime | null = null;
export async function getSharedRuntime() {
  if (!runtime) {
    runtime = await ModelRuntime.create({
      authPath: path.join(dataDir, 'shared', 'auth.json'),
    });
  }
  return runtime;
}
```

**4.2 孩子 AgentSession**（`electron/lib/pi-session.ts`）
```typescript
export async function getChildSession(childId: string) {
  const childDir = path.join(dataDir, 'children', childId);
  const profile = loadProfile(childId);
  const runtime = await getSharedRuntime();

  const loader = new DefaultResourceLoader({
    cwd: childDir,
    agentDir: path.join(childDir, '.pi', 'agent'),
    systemPromptOverride: () => buildChildPrompt(profile),
  });
  await loader.reload();

  const { session } = await createAgentSession({
    cwd: childDir,
    modelRuntime: runtime,
    sessionManager: SessionManager.create(childDir),
    resourceLoader: loader,
    tools: ['read', 'write', 'edit'],
    customTools: [displayContentTool],
    extensions: [learningGuardExtension],
  });
  return session;
}

function buildChildPrompt(profile: Profile) {
  return `你是${profile.aiName}，${profile.name}的学习伙伴。
${profile.name}今年${profile.age}岁，${profile.grade}，喜欢${profile.interests}。
你的性格：${profile.aiPersonality}。
${LEARNING_FRAMEWORK_INSTRUCTIONS}`;
}
```

**4.3 路径守卫扩展**（`electron/extensions/learning-guard.ts`）
```typescript
export default function (pi: ExtensionAPI) {
  pi.on('tool_call', async (event, ctx) => {
    if (['read', 'write', 'edit'].includes(event.toolName)) {
      const resolved = path.resolve(ctx.cwd, event.input.path);
      if (!resolved.startsWith(ctx.cwd + path.sep)) {
        return { block: true, reason: '路径超出工作空间' };
      }
    }
  });
}
```

**4.4 内容面板工具**
```typescript
const displayContentTool = defineTool({
  name: 'display_content',
  label: '展示内容',
  description: '在学习内容面板展示教学内容。支持 markdown 和 html 格式。',
  parameters: Type.Object({
    format: Type.Union([Type.Literal('markdown'), Type.Literal('html')]),
    content: Type.String(),
    title: Type.Optional(Type.String()),
  }),
  execute: async (_id, params) => ({
    content: [{ type: 'text', text: `已展示: ${params.title || '内容'}` }],
    details: { panelContent: params },
  }),
});
```

**4.5 家长技能编辑 Session**
```typescript
export async function getParentSession() {
  const skillsDir = path.join(dataDir, 'shared', 'skills');
  const runtime = await getSharedRuntime();
  const { session } = await createAgentSession({
    cwd: skillsDir,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(),
    tools: ['read', 'write', 'edit'],
  });
  return session;
}
```

**4.6 IPC 事件桥接**
- Main 进程订阅 Pi session 事件 -> 通过 IPC 转发给 Renderer
- 通道：`pi:streaming`（文字增量）, `pi:tool_end`（工具执行完成，含内容面板数据）, `pi:agent_end`（完成）, `pi:error`
- Renderer -> Main：`pi:prompt`（发送消息）, `pi:switch_model`（切换模型）, `pi:abort`（中止）

**4.7 孩子目录 settings.json**（指向共享技能）
```json
{
  "skills": ["../../shared/skills"],
  "defaultProjectTrust": "always"
}
```

**验证标准**：
- 孩子发消息 "你好" -> AI 以个性化身份回复
- AI 调用 display_content 工具 -> 事件能被 main 进程捕获并转发到前端
- 路径守卫生效：AI 尝试读写工作空间外的路径被拦截

---

### Phase 5: 技能模板（2 天）

**目标**：四个基础技能的 SKILL.md 可用

**5.1 recording/SKILL.md** -- 学习记录技能
- 读取 study-topics.md frontmatter 获取主题映射
- 从当前会话提取学习总结
- 更新各主题文件的课程状态（✅）和 frontmatter
- 写入 daily-logs/{date}.md
- 提取生活事件写入 life-events.md

**5.2 study-tracker/SKILL.md** -- 学习评估技能
- 读取 study-rules.md frontmatter 获取每日目标
- 读取各主题进度文件
- 评估当日必学内容完成情况
- 输出评估结果

**5.3 learning-topic-setup/SKILL.md** -- 主题注册技能
- 在 shared/skills/ 创建新主题技能目录 + SKILL.md
- 在孩子数据目录创建 {topic}.md（含课程列表，预填 ⬜）
- 更新 study-topics.md 添加主题行
- 更新 study-rules.md 添加目标

**5.4 示例主题技能**（用于测试）
- guoxue-learner/SKILL.md：论语教学，2-3 课用于端到端测试
- 教学流程：朗读 -> 讲解 -> display_content 展示课文 -> 提问考核 -> 输出学习总结

**验证标准**：
- 孩子说"我要学论语" -> AI 加载 learning-topic-setup -> 创建技能和文件
- 孩子开始学习 -> 调用 display_content 展示课文 -> 完成学习输出总结

---

### Phase 6: 定时任务（1.5 天）

**目标**：recording 和 study-tracker 定时执行 + 补执行

**任务状态文件** (`data/task-state.json`)：
```json
{
  "children": {
    "{childId}": {
      "recording": { "lastRun": "2026-08-11T10:00:00Z" },
      "study-tracker": { "lastRun": "2026-08-11T21:00:00Z" }
    }
  }
}
```

**逻辑**：
- App 启动时：检查每个孩子的 lastRun
  - 如果 recording 距上次 >1 小时且有新会话 -> 补执行
  - 如果 study-tracker 今天未执行 -> 补执行
- 运行时：
  - 每小时触发 recording
  - 每天 21:00 触发 study-tracker
- 执行方式：
  - 创建临时 in-memory AgentSession
  - `session.prompt("/skill:recording")`
  - 完成后 dispose
  - 更新 task-state.json

**验证标准**：模拟学习 -> 等待定时触发 -> 检查进度文件和日志已更新

---

### Phase 7: 前端 -- 孩子学习界面（3 天）

**目标**：完整的聊天 + 内容面板学习体验

**7.1 孩子选择界面**（`src/pages/ChildSelect.tsx`）
- 头像列表 + 密码输入
- 选择后 IPC 通知 main 创建 AgentSession

**7.2 学习界面布局**（`src/pages/Learn.tsx`）
```
┌─────────────────────────────────────┐
│  🦊 知识狐    | 小明的学习时光  [设置] │
├──────────────────┬──────────────────┤
│                  │                  │
│  内容面板          │  对话区            │
│  (Markdown/HTML)  │  (聊天消息流)      │
│                  │                  │
├──────────────────┴──────────────────┤
│  [输入框]                      [发送] │
└─────────────────────────────────────┘
```

**7.3 ChatWindow 组件**（`src/components/ChatWindow.tsx`）
- IPC 监听 `pi:streaming` 事件，增量渲染 AI 文字
- IPC 监听 `pi:tool_end` 事件，如果是 `display_content` -> 推送到 ContentPanel
- 输入框发送消息 -> IPC `pi:prompt`

**7.4 ContentPanel 组件**（`src/components/ContentPanel.tsx`）
```tsx
function ContentPanel({ content }: { content: PanelContent | null }) {
  if (!content) return <Placeholder />;
  if (content.format === 'html') {
    return <div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(content.content) }} />;
  }
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.content}</ReactMarkdown>;
}
```

**7.5 模型切换**（`src/components/ModelSelector.tsx`）
- 顶部下拉显示可用模型（从 `ModelRuntime.getAvailable()` 获取）
- 切换 -> IPC `pi:switch_model` -> `session.setModel()`

**验证标准**：孩子从选择头像到完成一课学习的完整流程

---

### Phase 8: 前端 -- 家长界面（3 天）

**目标**：家长能管理孩子、配置模型、查看进度、导入技能

**8.1 家长登录**（`src/pages/ParentLogin.tsx`）
- 邮箱密码 -> 云端认证

**8.2 Dashboard**（`src/pages/Dashboard.tsx`）
- 孩子列表（头像、名字、进度概览）
- 每个孩子的进度详情（已学/总数、掌握度、最近日志）
- 读取孩子的 study-topics.md 和 {topic}.md 解析数据

**8.3 模型配置**（`src/pages/Settings.tsx`）
- 列出 Pi 支持的提供商
- 输入 API key -> `ModelRuntime.checkAuth()` 验证 -> 写入 shared/auth.json
- 选择模型 -> 设为默认

**8.4 技能导入**
- 文件选择器选本地 skill 目录/zip
- 复制到 `shared/skills/`
- 所有孩子立即可用

**8.5 技能编辑器**（`src/pages/SkillEditor.tsx`）
- 左侧文件树浏览 `shared/skills/` 目录
- 右侧 Markdown 编辑器编辑 SKILL.md 和资料文件
- 底部聊天区与家长 AI 对话（AI 帮助创建/调整技能）

**验证标准**：家长完整操作流程 -- 登录 -> 配模型 -> 导入技能 -> 添加孩子 -> 查看进度

---

### Phase 9: 云端同步（2 天）

**目标**：多设备间孩子学习数据同步

**策略**：
- **App 启动时**：如在线，拉取云端最新文件列表（`/api/sync/status/:child`），与本地比对，云端较新的下载
- **学习会话结束后**：上传变更文件到云端
- **冲突处理**：按 `updated_at` 时间戳，最后写入胜（last-write-wins per file）
- **全量备份**：每天首次同步时上传完整快照

**Sync Manager**（`electron/lib/sync-manager.ts`）：
```typescript
class SyncManager {
  async syncChild(childId: string) {
    const localFiles = scanChildFiles(childId);
    const cloudFiles = await api.getSyncStatus(childId);
    for (const file of localFiles) {
      const cloud = cloudFiles.find(f => f.path === file.path);
      if (!cloud || file.hash !== cloud.hash) {
        if (file.updatedAt > cloud?.updatedAt) {
          await api.upload(childId, file);  // 本地较新 -> 上传
        } else {
          await api.download(childId, file.path);  // 云端较新 -> 下载
        }
      }
    }
  }
}
```

**验证标准**：设备 A 学习 -> 上传 -> 设备 B 下载 -> 数据一致

---

### Phase 10: 测试与打包（2 天）

**任务**：
1. 端到端测试：注册 -> 添加孩子 -> 配模型 -> 学习 -> 定时记录 -> 查看进度
2. 离线测试：断网后学习 -> 检查许可证缓存
3. Electron 打包（electron-builder，Windows NSIS installer）
4. Python 服务 Docker 化 + 部署到阿里云 ECS

---

## MVP 范围

| 阶段 | MVP 包含 | 后续迭代 |
|------|---------|---------|
| Phase 1 脚手架 | ✅ | - |
| Phase 2 云端服务 | ✅（认证+许可证） | 同步 API |
| Phase 3 认证与数据 | ✅ | - |
| Phase 4 Pi 引擎 | ✅ | - |
| Phase 5 技能模板 | ✅（含示例主题） | 更多主题 |
| Phase 6 定时任务 | ✅（基本版） | - |
| Phase 7 孩子学习界面 | ✅ | - |
| Phase 8 家长界面 | ✅（基础） | 技能编辑器 |
| Phase 9 云端同步 | ❌ 先纯本地 | ✅ 后续 |
| Phase 10 打包 | ✅ | 阿里云部署 |

**MVP 预计工时**：约 18-20 天

---

## 风险与注意事项

1. **Pi SDK 在 Electron 主进程**：Pi 依赖 Node.js 环境，需确认在 Electron 的 Node.js 版本下正常工作。Phase 1 首先验证。

2. **技能路径解析**：SKILL.md 中引用教学资料用相对路径，需确认 Pi 是否能正确解析到技能目录而非 cwd。如不支持，在 SKILL.md 中使用绝对路径或通过系统提示注入路径。

3. **SQLite 并发**：FastAPI 异步 + SQLite 需用 `aiosqlite` 或线程池。小规模无问题。

4. **内容面板安全**：HTML 渲染必须经过 DOMPurify 消毒，防止 XSS。

5. **Pi 会话生命周期**：孩子切换/退出时需正确 dispose session，避免资源泄漏。闲置超时自动清理。

6. **Electron 热重载**：开发模式下 ModelRuntime 单例可能被重建。需用 `globalThis` 缓存。

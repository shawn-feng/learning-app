# ISSUE-141 · I4「放视频」——家长上传的视频要有一个网页播放方式

- **类型**：需求 / 方案讨论（**用户明确要求单独成 issue 讨论**）
- **描述**：视频由**家长整理上传**，孩子侧需要**一个网页里播放**的方式（不是嵌在课程页里顺带播，而是"有一段视频 → 能打开一个页面把它放出来"）。
- **影响范围**：待定（取决于路线：可能只动家长上传接口 + 生成一个 HTML，也可能动 `display_content` 的校验与资料面板的渲染分支）。
- **排查/修改入口**：`server/src/routes/materials.ts`（上传）｜`server/src/db/materials.ts`（类型识别）｜`server/src/agent/display-tool.ts`（`display_content` 校验）｜`src/components/MaterialsPanel.tsx`（`HtmlFrame` / `resolveSharedDocUrl`，孩子端展示区）｜`server/src/routes/materials-doc.ts`（`/materials/p/:token/*` 网关与 `<base>` 注入）。
- **优先级**：中（**上传链路完好，缺的是"最后一跳"**；但路线涉及跨根约束，需要先定方向再动手）
- **记录时间**：2026-09-23
- **关联**：`docs/孩子使用场景梳理-2026-09-23.md`（§4 域 I · I4 / 域 I 讨论 / §7 / §8）；`ISSUE-138`（域 I 工作区与文件：**视频清单对 agent 不可见**，与 I1"列资料"同一能力）；`ISSUE-131`（资料三源与 `outputs/` 语义）

---

## 一、结论先说

**链路已经通了一大半：家长能传、HTML 里的视频能播、Range 也支持。缺的是"把一段裸视频变成**一个可打开的网页**"这一跳，以及"**孩子/agent 怎么知道有哪些视频**"。**

而且路线**不能随便选**——有一个硬约束会直接否掉一条看起来最自然的路（见 §三）。

---

## 二、现状核实（逐段）

### 2.1 家长上传：**已可用，无类型限制**

- `POST /api/v1/materials/upload`（`routes/materials.ts:214`）：multipart，字段 `topic`（仅 `[a-zA-Z0-9_-]`）/ `subDir`（可选，如 `media/`）/ `file`。
- 落盘：`workspaces/<家长id>/materials/<topic>/[<subDir>/]<文件名>`（**只写新根**）。
- **没有扩展名白名单**（视频能传）、**没有大小上限**（几十~几百 MB 的视频会整段写盘）。
- 类型识别：`inferTypeLocal`（`db/materials.ts:35-36`）→ `mp4/webm → "video"`，`mp3/wav → "audio"`；家长端管理页已有 🎬 图标（`MaterialManagerModal.tsx:184`，含 `.mov`）。

⇒ **家长侧"整理上传"这件事今天就能做**（把视频放进某主题的 `media/` 下即可）。

### 2.2 播放：**能不能播，取决于 HTML 走哪条 URL 路径**

孩子端展示区 = **`MaterialsPanel` 的 `HtmlFrame`（iframe）**，而它**只认 HTML**：

- `display_content`（`display-tool.ts:50`）**硬校验后缀**：非 `.html/.htm` **直接报错**（"只支持 .html/.htm"）；
- `resolveSharedDocUrl`（`MaterialsPanel.tsx:192-213`）只对 `topic/xxx.html` 这种**家长库共享 HTML** 构造**真实 URL 顶层文档**；其他（含 `outputs/`）**返回空串** → 回退 **dataURL 内嵌**。

两条路径对视频的支持完全不同：

| HTML 所在位置 | 加载方式 | 里面的 `<video src="xxx.mp4">` 能播吗 |
|---|---|---|
| **家长库**（`topic/xxx.html`） | **真实 URL**：Electron `asset://local/parent/default/...?doc=1`；Web `/api/v1/materials/p/<token>/<segs>?doc=1` | **能播** ✅——服务端会注入 `<base href=".../p/<token>/<目录>/">` 并把静态 `src` 改写成绝对 URL；**非 HTML 请求由 `/materials/p/:token/*` 磁盘直读 + MIME + `Range`/206**（seek 依赖）。英语课程页的 `emma/*.mp4` 就是这么跑的（`materials-doc.ts:22-30`、`resolveSharedDocUrl:203-209` 注释原文） |
| **孩子工作区**（`outputs/xxx.html`） | **dataURL 内嵌 iframe** | **不能播** ❌——`data:` 文档**没有 base**，相对路径无从解析；且视频在**家长库**（跨根），更不可能 |

### 2.3 孩子 agent 找不到视频（与 ISSUE-138 · I1 同源）

- 家长侧有 `parent_list_materials`（列资料），**孩子侧没有**；孩子只有 `parent_content(主题 + 课程名)`（取该课的教学方法/HTML 路径）。
- ⇒ 孩子说「放一下那个视频」时，**agent 既不知道有哪些视频，也不知道路径**，只能反问"是哪个视频"。

---

## 三、⚠ 第一条硬约束（会否掉一条自然路线）

> **不要指望"让孩子 agent 现写一个 HTML 放到 `outputs/` 里播家长库的视频"。**
> `outputs/` 的 HTML 走 **dataURL 内嵌**（`resolveSharedDocUrl` 对 `outputs/` 开头显式返回空串）→ 无 base、相对路径全废、跨根更不可能。
> 换句话说：**视频播放页必须落在"家长库"里**（`topic/...` 的真实 URL 路径），不能落在孩子工作区。

（若将来真要支持"孩子自己做的页面里放视频"，那要先把 `outputs/` 的 HTML 也改成真实 URL 加载——属另一项客户端改造，**不在本 issue 范围**。）

---

## 四、四条路线

| 路线 | 做法 | 改动 | 优 / 劣 |
|---|---|---|---|
| **A · 客户端直渲（最省）** | 放宽 `display_content` 后缀校验：遇 `.mp4/.webm/.mp3` 时，客户端把该 path **直接渲染成原生 `<video controls>` / `<audio controls>`**（Web 用 `/materials/p/<token>/...`，Electron 用 `media://`/`asset://`），**完全不经 HTML** | `display-tool.ts` 校验 + `MaterialsPanel` 加一个 media 分支（**服务端仍只需登记 + 推送**） | **优**：零 HTML、零家长操作、点一下就能播<br>**劣**：失去 HTML 能力（字幕/倍速/循环要另做）；与 `display_content`"展示 HTML 资料"的语义不再一致 |
| **B · 上传时自动生成播放页（推荐）** | 家长上传视频时，服务端**顺带写一个同名 `.html`**：`<video controls src="同名.mp4">` + 标题 +（可选）字幕轨道/倍速/循环。之后**照常 `display_content("topic/xxx.html")`** | `materials/upload` 加一个生成步骤（+ 生成函数） | **优**：落在家长库 → **走真实 URL → 天生能播**（§2.2 已验证）；家长零额外操作；HTML 里想加什么都能加<br>**劣**：每个视频多一个文件（改名/删除要联动）；生成策略（覆盖/跳过/已有则不覆盖）要定 |
| **C · agent 现场生成播放页** | agent 写一份 HTML 包装 | — | **直接撞在 §三 硬约束上**（`outputs/` 播不了家长库视频）→ **不推荐** |
| **D · 家长端内联预览** | 家长在"资料管理"里直接播自己的视频 | 家长端小改 | **优**：家长自己核对内容方便<br>**劣**：不解决孩子侧（不是本需求的主体） |

**推荐：B 为主 + A 作为兜底。**

- **B** 让"家长上传即得播放页"，**不依赖 agent、不依赖家长懂 HTML**，且复用了已经验证过的"家长库 HTML + `<base>`"链路；
- **A** 作为兜底：孩子说"放那个视频"而**拿不到 wrapper**（家长传了裸视频 / wrapper 被删），或**只想临时放一下**时，仍能播。

顺序建议：**先 B（覆盖面最大、风险最小）→ 再决定 A 要不要做**。

---

## 五、待拍板

1. **路线**：B 为主（推荐）/ A 兜底 / 两者都要 / 只做 D（家长自己看）？
2. **播放页谁生成**：上传时**自动**生成，还是家长在管理页**手动点"生成播放页"**（避免给每个视频都塞一个 html）？
3. **视频清单要不要对孩子 agent 开放**（只读列举）？——**不开**的话，「放一下那个视频」永远只能靠孩子/家长在对话里报出主题或课名；**开**的话与 `ISSUE-138` 的 I1"列资料"是**同一件事**，建议**一起定**。
4. **大文件**：现无大小上限（视频可能几百 MB）。要不要给 `upload` 加 size 上限 / 分片？——Range 已支持，**流式播放没问题**，主要是**磁盘与上传体验**。
5. **播放页第一版要什么控件**：标题 / 倍速 / 循环 / 字幕 / 全屏？（建议：**标题 + 原生控件**先上，字幕与倍速看实际需要）
6. **要不要允许 agent 主动推送**（如"该看示范视频了"→ 自动放某个视频）？还是**只做"孩子要看"这一侧**？

---

## 六、验收（定完路线再细化）

- 家长上传一个 `.mp4` → 孩子侧能**在一个网页里播放**（有原生控件、能暂停/拖动进度）；
- 拖动进度条**能 seek**（Range 生效）、长视频**不卡在加载**；
- 视频**不落在孩子工作区**（`outputs/` 路线已被否决）；
- 若选 B：**同名 HTML 与视频**成对存在，删/改视频时**不留下指向空文件的页面**；
- 与 `ISSUE-138` 的结论一致：**孩子能看、能播，但不能浏览家长整棵资料树、不能读非视频类内容**。

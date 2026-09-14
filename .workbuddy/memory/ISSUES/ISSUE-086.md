# [ISSUE-086] 添加孩子表单密码标签「登录密码（仅存本地）」与实际实现不符（密码哈希会上云）

- **类型**：UI 文案 / 用户隐私预期不一致
- **优先级**：中
- **状态**：✅ 已解决（2026-09-14，标签改为「登录密码」，并顺带清理 Dashboard 遗留的「AI 提示词」文案）
- **记录时间**：2026-09-13
- **标签**：`UI文案` `孩子密码` `隐私` `children.profile_json`

---

## 一、问题要点

客户端「添加孩子」弹窗的密码输入框标签写着 **「登录密码（仅存本地）」**，但真实实现早已是**服务端存储 + 服务端校验**：

1. **创建即上云**：`addChild()` 生成 bcrypt 哈希后，`childProfilePayload()` **包含 `passwordHash`**，经 `POST /api/v1/children` 的 `profile` 字段一并上传；服务端把它合并进 `children.profile_json`。
2. **校验以服务端为准**：`authChild()` 优先调 `POST /api/v1/children/auth`，由服务端从 `profile_json.passwordHash` 做 `bcrypt.compare`；客户端本地 `data/children/<childId>/profile.json` 的同名哈希**只是离线回退**。
3. **多设备共享**：服务端 `children.profile_json` 是密码唯一真源（2026-08-30 起），这正与"仅存本地"文案相反。

因此该标签**误导用户对密码存储位置的认知**（用户会以为密码不会离开本机），属于隐私预期与实际行为不符。

> 注：`POST /children` 路径没有 `forcePassword` 守护（该守护只在 `PATCH /children/:id` 上，用于防止旧/空哈希覆盖真实密码）；首次创建时上传哈希是设计行为，不是缺陷。问题只在文案。

## 二、影响范围

- **家长端 UI**：`AddChildModal` 的密码输入标签（用户可见文案错误）。
- **文档一致性**：技术文档 §1 曾同步写着"孩子本地密码仅存客户端本地 / 密码不上云"，已按代码修正为"bcrypt 哈希存服务端 `children.profile_json.passwordHash`、服务端校验优先"。
- **隐私告知**：涉及用户对"孩子密码是否会离开本机"的判断，与 ISSUE-083（提示词不外露）同属"系统内部存了什么、对用户怎么说明"的范畴。

## 三、处理方向（仅列方案，本次不实施）

1. **方案 A（改文案，最小改动）**：把标签改为「登录密码（加密存储，多设备共享）」或「登录密码（用于孩子端登录，加密保存）」。
2. **方案 B（改文案 + 补说明）**：在表单下方加一行小字说明密码哈希保存在服务端、用于跨设备登录，并保留"离线也能登录"的兜底说明。
3. **方案 C（回退为纯本地）**：改回密码只存本地——会破坏现有的多设备共享与 `POST /children/auth` 校验链路，不建议。

> 决策点：文案措辞取 A 还是 B。行为侧无需改动。

## 四、关联

- 技术文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` §1.1 / §1.3 / §1.4（已修正为服务端存储与服务端校验）。
- 代码真源：客户端 `addChild` / `childProfilePayload` / `authChild` / `syncProfileToServer`；服务端 `POST /api/v1/children`、`POST /api/v1/children/auth`、`PATCH /api/v1/children/:id`（`forcePassword` 守护）。
- 同族议题：ISSUE-083（系统内部数据的用户可见性口径）、ISSUE-078（家长 id 未透传导致落错目录）。

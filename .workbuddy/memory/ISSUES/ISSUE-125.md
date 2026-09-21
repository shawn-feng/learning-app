# ISSUE-125：孩子聊天上传的图片/文件，服务端孩子 agent 读不到（ISSUE-124 的同源缺口）

- **类型**：bug（附能力缺口）
- **优先级**：中（家长侧已修好；孩子侧「发照片问 AI」这条链路目前整体不通，但没有家长上传作业图那么高频）
- **记录时间**：2026-09-21
- **来源**：实施 ISSUE-124（家长聊天附件）时顺带核实出的同源问题，未在 124 范围内处理。

## 现象

孩子在聊天框发一张图（或 txt/文件）：AI 伙伴既看不到图，也打不开文件——只会当普通文字消息回复。

## 根因（代码位置已核实）

| 环节 | 位置 | 事实 |
|---|---|---|
| 落盘 | `electron/lib/ipc-handlers.ts:1846`（`file:save_upload`） | 只写**孩子电脑本机** `data/children/<childId>/uploads/<ts>-<name>`，从不 POST 服务端（服务端没有 `children/<id>/uploads/`） |
| 标记 | `src/pages/Learn.tsx:1210` | `toRel` 还剥掉 `children/<childId>/`，标记成 `【附件图片：名\|uploads/xx.jpg】`（裸 uploads/，服务端更无从解析） |
| 内联图片 | `src/pages/Learn.tsx:1234` → `piPrompt(childId, text, sdkImages)` → `electron/lib/server-agent-client.ts:283` `promptChild` | base64 图片**确实发到了服务端**，但 `POST /agent/:childId/prompt`（`server/src/routes/agent.ts:134`）的 body 只取 `{text, pageEvents, session}`，`images` 被直接忽略 |
| 读工具 | `server/src/agent/*` | 全仓无任何读孩子上传区的工具（`grep uploads server/src` 只命中家长侧 `parent-tools.ts`） |

⇒ 三条路同时断：文件没上送、路径不可解析、内联图片没人消费。

## 方案（可直接复用 ISSUE-124 的成果）

1. **上送**：`file:save_upload` 落盘后顺带 `POST /files/upload`（带 `child_id`，服务端已有归属校验），IPC 返回 `{path, ref('files/<id>'), uploadError}`——与家长侧 `file:save_upload_parent` 完全对称（`electron/lib/server-client.ts` 的 `uploadFileToServer` 可直接复用）。
2. **标记**：`Learn.tsx` 的 `toRel` 改为复用 `src/lib/attachment-ref.ts` 的 `attachmentMarker`（ref 优先、path 兜底），标记形态与家长侧统一。
3. **读工具**：孩子 agent 增加读附件工具（图片 → 复用 `server/src/agent/vision.ts` 的 `describeImageViaVision`；文本 → 正文）。注意孩子侧工具表另有白名单（`CHILD_AGENT_TOOL_NAMES`），需同步登记。
4. **内联图片**：若不打算引入「孩子侧读图工具」，另一条更轻的路是**让服务端消费 `images`**（`routes/agent.ts` 读 body.images → 透传到 `submitChildPrompt` → SDK prompt 的 `images` 参数）。二者建议只取其一，避免两套并存（家长侧已定「走工具」路线，孩子侧建议对齐走工具）。
5. **安全**：引用解析必须校验文件归属（`files.child_id` 属于该 child 且该 child 属于当前家长）；`files` 表的 `child_id` 目前只在 `/files/upload` 写入时校验，读侧要同样校验。

## 验证建议

- 孩子上传图 → 服务端 `files/<id>` 落盘 → agent 工具读到 → 视觉模型描述返回；
- 越权用例：A 家孩子的 ref 传给 B 家孩子的会话必须拒绝；
- 端到端：孩子发作业照片 → AI 能说出图中内容。

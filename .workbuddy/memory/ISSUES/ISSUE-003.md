## [ISSUE-003] 家长设置·数据备份：改为服务端数据备份/恢复（zip 上传覆盖），去掉跨机进度查询

- **类型**：需求 / 架构调整
- **描述**：数据备份语义重定义：
  1. **去掉「跨机查进度」**（BackupSettings 现含该功能，旧 ISSUE-041 遗留，与 server 真源冲突）。
  2. **备份** = 把 server 端该家长的用户数据（课程 / 进度 / 生活记录等，**排除模型 API key 与登录凭证**）下载到 app 本地，打包为 zip。
  3. **恢复** = 上传这个 zip，server 用 zip 内数据**覆盖**其数据；**恢复前先对 server 当前数据做一次自动备份**（防误覆盖）。
- **现状 / 排查入口**：
  - 前端：`src/components/BackupSettings.tsx`（现为**本地** `data/` 全量 zip：一键备份 / 从备份恢复 / 定时备份 / 跨机查进度 :38）。
  - 服务端：`server/src/routes/*` 目前**无备份/恢复端点**（grep backup/restore 仅 agents.restore）——需新增：备份包生成接口、恢复上传覆盖接口、恢复前快照。
  - electron 侧备份 handler 需改为调 server 接口而非本地打包。
- **优先级**：已完成（2026-08-30 实施：`server/src/routes/backup.ts` 新增 GET /api/v1/backup（家长库+孩子 kb 打 zip）+ POST /backup/restore（multipart，恢复前自动快照 pre-restore）；`server-client.ts` 加 serverFetchBinary/serverUploadFile；`backup.ts` 改为服务端拉取/上传；`BackupSettings.tsx` 去掉跨机查进度）
- **记录时间**：2026-08-30

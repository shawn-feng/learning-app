# ISSUE-143：发音测评「音频文件不存在」——P2 归并后评测路由的私有读取点漏切双根

| 项 | 值 |
|---|---|
| 状态 | **✅ 已修复 + 回归测试（2026-09-24，本地验证全绿；未部署 201，待用户同意）** |
| 优先级 | 高（线上口语评测全挂） |
| 日期 | 2026-09-24 |
| 提出 | 用户：「发音测评功能在家长端测试时报错，提示找不到音频文件。201的生产环境，今天的背诵考核也没有正常做发音测试。」 |
| 关联 | ISSUE-131 P2（文件区物理归并，写入点切换的漏网面）、ISSUE-135 P0-a（考核明细 `audio_file_id` 三层落库，「听原音」依赖） |
| 影响 | 0.5.5（09-23 09:05）起 201 上凡「上传录音 → 评测」链路 100% 失败：家长端设置→发音评测→测试报「发音评测失败：音频文件不存在」；考核口语/背诵题全部无发音评分、无 ASR 文本（录音本体与 `audio_file_id` 仍在，「听原音」不受影响） |

---

## 一、根因（代码级）

ISSUE-131 P2 把 files 通道落盘从旧根 `data/files/<pid>/<stored>` 切到 `workspaces/<pid>[/cid]/uploads/<stored>`，当时改齐了**通用读取点**：

- `routes/files.ts` 下载/删除 → `resolveStoredFileAbs()`（新根优先、旧根兜底）✅
- `routes/fs.ts`（uploads 区双根 + `legacyUploadsRoot` 兜底）✅
- `agent/upload-ref.ts`（candidates 三根依次探测）✅

**漏网：`routes/assessment.ts` 的 `readAudioBytes()`**——它为评测私有复制了一份路径解析，只拼旧根 `data/files/<pid>/<stored>`，`fs.existsSync` 不中即抛 404「音频文件不存在」。P2 的「12 项切换清单」只盘了写入点与通用读取点，没盘到这条私有读取路径。

## 二、生产证据（201 只读诊断，2026-09-24）

1. **files 表（server.sqlite）**：当天最新 8 条记录全部「旧根=false 新根=true」，含 `assessment-test.webm`（家长端测试，08:26:55/08:27:05 两次）与 `recite-q9/q10.wav`、`voice-q1~q4`（两孩子背诵考核口语题，07:44/07:51）。
2. **磁盘**：旧根 `data/files/` 09-24 新增文件数 = 0（最后一批 09-23 07:47，恰在 0.5.5 部署前）；当天录音全在新根 `workspaces/…/uploads/`。
3. **journalctl**：07:44:40 三连发 `POST /api/v1/assessment/assess` 后几十毫秒内即提交 `POST /api/v1/exam/attempts`——评测瞬时失败（404 短路，未到 ffmpeg/评测引擎）。**服务端日志零留痕**（ApiError 被 catch 转成 502 只回客户端），这也是坏了一天才被发现的原因之一。
4. **时间线**：P2 随 0.5.5（09-23 09:05，工作树构建）上 201，此后新录音全落新根 → 评测必 404。09-23 07:47 早读考核还能正常评测（旧根时期）。

诊断脚本与结果留档：`tmp/deploy/diag_audio_0924.sh` / `diag_audio_0924_r2.sh` / `diag-audio-0924*-result.txt`。

## 三、修复（server/src/routes/assessment.ts）

1. `readAudioBytes()`：SELECT 补取 `child_id`，路径解析改为复用 `files.ts` 导出的 `resolveStoredFileAbs()`（新根优先、旧根永久兜底），删除私有拼接与手写穿越防护。
2. 评测失败留痕：路由 catch 里补一行 `req.log.warn`（此前 404/502 只回客户端，journalctl 搜不到一条）。
3. 客户端（Electron/web shim）零改动。

## 四、回归测试（test/issue143-assessment-audio-path.test.ts，6 用例）

真 fastify + 真 sqlite + 真 JWT，判定口径＝评测配置未启用时，音频取到后的下一处失败是「发音评测未启用」，用「报错 ≠ 音频文件不存在」证明 `readAudioBytes` 已通过：

1. 新根孩子区（考核口语题场景）✅ 2. 新根家长区（设置页「测试」，无 childId）✅ 3. 旧根存量（P2 前老录音，兜底可读 → 重评历史原音可行）✅ 4. 有记录无文件 → 明确「音频文件不存在」✅ 5. 未知 fileId → 同上 ✅ 6. 缺 token → 401 ✅

**防假绿**：把旧逻辑注回复跑 → 用例①②③（含旧根兜底）全红，还原后复绿。

## 五、验证

- `server` tsc `--noEmit` 0 错
- 相邻回归：`issue131-p2-merge` + `issue135-exam-routes` + `issue143` 共 **23 用例全绿**
- `node scripts/build.mjs` 构建通过（bundle 24,563,427 字节，含 `resolveStoredFileAbs`）

## 六、部署注意事项（待用户同意）

- 版本 0.5.8 → **0.5.9**（`server/package.json` + banner），部署流程照旧（stop → 备份 → 换包 → restart，模板 `tmp/deploy/deploy_server_054.py` 改字面路径）。
- ⚠️ bundle 从**整个工作树**构建：本次部署会同时带上 ISSUE-142 已实施未部署的改动（`child-report-tools` 三专用只读工具 + 撤 `child_db_read/write/describe` + `child_mistake_log(list)` 扩列）。部署前需用户知情确认。
- 部署后验证口径：家长端设置页「测试」返回评测结果；跑一场口语题考核看 `speech_assessments` 有当日行；journalctl 无 warn。
- **可选补分**：09-23 09:05 之后两场考核的录音都还在（files 表有 id、明细表有 `audio_file_id`），修复上线后可对 `audioFileId` 重跑评测补 `speech` 结果（无现成入口，需脚本一次性回填）。

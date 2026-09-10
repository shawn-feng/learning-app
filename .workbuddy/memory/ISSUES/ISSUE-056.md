## [ISSUE-056] 家长端 agent 制作学习资料注意事项：视频必须 H.264（禁用 HEVC/H.265）+ 必须走 upload 接口上服务端
- **类型**：运维规范 / 资料制作约束（bug 根因沉淀，孩子端 Linux 播放异常）
- **现象/根因（2026-09-06 线上实证，`other/韵律操` 主题）**：
  1. **视频「有声无画」= HEVC/H.265**：`media/yunlvcao.mp4` 视频轨是 **HEVC（`hvc1`/`hevc`）** + AAC 音频。Linux 上 Electron 内嵌 Chromium 的 `<video>` **不内置 HEVC 解码器**（Ubuntu 亦无硬解）→ 只能解出 AAC 出声音、视频画面黑屏。孩子端闻闻会话播放该视频即此症状。
  2. **磁盘有文件但课程详情 404**：若把文件手工丢（scp/拷贝）进 201 的 `materials/<pid>/<topic>/` 而未走 upload 接口，服务端 `server.sqlite.materials` 索引表无该行 → `/api/v1/materials/content/:id` 只查索引不扫磁盘 → 404「材料不存在」（文件实际存在）。此点 ISSUE-055 已提及，此处一并作为家长端 agent 纪律强调。
- **对家长端 agent 制作学习资料的要求（写进 `parent_upload_material` 工具 description / 制作流程规范）**：
  - **视频媒体必须为 H.264**（`h264`/`avc1`），**禁止 HEVC/H.265（`hevc`/`hvc1`）**，并 `+faststart`（moov 前置，Range 分段播放依赖）；音频 AAC。若有 HEVC 源，需先用 ffmpeg 转码（命令见下）再上传。
  - **上传一律走 `parent_upload_material` / `/api/v1/materials/upload`**，不得绕道直接写服务端磁盘目录。
- **判定/转码方法**：
  - 判定编码：`ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of default=noprint_wrappers=1 <file>`（201 有 `/usr/bin/ffprobe`）；`codec_name=hevc|hvc1` 即不合格。
  - 转码：`ffmpeg -y -i in.mp4 -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -profile:v main -movflags +faststart -c:a aac -b:a 128k out.mp4`。
- **排查/修改入口**：
  - 服务端材料读取链：`server/src/routes/materials.ts`（content 只查索引表）、`server/src/db/materials.ts`（`materialsRoot`、`scanMaterials`/`upsertMaterialFile` 维护索引）。
  - 家长工具：`electron/lib/custom-tools.ts` `parent_upload_material`、`electron/lib/parent-library.ts` `uploadMaterialToServer`/`copyMaterialIntoParent`。
  - 生产修复留存脚本：`tmp/deploy/transcode_yunlv.py` + `replace_yunlv.py`（HEVC→H.264 覆盖同路径 + 刷新索引）；`fix_yunlv_index.js`（磁盘有文件但索引缺时补索引）；诊断 `probe_mp4_codec.py`。
- **优先级**：高（若不约束，agent 自动制作含 HEVC 视频或绕道上传的资料，孩子端会持续出现黑屏/404，用户观感差）
- **记录时间**：2026-09-06

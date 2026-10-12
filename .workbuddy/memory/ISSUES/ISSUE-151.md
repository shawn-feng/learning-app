# ISSUE-151：上传文件大小限制现状梳理——multipart 200MB / 资料入库 2MB / agent 写入 2MB / JSON body 未显式配置（fastify 默认 1MiB 隐患）；限制策略待统一

- **类型**：记录 / 梳理（上传大小限制全景；与 ISSUE-131 网盘、ISSUE-141 视频播放直接相关，供拍板统一策略）
- **问题**：现在上传文件的大小限制是多少？
- **现状（已核实代码）**：
  | 通道 | 限制 | 位置 |
  |---|---|---|
  | **multipart 上传**（/files/upload 聊天附件、/materials/upload 等） | **200MB**（全局 multipart 注册，所有 multipart 通道共用） | `server/src/index.ts:63` `limits: { fileSize: 200*1024*1024 }`。⚠ **2026-09-26 勘误**：ISSUE-153 按用户拍板已**取消单包 200MB 上限**（服务端校验 + multipart Infinity + 对话框三处，随 0.5.12 部署 201）——导出/上传通道实际上限已放开，本行 200MB 为旧值，分通道限额拍板时以「Infinity 现状」为基准 |
  | **课程资料入库** putMaterial（/materials/upload 入库、parent_put_material） | **2MB** 单文件 | `parent-materials.ts:29` `MAX_PUT_BYTES` |
  | **孩子 agent fs 写工具**（write/edit） | **2MB** 单次写入 | `fs-tools.ts:17` `MAX_WRITE_BYTES` |
  | **JSON body**（非 multipart 接口；**含孩子聊天内联 base64 图片** `POST /agent/:childId/prompt` 的 images——ISSUE-125 未修前的链路） | **未显式配置 → fastify 默认 1MiB** | index.ts 无 bodyLimit 配置 |
  | 客户端预检 | **无**（ChatWindow/Learn 均无大小校验，超限传完才被服务端拒） | — |
  | （读侧参考，非上传）文本读取截断 200KB；ingest 正文上限防 10MB html 撑库 | — | parent-materials.ts:28 / kb-ingest.ts:26 |
- **问题点**：
  ① **JSON body 默认 1MiB 是隐藏坑**：孩子聊天内联图片走 JSON，手机照片 base64 后轻松超 1MiB → 413 且报错不可读；家长侧 ISSUE-124 已改走 multipart 不受影响——修 ISSUE-125 时若继续内联路线必踩，应显式配 bodyLimit 或统一改 multipart；
  ② **口径不统一且无产品语义**：200MB（通道）vs 2MB（资料/写入）差 100 倍；**2MB 对视频资料明显不够**——ISSUE-056 定调视频是重要资料形态（H.264），ISSUE-141 要做家长上传视频的网页播放，但视频入 materials 走 putMaterial 会被 2MB 拦——视频通道与限额没有答案；
  ③ **客户端无预检**：超限传完才拒，体验差、浪费带宽；
  ④ **与 ISSUE-131 网盘耦合**：网盘 upload 接口沿 multipart 即继承 200MB，但网盘「任意区域上传」后，uploads 区与 materials 区是否同限、scratch 是否对齐 fs 写 2MB，需随网盘一起定义。
- **待拍板（建议随 ISSUE-131 P1 一起定）**：
  ① **分通道限制表**：uploads 区（沿用 200MB 或按部署磁盘定）、materials 资产区（视频类放开——建议限值内按类型区分或视频单独通道，联动 ISSUE-141）、scratch 区（对齐 fs 写 2MB 或放开）；
  ② JSON bodyLimit **显式配置**（建议 ≥32MB，覆盖内联 base64 兜底场景）；
  ③ **客户端预检**：选文件时按目标区域限制即时拦截 + 明确报错文案（含限制值）；
  ④ 网盘 UI 标注各区域限制。
- **优先级**：低-中（现状可用；②视频缺口与 ISSUE-141/131 交叉，建议随网盘 P1 一起拍板）
- **记录时间**：2026-09-22

## 🔄 现状复核（2026-10-11，用户问「现在上传限制是怎么设计的」——逐项实测代码后的最新全景）

| 层 | 通道/位置 | 限制 | 代码 |
|---|---|---|---|
| **传输层（multipart，全部上传通道共用）** | /files/upload（聊天附件）/ /materials/upload（资料入库）/ /fs/upload（网盘）/ /open/agent/voice / topic-package 导入 | **不设限（Infinity）**——2026-09-26 拍板（ISSUE-153，学习主题包整包 ≈370MB），随 0.5.12 上 201；唯一硬顶=磁盘 | `index.ts:71` `limits:{fileSize:Infinity}` |
| **传输层（JSON body）** | 全局 | **未配置 → fastify 默认 1MiB**（隐患不变：孩子聊天 prompt 内联 base64 图片走此通道） | `index.ts:50` Fastify({}) 无 bodyLimit |
| ↳ 三个显式例外 | assessment/assess=**4MB**、exam/attempts=**8MB**、exam/schedules=**1MB**（显式但等于默认值） | per-route bodyLimit | routes/assessment.ts:101、exam.ts:1012/1301 |
| **应用写入层（文本类）** | parent_put_material 工具 | **2MB**（MAX_PUT_BYTES） | parent-materials.ts:30 |
| 〃 | agent fs write/edit（孩子+家长共用） | **2MB**（MAX_WRITE_BYTES） | fs-tools.ts:17 |
| **应用写入层（multipart 原始件）** | /materials/upload 入库 | **无大小限制**（流式落盘 tmp→改名；**不受** putMaterial 的 2MB 限）——视频经网页上传进 materials 实际可行（ISSUE-141 的"最后一跳"卡在播放侧不在此） | routes/materials.ts:215（stream→tmp→rename） |
| 〃 | /fs/upload 网盘 | 无（继承 Infinity） | routes/fs.ts:947 |
| **读侧参考（非上传）** | parent_read_material / read 工具文本截断 200KB；kb-ingest 正文 10MB；transferUploadMaterial（ISSUE-178 F3）二进制拷贝无限制 | — | parent-materials.ts:28-29、kb-ingest.ts |
| **客户端预检** | **无**（聊天附件/网盘/资料上传均无大小校验；唯一例外=录音 2KB 最短校验） | — | — |

**复核结论（与 09-22 版的差异）**：
1. 200MB 一行按勘误正式作废——传输层现状=**全通道 Infinity**；
2. **/materials/upload 实际不受 2MB 限**（09-22 表格把 putMaterial 2MB 与 materials/upload 混同）——2MB 只限 **agent 文本写入**（parent_put_material / fs write）；**视频经网页上传 materials 今天就能进**，限制缺口在播放侧（ISSUE-141）而非上传侧；
3. JSON 1MiB 隐患仍在（孩子聊天内联 base64 图片链路）；
4. 客户端预检仍无。

**待拍板四项不变**（分通道限制表 / bodyLimit 显式化 / 客户端预检 / 网盘 UI 标注）——本 issue 定位保持「供拍板的梳理」，不擅自定限值。

## ✅ 拍板并实施（2026-10-11，用户拍板两类区分）

**拍板**：①凡 app 客户端上传到 server 端**存储/处理**的——不设限制（局域网/本机传输）；②凡 server 收到后**需要外发第三方**的（ASR 音频、评测音频、视觉图片等）——设限制。

**实施**：
- 新增 `server/src/util/limits.ts`：拍板常量——`ASR_AUDIO_MAX_BYTES`/`ASSESS_AUDIO_MAX_BYTES`=20MB、`VISION_IMAGE_MAX_BYTES`=10MB、`JSON_BODY_LIMIT`=16MB（+ bytesLabel 文案助手），头注释写明两类区分原理；
- **存储类**（不变+标注）：multipart 全通道 Infinity（index.ts 注释更新为 151 拍板口径）；
- **外发类四处 413**：
  - `routes/asr.ts` /asr/transcribe：收集循环累计超 20MB → 413 可读文案（**超限不提前 break**——multipart 流未消费完会 500，drain 后统一返回）；路由 bodyLimit 24MB（>全局 16MB，让语义化 413 可达）；
  - `routes/open-api.ts` /open/agent/voice：audioBuf 超限 413 + 路由 bodyLimit 24MB（audio/* 自定义 parser 自带 51MB，route 24MB 为语义检查兜底定位）；
  - `routes/assessment.ts` readAudioBytes：>20MB → ApiError 413「缩短录音时长」（存储不限、外发环节拦）；
  - `agent/vision.ts` describeImageViaVision：入口 base64 反推字节 >10MB → 报错「压缩或降低分辨率」；
- **JSON body 全局 16MB**（index.ts Fastify bodyLimit）：解除孩子聊天内联 base64 图片的 1MiB 隐藏坑（外发类兜底；存储类走 multipart 不受限）；既有 per-route（assessment 4MB/exam 8MB/schedules 1MB）优先级更高不受影响。

**验证**：`test/issue151-limits.test.ts` 3 例全绿（常量锁定 + asr/voice 两个真监听 fetch 413 用例）。**踩坑三连**：①inject 手工构造 multipart 的 CRLF 被 heredoc 转义层污染（Unexpected end）→ 改真监听+原生 fetch/FormData；②bash/quoted-heredoc 转义吃 `\n`（同 ISSUE-178 教训）→ 复杂注入一律 Edit 工具；③**multipart 超限不能在 for-await 里提前 return**（流未消费完 → 500 Unexpected end）→ drain 后统一 413；④fastify bodyLimit 三层实证（全局/parser/route）：parser 显式 > route > 全局——语义化 413 可达需 route bodyLimit > 应用阈值。

**待部署 201**：随下次服务端发版。客户端预检（待拍板四项之③）与网盘 UI 标注（④）仍开放。EOF
echo done
__zcode_status=$?
if [ "$__zcode_status" -eq 0 ]; then pwd -P > '/c/Users/79734/AppData/Local/Temp/zcode-d6eef5f1-033a-4a76-863e-5c322230b507-cwd'; fi
exit "$__zcode_status"

## ✅ 拍板并实施（2026-10-11，用户拍板两类区分）

**拍板**：①凡 app 客户端上传到 server 端**存储/处理**的——不设限制（局域网/本机传输）；②凡 server 收到后**需要外发第三方**的（ASR 音频、评测音频、视觉图片等）——设限制。

**实施**：
- 新增 `server/src/util/limits.ts`：拍板常量——ASR/评测音频 20MB、视觉图片 10MB、JSON body 16MB（+bytesLabel 文案助手），头注释写明两类区分原理；
- **存储类**（不变+标注）：multipart 全通道 Infinity（index.ts 注释更新为 151 拍板口径）；
- **外发类四处 413**：
  - routes/asr.ts /asr/transcribe：收集循环累计超 20MB → 413 可读文案（**超限不提前 break**——multipart 流未消费完会 500，drain 后统一返回）；路由 bodyLimit 24MB（>全局 16MB，让语义化 413 可达）；
  - routes/open-api.ts /open/agent/voice：audioBuf 超限 413 + 路由 bodyLimit 24MB（audio/* 自定义 parser 自带 51MB）；
  - routes/assessment.ts readAudioBytes：>20MB → ApiError 413「缩短录音时长」（存储不限、外发环节拦）；
  - agent/vision.ts describeImageViaVision：入口 base64 反推字节 >10MB → 报错「压缩或降低分辨率」；
- **JSON body 全局 16MB**（index.ts Fastify bodyLimit）：解除孩子聊天内联 base64 图片的 1MiB 隐藏坑（外发类兜底；存储类走 multipart 不受限）；既有 per-route（assessment 4MB/exam 8MB/schedules 1MB）优先级更高不受影响。

**验证**：test/issue151-limits.test.ts 3 例全绿（常量锁定 + asr/voice 两个真监听 fetch 413 用例）。踩坑：①inject 手工构造 multipart 的 CRLF 被 heredoc 转义层污染（Unexpected end）→ 改真监听+原生 fetch/FormData；②multipart 超限不能在 for-await 里提前 return（流未消费完 → 500）→ drain 后统一 413；③fastify bodyLimit 三层实证（全局/parser/route）：parser 显式 > route > 全局——语义化 413 可达需 route bodyLimit > 应用阈值。

**待部署 201**：随下次服务端发版。客户端预检（待拍板四项之③）与网盘 UI 标注（④）仍开放。

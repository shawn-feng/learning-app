# ISSUE-151：上传文件大小限制现状梳理——multipart 200MB / 资料入库 2MB / agent 写入 2MB / JSON body 未显式配置（fastify 默认 1MiB 隐患）；限制策略待统一

- **类型**：记录 / 梳理（上传大小限制全景；与 ISSUE-131 网盘、ISSUE-141 视频播放直接相关，供拍板统一策略）
- **问题**：现在上传文件的大小限制是多少？
- **现状（已核实代码）**：
  | 通道 | 限制 | 位置 |
  |---|---|---|
  | **multipart 上传**（/files/upload 聊天附件、/materials/upload 等） | **200MB**（全局 multipart 注册，所有 multipart 通道共用） | `server/src/index.ts:63` `limits: { fileSize: 200*1024*1024 }` |
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

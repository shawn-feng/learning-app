# ISSUE-165：ASR 凭证配置改读服务端（用户拍板）——终结「每台设备各自一份 voice-config.json + 本机 auth.json 兜底」的多设备不同步

- **类型**：架构 / 需求（已拍板待实施；ISSUE-052/131 讨论的架构尾巴收口）
- **背景（现状，已核实代码）**：
  - ASR 是**纯客户端能力**：转录在 Electron 主进程（`voice:transcribe` → `transcribeAudio`，electron/lib/voice/index.ts:32，qwen/mimo 四通道），**服务端零 ASR 路由**；
  - 凭证两处都在**本机磁盘**：`<本机data>/shared/voice-config.json`（provider 选择 + 各通道 apiKey/endpoint，voice-config.ts:74）+ apiKey 留空时兜底读**本机** `parents/<pid>/auth.json` 同名 provider key；
  - **问题**：多设备不同步——家长在一台设备改默认转写模型/key，别的设备读自己本机旧配置（每次转录现读本机文件，voice/index.ts:33，本机改了立即生效、跨设备永不同步）；第二台设备/重装没本机配置直接「配置不完整」；key 明文落客户端磁盘（与评测凭证已上收服务端 `assessment_config` AES-256-GCM 的既有决策不一致）。
  - 对照：语音三件套里 **TTS 已服务端合成**（ISSUE-080 定案）、**发音评测凭证已上收**（assessment_config），**只有 ASR 没上服务端**。
- **✅ 用户拍板（2026-09-27）**：ASR 凭证配置改成**读取服务端**。
- **方案（对齐 assessment_config 现成范式，改动面小）**：
  ① **服务端**：ASR 配置存 `settings` 表 per-parent 键（如 `asr_config`，对齐 assessment_config 模式；shape 沿用现有 VoiceConfig：enabled/provider/providers 四通道 apiKey/endpoint）；凭证落盘 AES-256-GCM 加密（复用 crypto.ts encryptJson，同 auth/assessment）；新路由组 `routes/asr.ts`（或并入 assessment）：`GET/PUT /api/v1/asr/config`（GET 回打码版）+ `POST /api/v1/asr/transcribe`（**转录服务端执行**：收音频 → 按配置调 DashScope/token-plan/MiMo 云端 ASR → 回文本；provider 实现从 electron/lib/voice/providers/* 迁移）；
  ② **客户端 Electron**：`voice:transcribe` 改「本机转 wav → 上送服务端 → 服务端转写」；VoiceSettings 读写改走服务端 config 接口（打码回显、key 修改 PATCH）；本机 voice-config.json 退役（一次性导入后停用）；
  ③ **兜底语义上收**：现「apiKey 留空回退本机 auth.json」作废——服务端配置 key 留空时由**服务端**回退读同家长 auth 封套（settings `auth` 键，服务端本来就有），语义保持、真源唯一；
  ④ **Web 端（可选增强，不阻塞）**：web shim stt 现用浏览器 SpeechRecognition（无法转写传入 buffer、无凭证通道，web/src/shim/voice/stt.ts）——服务端转录端点落地后升级为同链路（录音上送→服务端转写），消除双端差异；
  ⑤ **断网语义**：转录必须经服务端（云端 ASR 本就要网），客户端连不上服务端时语音输入不可用属可接受。
- **回归**：四通道（qwen/qwen-tokenplan/mimo/mimo-tokenplan）转录行为不变（含 ISSUE-052 修复的 token-plan 响应结构兼容）；VoiceSettings 打码回显/测试按钮语义不变；**家长改配置后所有设备下次转录即生效**（本 issue 核心验收）；旧 voice-config.json 残留不生效；三条调用链（聊天语音输入 ChatWindow、背诵题 ExamView、设置页测试 VoiceSettings）全过。
- **优先级**：中（多设备一致性 + 密钥治理；范式现成，改动集中在配置搬运 + 一个服务端转录端点）
- **记录时间**：2026-09-27

## ✅ 实施记录（2026-09-28，服务端 0.5.18）

**服务端**（新增 `server/src/asr/` + `server/src/routes/asr.ts`，`index.ts` 注册）：
- `asr/config.ts`：真源存 settings `<parentId>:asr_config`（AES-256-GCM 复用 crypto.ts，shape 沿用客户端 VoiceConfig 零转换）；打码 GET（apiKey 前6+****+后4，endpoint 非凭证明文回显）；补丁语义「空值或含 *」跳过（与旧客户端逐字对齐）；**兜底语义上收**——`getAuthEnvelopeKey` 读同家长 settings `<parentId>:auth` 封套，按 endpoint 含 "token-plan" 选 `<family>-tokenplan` 段（判定规则沿用旧本机 auth.json）；`getTranscribeCandidates` 默认服务在前、其余已配置按固定顺序在后（对齐旧 `getTranscribeCandidates`）；「任一通道可用即视为已启用」的展示语义保留在 GET。
- `asr/providers.ts`：从 `electron/lib/voice/providers/{qwen,mimo}.ts` 移植，请求体/响应多路径解析（ISSUE-052）/「没有识别到语音」判定逐字保留；唯一差异是兜底 key 由调用方注入（服务端从 auth 封套解析）。
- `routes/asr.ts`：`GET/PUT /api/v1/asr/config`（家长 JWT；PUT=补丁保存回打码版）+ `POST /api/v1/asr/transcribe`（multipart file=16k wav + 可选 provider 字段=设置页单通道测试）。「没有识别到语音」属语义错误 400 短路不回退；回退链失败 502 聚合错误；单通道测试回原始错误（对齐旧客户端直显 provider 报错）。认证对齐 assessment/models 的 ApiError 范式。

**客户端 Electron**（IPC 面不变，preload 零改动）：
- `voice:config:get` → 服务端 GET；**服务端 stored=false 且本机存在旧 voice-config.json 时一次性导入**（PUT 全量补丁，成功后本机文件改名 `voice-config.json.retired-<ts>` 退役；服务端失败则导入保持待重试、本机文件不动）。
- `voice:config:set` → 服务端 PUT。
- `voice:transcribe` → 本机 webm→16k wav（webmToWav16k，ffmpeg 链路不变）→ `serverUploadWithFields` 上送 → `{text}`；返回 `{success,text,audio=原始webm base64}` 形状不变（ChatWindow/ExamView/VoiceSettings 三条调用链零改动）。
- `electron/lib/voice/voice-config.ts` 重写为一次性导入模块；`providers/qwen.ts`、`providers/mimo.ts` 删除；`serverFetch` 方法枚举补 `PUT`。

**Web 端（原可选增强，已一并落地）**：`web/src/shim/domains/voice.ts` 的 voiceConfigGet/Set 改走服务端 /asr/config（localStorage "web.voiceConfig" 废弃）；voiceTranscribe 改「浏览器解码 16k WAV → POST /asr/transcribe」，服务端不可达/未配置时**降级并行听写会话结果**（保留浏览器引擎开箱即用，Firefox 也能用服务端链路）；旧「浏览器不支持」硬失败仅在服务端也失败时报。

**测试/验证**：
- `test/qwen-asr.test.ts` 随迁移指向服务端实现（8 例全绿，含 ISSUE-052 三种响应结构、静音短路、真因透出），新增兜底 key 注入/配置不完整 2 例；`test/issue165-asr-config.test.ts` 5 例（密文落盘、补丁语义、打码、封套兜底选段、候选顺序）。
- HTTP 冒烟（临时数据目录真启服务端，自签 JWT）：GET 默认/stored 标记、401、PUT 保存、打码回显、**打码回显原样 PUT 不丢 key**、multipart provider 字段位置无关、单通道错误形态全过；转录链路真实打到 DashScope（假 key → `[InvalidApiKey]` 聚合 502，证明 multipart→配置→候选→provider→回退全链路通）。冒烟抓出并修复两个 bug：①路由见 file part 即 break，provider 字段排在文件后读不到（改为扫全部 part）；②单通道测试误套聚合头。
- 根 `electron-vite build` 过；web build 过；web typecheck 我改的文件 0 报错；全量 vitest 除 issue144 预存失败（stash 基线复现，与本次无关）外全绿。
- 版本：服务端 0.5.18（version.ts + server/package.json）、客户端 0.1.22（root package.json，未打包安装包）。

**兼容注意**：新客户端打旧服务端（≤0.5.17）时 /asr/* 404 → 语音输入不可用（报「服务端错误 HTTP 404」）；旧客户端打新服务端行为不变（仍读本机文件，配置不互通但不报错）。两端需成对升级；201 部署待执行（部署后老设备一次性导入会把本机配置上收，多设备即以服务端为准）。

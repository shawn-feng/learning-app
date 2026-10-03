# 学习伙伴 · 开放 API 接入指南（第三方设备 / ESP32-S3）

> 版本：2026-10-03（对应 learning-server 0.5.19+；**语音消息 + TTS + 公网 HTTPS 接入已可用**）
> 读者：第三方系统开发者（首个接入方：ESP32-S3 硬件固件）
> 本文档是**接入契约**，接口行为以服务端实现为准；设计背景见 `docs/开放API-设计方案-2026-09-28.md`

---

## 1. 概览

开放 API 让第三方设备以与 app 内聊天框**相同的能力**调用服务端 agent：

- 发文字消息，拿 agent 回复；
- **语音对话**：录音直发（`/open/agent/voice`），服务端 ASR 转录后对话，并可开启 TTS 把回复合成音频返回；
- 上传并引用附件（图片 / 文本文件 / 音频等），agent 能读图片（视觉模型）和文本内容；
- 获得 agent 的**思考过程**（thinking）与**工具调用**（tool calls）明细；
- 会话与 app 内聊天框是**同一条主会话**：设备发的消息和回复在 app 端实时可见，上下文连续，每天自动开新会话。

**服务端地址**（同一台 server，两个入口，接口与 Key 完全一致）：

| 入口 | 地址 | 适用场景 |
|---|---|---|
| 公网 HTTPS（推荐） | `https://open.aixuexihao.top` | ESP32 任何网络（家里 WiFi / 手机热点 / 外出），TLS 加密 |
| 家庭内网 HTTP | `http://192.168.1.201:8788` | 同一 WiFi 下直连，延迟最低（少一跳云） |
| 开发联调 | `http://<开发机IP>:8788` | 开发环境 |

公网入口由阿里云 ECS nginx 反代 + SSH 反向隧道实现（家里 server 不开任何入站端口），只转发 `/api/v1/open/` 前缀；详见 §12。内网地址是明文 HTTP，仅限家庭内网使用；**公网入口一律走 HTTPS，Key 不会明文过网**。

## 2. 获取 API Key（账号持有人操作）

1. 家长在**学习伙伴 app（或网页端）→ 设置 → 开放接口**生成 API Key；
2. 生成时可绑定**默认孩子**（推荐：设备无需关心 childId）；
3. 完整 Key **只展示一次**（关闭弹窗后无法再查看，遗失只能重新生成，旧键立即失效）；
4. 每个账号同时只有一个有效 Key；重新生成 / 吊销都会让旧键立刻 401。

Key 格式：`laxk_` + 43 位随机串（总共 48 字符）。

## 3. 鉴权

两个请求头任选其一（所有 `/api/v1/open/*` 端点通用）：

```
Authorization: Bearer laxk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
X-API-Key:     laxk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

- 无效 / 已吊销 → `401 {"error":"API Key 无效或已吊销"}`
- 请求的孩子不属于该账号 → `403 {"error":"无权访问该孩子的数据"}`

## 4. 快速开始（两条 curl 跑通）

```bash
# ① 查会话忙闲（顺便验证 Key）
curl -H "X-API-Key: $KEY" \
  "http://192.168.1.201:8788/api/v1/open/agent/status"

# ② 发一条消息，拿回复（NDJSON 流：若干 progress 行 + 最后 1 行 final）
curl -s -N -X POST "http://192.168.1.201:8788/api/v1/open/agent/chat" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"text":"你好，请自我介绍一下"}'
```

`chat` 的响应体（逐行 JSON，UTF-8）：

```
{"type":"progress","thinking":"用户想让我自我介绍…","tools":[],"text":""}
{"type":"progress","thinking":"…","tools":[],"text":"你好呀！我是"}
{"type":"final","ok":true,"reply":"你好呀！我是学习伙伴…","thinking":"…","tools":[],"duration_ms":3367}
```

**两种读法都成立**：

- **朴素客户端**：等连接关闭后整体读 body，**取最后一行**就是最终结果（等价普通同步 API）；
- **进度客户端**：逐行读，实时显示"思考中 / 正在用工具 / 作答中"（快照是**累积全量**，直接覆盖显示即可，无需自己拼接）。

`final` 行字段：

| 字段 | 说明 |
|---|---|
| `ok` | 本轮是否成功产出回复 |
| `reply` | 最终文本回复（`ok:true` 时必有） |
| `thinking` | 完整思考过程文本（可能为空串） |
| `tools` | 工具调用列表 `[{name, done, error}]` |
| `duration_ms` | 本轮耗时 |
| `error` | `ok:false` 时的错误说明 |
| `timed_out` | `true` = 接口超时收口，返回的是**部分**回复（语义见 §7，**不要直接当失败重发**） |

## 5. 接口参考

### 5.1 同步对话（推荐 ESP32 使用）

```
POST /api/v1/open/agent/chat
Content-Type: application/json

{
  "text": "这道题怎么算？",                  // 必填（与 attachments 至少一个非空）
  "attachments": [                            // 可选，见 §6
    {"kind": "image", "name": "math.jpg", "ref": "files/<uuid>"}
  ],
  "child_id": "可选，缺省用 Key 绑定的孩子",
  "caps": "mic",                              // 可选，设备能力声明（见下）
  "timeout_ms": 240000                        // 可选，5000~600000，默认 240000
}
```

**长连接语义（务必配置 HTTP 客户端等待，2026-09-30 补充）**：本接口是一次**长 HTTP 请求**——服务端持有连接直到本轮结束才写完响应，典型 3~15 秒，涉及工具查询时可达数十秒，上限 `timeout_ms`（缺省 240s）。**设备的 HTTP 读超时必须 ≥ `timeout_ms` + 15s；不要使用 HTTP 库的默认超时（通常 5~30s，会在服务端仍在处理时提前断流，表现为"连接被关闭而拿不到回复"）**。发出请求后阻塞读响应即可，不是轮询。

- `caps`：逗号分隔的能力声明，当前支持 `mic`（设备有麦克风/录音能力）。未声明则按最小能力装配（设备无法执行的工具不会注册给 agent，agent 会改用对话引导——如实上报即可）。
- `tts`（可选，`true/1/on` 开启）：服务端把回复合成音频随 final 行下发，见 §5.5；`voice`（可选）指定音色 id；`tts_rate`（可选，ESP32 推荐 `16000`）指定输出采样率——**传入即输出 16bit 单声道 WAV**（全 16k 零重配置方案直喂），缺省为 24kHz MP3。
- 响应：`200` NDJSON 流（§4）；`409` busy（§7）；`429` 限流；`400/401/403` 参数/鉴权问题。

### 5.2 语音消息（录音直发，服务端 ASR + 可选 TTS）—— ESP32 语音对话首选

```
POST /api/v1/open/agent/voice?child_id=可选&tts=true&timeout_ms=可选
                         &fmt=可选&sample_rate=可选&channels=可选&tts_rate=可选
X-API-Key: $KEY
Content-Type: audio/wav          # 裸流：body 即音频字节（multipart 亦可，file 字段 + 同名参数字段）
<音频二进制>
```

服务端流程：**音频 → ffmpeg 转 16k wav → ASR 转录（按账号配置的语音服务，qwen/MiMo 多通道回退）→ 以转录文本发起一轮对话 → （tts 开启时）合成回复音频**。

**长连接语义**：与 §5.1 相同——一次长 HTTP 请求，服务端持有连接直到本轮结束；**设备读超时必须 ≥ `timeout_ms` + 15s，勿用 HTTP 库默认超时**（见 §7）。

**输入格式参数**（设备采样率不必是 16k——服务端统一转，录音侧随意）：

| 参数 | 说明 |
|---|---|
| `fmt` | `wav`（缺省，自描述格式：wav/webm/opus/mp3/amr 均可，服务端按内容探测）或 `pcm`（**裸 PCM**：s16le 小端、无文件头，嵌入式直传） |
| `sample_rate` | 录音采样率 Hz（**推荐 `16000`**，见下方零重配置方案）；`fmt=pcm` 时**必填**，自描述格式可省（读文件头） |
| `channels` | 录音声道数（缺省 1） |

**零重配置方案（推荐：全 16k，2026-09-30 定案）**：设备编解码器固定 **16kHz** 一档——录音 16k 直传（`fmt=pcm&sample_rate=16000`），回复用 `tts_rate=16000` 拉 16k WAV 播放，全程零次编解码器重配置。理由：ASR 本来就只吃 16k（录音侧零质量损失）；TTS 从 24k 源降采样到 16k 仅截去 8kHz 以上高频，小喇叭播放场景不可闻；固件可省掉 MP3 解码库（16k WAV 的 PCM 直接喂 I2S）；上传体积只有 48k 的 1/3（32KB/s），实测 15.9s 录音端到端从 ~7.0s 降到 ≈5.3s。
备选：全 48k（`sample_rate=48000` + `tts_rate=48000`）——播放频响更宽，代价是上传体积 3 倍，仅在硬件扬声器能还原 8kHz+ 且带宽充裕时考虑。

- **与"上传的音频文件"的区别**：本端点的音频是**一句消息本身**，服务端会对它做 ASR；要给 agent 传音频文件（存档/引用，不转录）仍走 `/open/files/upload` + `attachments`（§6）。
- ASR 阶段失败（流未开始）返回普通 JSON 错误：`400` 音频无效/太短/未启用语音输入/没有识别到语音/`fmt=pcm` 缺 sample_rate、`502` 语音服务失败（含未找到 ffmpeg）。
- 成功时响应为 NDJSON 流（同 §4），final 行额外字段：

| 字段 | 说明 |
|---|---|
| `transcript` | ASR 转录文本（即本轮发给 agent 的内容） |
| `audio` | `tts=true` 且回复成功时：`{ref, url, mime, size, voice, sample_rate?}`——`tts_rate` 未传为 24kHz MP3，传了为对应采样率 WAV |
| `audio_error` | TTS 合成失败的原因（本轮文本回复仍有效） |

**录音要求**：推荐 16k 采集（全 16k 零重配置方案，见上）；最短约 0.2 秒（太短会被拒）。**单条语音时长上限 ≈8 分钟**——云端 ASR 的 data-uri 20MB 硬限制（实测边界 491s@16k），超限返回 502 TooLarge；建议单条 ≤5 分钟，更长的内容请分段对话。

### 5.3 下载文件（TTS 音频 / 附件回放）

```
GET /api/v1/open/files/<id>
X-API-Key: $KEY      → 200 文件字节流（Content-Type/Length 齐全）；404 = 不存在或不属于该账号
```

`chat`/`voice` final 行 `audio.url` 即此端点的相对路径，直接拼服务端地址下载。

### 5.4 提交 + SSE 流式（需要逐字回放/断线重连时用）

```
POST /api/v1/open/agent/prompt        // 提交一轮，立即返回 {"ok":true}；增量走下面的流
GET  /api/v1/open/agent/stream        // SSE 事件流（与 app 端协议完全一致）
```

SSE 事件（`event:` → `data:`）：

| event | data | 说明 |
|---|---|---|
| `hello` | `{childId, caps, ts}` | 建连应答；data 前的 `id:` 是当前事件游标 |
| `user_message` | `{text, pageEvents}` | 输入回显 |
| `thinking_delta` | `{delta}` | 思考过程**增量** |
| `text_delta` | `{delta}` | 回复文本**增量**（需自行累积拼接） |
| `tool_start` | `{toolCallId, toolName, args}` | 工具调用开始（含参数） |
| `tool_progress` | `{toolCallId, toolName, progress}` | 长工具进度文本 |
| `tool_end` | `{toolCallId, toolName, isError, result}` | 工具结束（含完整结果） |
| `message_end` | `{message}` | 单条 assistant 消息完成（content blocks 原样） |
| `agent_end` / `turn_end` | `{}` | `turn_end` 是一轮的可靠终点 |
| `error` | `{message}` | 错误（模型失败/看门狗中止等） |

断线重连：重连时带 `Last-Event-ID: <上次收到的最大id>` 请求头（或 `?lastEventId=`），服务端重放之后的事件（环形缓冲 500 条）。每 15s 有 `: ping` 注释行保活。

### 5.5 会话辅助

```
GET  /api/v1/open/agent/status      → {"busy": false, "child_id": "…"}
POST /api/v1/open/agent/abort       → {"ok": true, "aborted": true}   // aborted=false=本来没在跑
GET  /api/v1/open/agent/history     → {"messages": [{role, content[], timestamp, ...}]}
```

`history` 的 `messages[].content` 是原始 content blocks 数组，**包含 thinking 块和 tool 调用块**——第三方回放完整过程可直接用。请求带 `?child_id=` 可覆盖 Key 默认孩子。

### 5.6 附件上传（两种形态）

**A. 裸流（推荐 ESP32 使用）**——body 就是文件原始字节：

```
POST /api/v1/open/files/raw?filename=rec.wav&kind=audio&child_id=可选
X-API-Key: $KEY
Content-Type: audio/wav          # 须设置：application/octet-stream / audio/* / image/* / text/* 均可

<二进制内容>
```

**B. multipart**（`file` 字段 + 可选 `child_id` 字段）：

```
POST /api/v1/open/files/upload
```

两者响应相同：

```json
{
  "file": {"id": "<uuid>", "original_name": "rec.wav", "mime": "audio/wav", "size": 12345, "created_at": "..."},
  "ref": "files/<uuid>",
  "marker": "【附件音频：rec.wav|files/<uuid>】"
}
```

拿到 `ref` 后在 `chat` 的 `attachments` 里引用即可（`marker` 字段是服务端组装好的标记，仅供调试参考，**不要**自己拼标记文本，直接用 `attachments` 参数）。

## 6. 附件与语音规范

| 类型 | 端点 | 支持格式 | agent 侧能力 |
|---|---|---|---|
| **语音消息** | `POST /open/agent/voice`（§5.2） | 自描述格式（wav/webm/opus/mp3/amr）或裸 PCM（`fmt=pcm&sample_rate=`，采样率随意） | **服务端 ASR 转录**后以其文本对话（账号未配置语音服务时报 400） |
| 图片 | `chat` attachments kind=image | png / jpg / jpeg / webp / gif / bmp | **能看**：走视觉模型识图 |
| 文本文件 | `chat` attachments kind=file | txt / md / csv / json / xml / yaml / html / 代码 / srt 等 | **能读**：文本内容直接进上下文 |
| 音频文件 | `chat` attachments kind=audio | wav / mp3 / m4a / aac / ogg / opus / webm / amr | 仅存档引用（不转录）——要"让 agent 听"请走语音消息端点 |

`kind` 省略时按扩展名自动推断。**TTS 回复**：`chat` 与 `voice` 均支持 `tts=true` 参数开启，服务端用 edge-tts（免费，账号无需配置）合成；`tts_rate` 缺省为 24kHz 单声道 MP3，传 `tts_rate=16000` 则输出 16kHz 16bit 单声道 WAV（**全 16k 零重配置方案的推荐值**，设备免 MP3 解码直喂 I2S）；`voice` 参数可指定音色 id（缺省按文本语种自动选：中文晓晓 / 英文 Sonia）。体积参考：WAV ≈ 采样率×2 字节/秒（16k = 32KB/s，48k = 96KB/s），MP3 ≈ 12KB/s。裸流上传上限 50MB。

## 7. 超时 / 并发 / 重试语义（重要）

**长连接约定**：`chat` / `voice` 是**一次长 HTTP 请求**——服务端先订阅事件流再提交，**持有连接直到本轮结束才应答**（NDJSON 最后一行 final）。不是"提交后轮询"，也不是"秒回"：典型 3~15 秒，涉及工具查询数十秒，上限 `timeout_ms`（缺省 240s）。设备发出请求后阻塞读响应，**读超时必须覆盖整个处理窗口**（下表第三行），否则会在服务端仍在处理时提前断流（表现为"连接关闭而拿不到回复"——该轮其实还会在服务端跑完，可用 `history` 找回）。

一轮 agent（含工具链）可能持续数秒到数分钟，超时由三层兜底，**第三方最长等待有上界**：

| 层 | 参数 | 行为 |
|---|---|---|
| 服务端会话看门狗 | 模型静默 240s / 单工具 30min 硬上限 | 自动 abort 本轮 → 你会收到 `ok:false` 的 final 行 |
| 接口超时（chat） | `timeout_ms`（默认 240s） | 返回部分回复 + `timed_out:true` 并关闭连接 |
| 设备侧 HTTP 超时 | 建议 `timeout_ms` + 15s | 兜住网络黑洞 |

**并发红线**：同一孩子同一时刻只允许一轮（与 app 共享会话）。上一轮没结束时的表现：

- `chat` → `409 {"error":"busy：上一轮还在回答，请稍候"}`；
- 设备收到 409 后**退避重试**（建议 2s 起步，指数退避）；
- app 端有人在对话时设备也会 409——这是设计行为（上下文不交错）。

**`timed_out:true` 处理**：不等于失败——可能长工具还在正常跑。正确动作：

```
收到 timed_out → GET /status 查 busy
  busy=true  → 周期查询（建议 5s 间隔）直到 busy=false，再用 history 补结果；期间不要重发消息（必 409）
  busy=false → 按"本轮无果"处理，可重新发起
需要放弃时：POST /abort 强制中止当前轮
```

## 8. 错误码总表

| 状态码 | 含义 | 设备侧动作 |
|---|---|---|
| 400 | 参数错误（body 非法、ref 非法、text+attachments 全空等） | 修正请求；**不要重试** |
| 401 | Key 缺失/无效/已吊销 | 停止请求，提示账号持有人重新生成 |
| 403 | child_id 不归属该账号 | 修正 child_id 或让持有人重新绑定 |
| 409 | 会话忙（上一轮进行中） | 退避重试或走 §7 timed_out 流程 |
| 429 | 限流（每 Key 30 次/分钟） | 退避 ≥1 分钟内的剩余窗口 |
| 502/5xx | 服务端内部/模型错误 | 可重试（建议间隔 ≥5s）；持续失败报修 |

⚠️ **HTTP 客户端坑位提醒**：无 body 的请求（如 `POST /abort`、`DELETE`）**不要**设置
`Content-Type: application/json` 头，否则服务端按"空 JSON body"拒绝（400）。
要么不带该头，要么发 `"{}"` 作 body。

## 9. ESP32-S3 实践要求

1. **推荐调用流（语音对话，全 16k 零编解码器重配置，2026-09-30 定案）**：设备编解码器固定 **16kHz** 一档 → 录音 16k 裸 PCM `POST /open/agent/voice?fmt=pcm&sample_rate=16000&tts=true&tts_rate=16000` → 读 final 行 `transcript/reply` → 从 `audio.url` 下载 **16k WAV** 直喂 I2S 播放（**无需 MP3 解码库**）。全程零重配置，上传体积 32KB/s。
   **图文问答**：`POST /open/files/raw` 拿 `ref` → `POST /open/agent/chat`（带 attachments）。
2. **Key 保管**：Key 不得硬编码进出厂固件镜像；配网时由账号持有人下发，存 NVS/加密分区；提供更换入口（对应 app 端"重新生成"）。
3. **传输**：远程/外网场景一律走公网入口 `https://open.aixuexihao.top`（ECS nginx TLS 终结 + 反向隧道，见 §12），Key 不明文过网；不要自行打洞或把家庭 server 端口映射到公网。
4. **HTTP 客户端**：`Content-Length` 必须与实际 body 字节数一致（多字节中文按 UTF-8 字节算）；读响应建议流式逐行读（NDJSON），至少也要等连接关闭后取最后一行。
5. **重试纪律**：只对 409/429/网络错误重试；400/401/403 重试无意义。
6. **语音账号前提**：账号持有人需在 设置 → 语音配置 中启用语音输入并配置 ASR 凭证（qwen/MiMo 任一通道），否则 `/open/agent/voice` 返回 400"语音输入未启用"。
7. **音频体积参考**：16k WAV = 32KB/s（录音上传与 TTS 下载同价）；若改用缺省 TTS（24k MP3 ≈ 12KB/s）则设备需软解码+重采样，仅在带宽极紧张时考虑。
8. 联调期可用 `GET /open/agent/history` 和 app 内聊天框对照，验证设备发的消息是否如期到达。

## 10. 最小 C++ 参考流程（Arduino HTTPClient 风格伪代码）

> 示例用内网 base；外网/外出场景把 `http://192.168.1.201:8788` 换成 `https://open.aixuexihao.top` 即可（HTTPS 需在固件加载 ISRG Root X1 根证书，见 §12）。

**语音对话（全 16k 主路径，一次请求完成 录音→ASR→回复→TTS 音频）**：

```cpp
// 编解码器固定 16k：录好的 16k/16bit/单声道裸 PCM 直传，服务端转 ASR + 合成 16k WAV 回复
http.begin("http://192.168.1.201:8788/api/v1/open/agent/voice?fmt=pcm&sample_rate=16000&tts=true&tts_rate=16000&timeout_ms=120000");
http.addHeader("X-API-Key", apiKey);
http.addHeader("Content-Type", "application/octet-stream");
int code = http.POST(pcmData, pcmLen);           // 200 = NDJSON 流；409 = busy 退避重试
// WiFiClient 流式读行：遇 "type":"final" 解析 transcript/reply/audio.url；
// GET audio.url（带 X-API-Key）→ 16k WAV 字节直写 I2S 播放，无需 MP3 解码库
```

**图文问答（文本 + 附件）**：

```cpp
// 1) 上传附件（裸流）
http.begin("http://192.168.1.201:8788/api/v1/open/files/raw?filename=math.jpg&kind=image");
http.addHeader("X-API-Key", apiKey);
http.addHeader("Content-Type", "image/jpeg");
int code = http.POST(jpgData, jpgLen);           // 返回 200，解析出 "ref":"files/<uuid>"

// 2) 同步对话（读 NDJSON，逐行取 type=="final"；要语音播报加 "tts":true,"tts_rate":16000）
http.begin("http://192.168.1.201:8788/api/v1/open/agent/chat");
http.addHeader("X-API-Key", apiKey);
http.addHeader("Content-Type", "application/json");
String body = "{\"text\":\"这道题怎么算\",\"attachments\":[{\"kind\":\"image\",\"name\":\"math.jpg\",\"ref\":\"" + ref + "\"}],\"timeout_ms\":120000}";
code = http.POST(body);                          // 200 = 流式 body；409 = busy 退避重试
// 流式读行：遇 "type":"final" 解析 ok/reply；连接关闭未读到 final → 按网络失败处理
```

## 11. 联调自检清单

- [ ] `status` 返回 200 且 `busy` 字段正常（Key 有效）
- [ ] `chat` 纯文本能拿到 `final` 行 `reply`（在 app 聊天框能看到这条对话）
- [ ] `voice` 录音直发能拿到 `transcript`（与说话内容一致）和 `reply`
- [ ] `tts=true&tts_rate=16000` 时 `audio.url` 下载的是 16k WAV 且设备端直喂播放（无需 MP3 解码）
- [ ] 409 场景验证过（app 端正在对话时设备发消息）
- [ ] 图片附件能让 agent 说出图片内容；txt 附件能让 agent 引用内容
- [ ] 设备侧 HTTP 读超时 > `timeout_ms`；409 有退避；`timed_out` 后走 status 轮询
- [ ] Key 存储不在固件镜像里，配网可更换

## 12. 公网接入（外网 / 外出场景，2026-10-03 上线）

家里 server 不开任何公网入站端口，公网入口完全由云端承担：

```
ESP32 ──HTTPS──> 阿里云 ECS nginx :443 (open.aixuexihao.top)
                    │  只转发 /api/v1/open/ 前缀，其余 404
                    ▼
              127.0.0.1:18788 (ECS 本机)
                    ▲ SSH 反向隧道（201 主动外连 :2222，autossh 式常驻 systemd 单元 ecs-tunnel）
              家里 201 learning-server :8788
```

- **域名与证书**：`open.aixuexihao.top` → ECS 公网 IP（47.96.154.226），Let's Encrypt 证书（与 www/auth 同一张 4 域名证书，certbot 自动续期）。
- **设备侧 HTTPS**：mbedTLS 需内置 Let's Encrypt 根证书 **ISRG Root X1**（ESP32-S3 + PSRAM 握手无压力）。
- **与内网地址的关系**：路径、参数、Key、限流、返回体完全一致，只是 base URL 不同。音频/文件 URL 都是相对路径（`/api/v1/open/files/<id>`），跟随设备所用的 base，无需拼接。
- **推荐策略**：设备配双 base——家庭 WiFi 下探内网 `http://192.168.1.201:8788`（快、省云流量），不通则回落公网 `https://open.aixuexihao.top`；嫌复杂就统一走公网（语音 16k 上行 32KB/s、回复 WAV 也就百 KB 级，云流量成本可忽略，代价是多一跳 RTT）。
- **长连接语义不变**：nginx 对该入口已配置 `proxy_buffering off` + `proxy_read_timeout 900s`，§7 的三层超时约定原样适用（实测 progress 行按 1s 节流逐行到达，无缓冲）。
- **语音前提**：账号需在 设置 → 语音配置 开启语音输入（生产 201 已于 2026-10-03 开启）；ASR 走千问(按量)通道。
- **运维**：隧道状态看 201 `systemctl status ecs-tunnel`；ECS 侧转发口 `127.0.0.1:18788`；架构与端口全景见 `docs/ECS-服务与端口清单-2026-10-03.md`。

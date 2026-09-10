## [ISSUE-052] 本地语音 ASR：默认千问 token-plan 报「千问识别失败：未返回识别文本」
- **类型**：Bug（语音识别 token-plan 通道响应字段读取错误 + 错误文案掩盖真因）｜**状态：已修复（2026-09-06，真实端点实测通过，未提交）**
- **现象**：本地环境（家长/孩子语音输入）语音识别一直失败，报错 `千问识别失败: 未返回识别文本`。本机 `data/shared/voice-config.json` 已确认 **默认 `provider: "qwen-tokenplan"`**（即默认走 token-plan 套餐通道）。
- **根因（已实测定位，本 issue 之前的"token-plan 套餐不含 ASR 模型"分析已证伪）**：
  - **重要订正**：截图（百炼个人版 Token Plan 支持模型清单）显示 `qwen-audio-3.0-asr-flash` **在** token-plan 套餐内（语音识别项）。我之前从 `server/src/worker/providers.ts:132` 的 `QWEN_TOKENPLAN_PROVIDER.models`（仅列 LLM 文本模型）推导"token-plan 不含 ASR"是错的——LLM 模型列表 ≠ 语音模型可用性。
  - **真正的根因是 token-plan 端点响应结构与按量 DashScope 不同**，`qwen.ts:86` 写死了按量字段路径：
    - 按量 DashScope ASR 响应：`output.output.sentence[0].text`（output 包 output、sentence 是数组）
    - **token-plan ASR 实测响应**（用本机 `qwen-tokenplan` key 真实请求）：
      ```json
      {"sentence":{"sentence_id":0,"begin_time":0,"end_time":null,"text":"","channel_id":0,"speaker_id":null,"sentence_end":false,"words":[]},
       "text":"","request_id":"b2d...","output":{"sentence":{"...同对象...":"","words":[],"sentence_end":false,"..."},"text":"","request_id":"b2d..."}}
      ```
      **只有一层 `output`、`sentence` 是单对象（不是数组）、且顶层还有同名 `sentence`/`text`/`request_id`。**
  - 代码读 `json?.output?.output?.sentence?.text`（`qwen.ts:86`）→ `output.output` 在 token-plan 响应里是 undefined → text 取到空 → **`throw new Error("千问识别失败: 未返回识别文本")`**。
  - 即"未返回识别文本"是**字段路径写死的掩盖结果**：请求实际成功（HTTP 200+真实响应），但代码不会读 token-plan 的字段，所以用户看不到识别文本。
  - **凭据配置是正确的**：voice-config.json 的 `qwen-tokenplan.apiKey=""`，但 `qwen.ts:42` 回退到 `loadQwenKeyFromAuth(true)` 读 `data/parents/86a84278-c8ae-415e-8fbc-6140b1b7c88e/auth.json` 的 `qwen-tokenplan.key`（已确认存在，`sk-sp-...` 前缀）。
- **次要问题**：
  1. 错误文案误导：`res.ok` 但无文本时未检查 `json.code`/`json.message`/`json.output?.code`，直接报"未返回识别文本"，排障时看不到真实响应结构差异。
  2. 回退失效：本机只配了 token-plan（qwen/mimo/mimo-tokenplan 的 apiKey 全空），"未返回识别文本"不命中"没有识别到语音"正则 → 进 errors 继续下一个候选，但其余候选也都"配置不完整" → 最终"所有语音服务均识别失败"，无可用通道。
- **排查/确认步骤**：
  1. ✅ 用真实 token-plan key + 真实请求体直连 `https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`，确认响应只有一层 `output` 且 `sentence` 是单对象（已做）。
  2. 同样用按量 dashscope key + 同样请求体直连 `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation`，对比响应——应得到双层 `output.output` + `sentence` 数组。
  3. 也可确认 `getAuthPath()` 指向 `data/parents/<id>/auth.json`、其中 token-plan key 存在（已做）。
- **修改入口**：
  - **主修（兼容 token-plan 响应结构）**：`electron/lib/voice/providers/qwen.ts:86` —— 文本提取按多路径兼容：
    ```ts
    // 兼容按量 DashScope（双层 output.output.sentence[].text）
    // 与 token-plan MaaS（单层 output.sentence.text，sentence 是对象）/ 顶层 text
    const text: unknown =
      (Array.isArray(json?.output?.output?.sentence) && json.output.output.sentence[0]?.text) ||
      (typeof json?.output?.sentence?.text === "string" ? json.output.sentence.text : undefined) ||
      (typeof json?.output?.text === "string" ? json.output.text : undefined) ||
      (typeof json?.text === "string" ? json.text : undefined);
    ```
    并在 `text` 为空时再读 `json.code`/`json.message`/`json.output?.code` 真因，避免再报"未返回识别文本"。
  - **错误透出**：`qwen.ts:76-90` 整体重写——`res.ok` 但 text 取不到时优先抛 `千问识别失败: [json.code] [json.message]` 或 `千问识别失败: HTTP {status} {message}`；保留"没有识别到语音"语义短路（不发起 fallback）。
  - **设置页验证**：调用 `transcribeAudio(wav, onlyProvider)` 时若响应字段路径命中 token-plan 单层结构，UI 应提示"识别成功"——已有 `onlyProvider` 流程，复测即可验证。
- **回归验证**：
  1. 本地默认 `qwen-tokenplan`、发 1 秒语音 → 不再"未返回识别文本"，能拿到识别文本。
  2. 把默认 provider 切 `qwen`（按量）→ 仍正常（按量字段路径在主修里保留兼容）。
  3. 故意发静音/超短音频 → 仍报"没有识别到语音"，不发起 fallback（语义短路保留）。
- **优先级**：高（本地语音输入完全不可用；修复面极小，仅 qwen.ts:86 一行+错误透出，不动配置/不依赖服务端）。
- **记录时间**：2026-09-05
- **✅ 修复落地（2026-09-06，改动全在 `electron/lib/voice/providers/qwen.ts`，本地单测+真实端点实测通过，未提交/未部署）**：
  - **主修 pickText 多路径**：兼容按量（`output.output.sentence[]`，sentence 数组）与 token-plan（`output.sentence` 单对象 / `output.text` / 顶层 `text` / `result.text`）。原 `json.output.output.sentence.text` 在 token-plan 单层响应里 undefined → 误报「未返回识别文本」。
  - **错误透出 pickError + isNoSpeech**：`!res.ok` 与「ok 但空文本」两分支都透出 `[code] message` 真因（不再笼统「未返回识别文本」）；静音短路判定 `isNoSpeech` 统一兼容 `NO_WORDS`/`no words`(空格)/`no speech`/中文提示。
  - **验证**：tsc 0 业务错；electron-vite build 过；新增 `test/qwen-asr.test.ts`（vitest mock fetch）6/6 PASS（按量双层、token-plan 单层 sentence 对象、token-plan 仅 output.text、ok 空文本带真因、ok 全空兜底 HTTP、静音 NO_WORDS 短路）；**真实 token-plan 端点 + 真实 key + 真实 16k 语音 wav 实测 20s 返回中文识别文本**（此前必报「未返回识别文本」）。
  - ⚠️ 未提交（并行会话 ISSUE-049/050 改动仍在工作树，勿与其混提交）。

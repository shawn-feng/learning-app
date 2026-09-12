# ISSUE-077｜DeepSeek 官方模型名变更，需同步调整（`deepseek-v4-flash`→`deepseek-flash`）

- **类型**：依赖/配置（外部 API 变更）
- **优先级**：中
- **记录时间**：2026-09-11
- **状态**：待实施（仅登记，未改动代码）
- **触发**：用户指出 DeepSeek 模型名变了，并附官方文档 https://api-docs.deepseek.com/zh-cn/

---

## 官方文档事实（已核实，2026-09-11 抓 api-docs.deepseek.com/zh-cn）

- **当前 chat/flash 模型 id = `deepseek-flash`**（文档明确要求「模型名请使用 `deepseek-flash`」）。
- **旧名 `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 已下线**：仍可调用，但对应模型已下线，请求由 **DeepSeek-V4.1-Flash** 提供服务，并按 **Flash 价格**计费（即旧名虽不报 404，但已不是原模型、计费口径也变了）。
- **`deepseek-v4-pro` 继续提供**：文档特别说明 2026-09-14 之后仍保留 V4 Pro API 调用，计费不变。
- `base_url` 不变：`https://api.deepseek.com`（OpenAI 兼容格式）。
- 思考参数 `thinking:{type:"enabled"}` + `reasoning_effort` 仍沿用，compat 层无需改。

## 代码现状（已定位）

项目有**两条 DeepSeek 通道**，需分别核对：

### ① 官方 `deepseek` 直连通道（SDK 内置）
- 模型清单来自 SDK：`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/providers/data/deepseek.json`
- 该文件 `openai-completions` 段当前注册两个模型：
  - `id:"deepseek-v4-flash"` name:"DeepSeek V4 Flash" ← **这是已下线的旧名，应改为 `deepseek-flash`**
  - `id:"deepseek-v4-pro"` name:"DeepSeek V4 Pro" ← 文档确认仍保留，可不动
- 入口：`src/pages/Settings.tsx` L18-25（「DeepSeek (官方直连)」独立 key 入口），`electron/lib/pi-runtime.ts` L404 `ALLOWED_MODEL_PROVIDERS` 含 `"deepseek"`。
- ⚠️ **该 json 在 node_modules 内**：直接改会被重装（npm install）覆盖，不能当真源。正确做法是**在自有运行时代码里覆盖/注册修正后的模型清单**（或等/锁 SDK 版本），需实施者定方案（见下「待确认项 1」）。

### ② 百炼 token-plan 通道（本项目自注册，走套餐 key）
- `electron/lib/pi-runtime.ts` `QWEN_DEEPSEEK_MODELS`（L95-129）注册：
  - `deepseek-v4-flash-0731`（百炼定点快照）
  - `deepseek-v4-pro`
  - `deepseek-v4-pro-0813`（百炼定点快照）
- `DEFAULT_MODEL`（L418）= `"deepseek-v4-flash-0731"`；`data/parents/*/app-settings.json` 中 `defaultModel:"qwen-tokenplan/deepseek-v4-flash-0731"`。
- 这些是**百炼（DashScope）平台的定点快照名**，与 DeepSeek 官方 API 的 `deepseek-v4-flash`→`deepseek-flash` 改名**未必同步**。代码注释（L92-94）已说明百炼无后缀别名于 2026-08-24 下线、只留定点快照。需**向百炼核实**这些快照名在 DeepSeek V4.1-Flash 上线后是否仍有效、是否也要改名（如 `deepseek-v4-flash-0731`→`deepseek-flash-<新快照>`）。

## 排查 / 修改入口（可直接执行）

1. **官方通道**：确认 SDK 是否支持在自有代码覆盖 provider 模型清单（参考本项目对 qwen 的处理——`pi-runtime.ts` 用 `QWEN_MODELS`/`QWEN_DEEPSEEK_MODELS` 在 `QWEN_PROVIDER`/`QWEN_TOKENPLAN_PROVIDER` 注册）。若支持，照同样方式给 `deepseek` provider 显式注册 `deepseek-flash`（并保留 `deepseek-v4-pro`），不再依赖 SDK 的过期 `deepseek-v4-flash`。
2. **百炼通道**：`pi-runtime.ts` L95-129 `QWEN_DEEPSEEK_MODELS` —— 核实后如有新快照名则更新；`deepseek-v4-pro`/`deepseek-v4-pro-0813` 视百炼口径定。
3. **默认值**：`pi-runtime.ts` L418 `DEFAULT_MODEL` 与 `data/parents/*/app-settings.json` 的 `defaultModel` 依赖百炼快照有效性，随 #2 结论调整。
4. **设置页**：`src/pages/Settings.tsx` 模型下拉随 #1/#2 自动更新；确认「DeepSeek (官方直连)」下不再出现下线的 `deepseek-v4-flash`。

## 期望行为

- 选「DeepSeek (官方直连)」时，可用模型为 `deepseek-flash`（当前主模型）+ `deepseek-v4-pro`，**不再列出已下线、会被静默路由到 V4.1-Flash 并按 Flash 计费的旧 `deepseek-v4-flash`**。
- 百炼套餐通道的 DeepSeek 快照名与百炼最新命名一致，默认模型可正常调用、不报错。
- 调用 `base_url` 与思考参数不变，仅模型 id 修正。

## 待确认项（留给实施者 / 用户拍板）

1. **官方通道修复路径**：node_modules 内 `deepseek.json` 不可直接改（重装即丢）。是否采用「自有代码覆盖注册 deepseek provider 模型清单」方案（同 qwen 做法）？需先确认 pi-ai SDK 是否暴露该覆盖接口；否则只能锁 SDK 版本或提交上游 PR。
2. **百炼快照是否同步改名**：DeepSeek 官方 `deepseek-v4-flash`→`deepseek-flash` 是官方 API 变更；百炼定点快照 `deepseek-v4-flash-0731` 是否对应变为新快照名，须经百炼模型列表核实（本项目代码无法自证）。
3. **`deepseek-v4-pro` 是否要补 `deepseek-pro` 之类新别名**：文档只确认 V4 Pro 继续，未提新名；维持 `deepseek-v4-pro` 即可，待百炼/官方进一步通知。

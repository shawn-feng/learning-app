# ISSUE-155：新增模型供应商「魔芋AI」客户端看不到——key 录入 UI 写死在客户端（PROVIDERS 数组），答案：现状确实要升级客户端，治本 = 供应商清单/keyHint 改服务端下发

- **类型**：架构 / 设计（模型供应商注册与发现机制；含实施方案）
- **问题**：服务端已经增加了「魔芋AI」模型供应商（`packages/agent-core/src/runtime/providers.ts:204-251`，OpenAI 兼容中转 `https://www.moyu.info/v1`，含 DeepSeek V4.1 Flash/GLM-5.3/GPT-4o 等模型），而客户端不能自动读取到——难道增加模型供应商，客户端要升级？
- **根因（已核实代码）**：
  - **模型「列表」本身是服务端动态下发的，不需要升级**：客户端 ModelSelector → `window.api.piGetModels()` → `GET /api/v1/models` → 服务端 `listProviderModels()`（routes/models.ts:84，读服务端编译进的 `PROVIDER_REGISTRATIONS`）→ 原样渲染（ModelSelector.tsx:25-40 按 provider 分组）。服务端发了魔芋，`GET /models` 就有魔芋——这一半链路是通的。
  - **卡点是「API key 录入 UI」写死在客户端**：`src/pages/Settings.tsx:26-35` 硬编码 `PROVIDERS` 数组（qwen/qwen-tokenplan/deepseek/**moyu**/openai/minimax/mimo/mimo-tokenplan，每行 name + keyHint）——设置页的 key 输入行、provider 切换都遍历这个数组。**现场装的客户端包构建于魔芋加入之前 → 设置页没有魔芋的 key 录入行 → 家长无处填魔芋令牌 → 没配 key → 模型列表里有也用不了**。
  - 所以答案：**现状确实是「要升级客户端」**——每加一个供应商 = 服务端发版（registry）+ 客户端发版（key UI 白名单），双端都要动。讽刺的是服务端 `/api/v1/models/settings`（routes/models.ts:146-164）**本来就是为此设计的**：它合并 `PROVIDER_REGISTRATIONS` 与 auth → 返回每个 provider 的 `hasKey`——但只回了 `provider + hasKey`，**没回 name/keyHint 等展示元数据**，客户端因此没法纯靠它渲染录入 UI，只好自己写死一份。
- **改造方向（治本：供应商目录服务端化，加供应商只发服务端）**：
  1. **`GET /models/settings` 补齐展示元数据**：响应里每个 provider 带 `name`、`keyHint`（PROVIDER_REGISTRATIONS 里现成有这些字段，透传即可）+ `hasKey`；
  2. **客户端 Settings.tsx 的 key 录入区改为渲染该接口**（删除本地 PROVIDERS 数组）：provider 标签行、key 输入行（placeholder=keyHint）、已配置态（hasKey ✓）全部由服务端驱动；
  3. **ModelSelector 不动**（已经动态）；`ALLOWED_MODEL_PROVIDERS` 白名单（服务端）如有过滤也由 registry 驱动，不另立清单；
  4. **兼容**：旧客户端仍用本地数组（只影响新供应商的 key 录入，旧供应商不受影响）——升级提示即可；web 前端（Settings 网页版同源）随服务端发版自动生效，天然无此问题；
  5. **顺带**：VisionSettings 的多模态过滤已按 `input` 字段动态（ipc-handlers.ts:1653 透传 input）——供应商目录服务端化后视觉模型同样自动出现。
- **回归**：现有 8 个供应商的 key 录入/hasKey 展示不变（数据源从本地数组换服务端接口，字段对齐）；ModelSelector 模型列表不受影响；多设备（web/桌面）配置态一致（服务端单一真源）；新增供应商端到端 = 服务端加 registry → 发版 → 客户端零改动可见可配。
- **优先级**：中（每次加供应商都要双端发版的持续性成本；本次魔芋已双端加完，治本可在下个版本收口）
- **记录时间**：2026-09-25

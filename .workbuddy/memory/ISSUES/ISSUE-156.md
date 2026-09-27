# ISSUE-156：孩子端「模型」弹框是死 UI——切换桩化后仍展示可选（选了白选、白等 2.5s 重试），去掉；附 201 孩子实际模型核查

- **类型**：UI / 清理（模型已是家长级配置，孩子端切换入口为遗留死桩）
- **背景**：agent 服务端化（ISSUE-081）后模型改为**家长级**（服务端 app_settings.defaultModel），`pi:switch_model` 变成无条件失败桩（`ipc-handlers.ts:1668-1671`「模型已改为家长级（服务端），请在设置页修改默认模型。」）；但孩子端边栏「模型」弹框（Learn.tsx:1369-1379，Bot 图标，ISSUE-026 范式）仍挂着 ModelSelector：能拉到模型列表（GET /models 动态下发）但**选了白选**——且 ModelSelector 的重试逻辑（本地 agent 时代遗留「Session 可能还没就绪」）会对死桩**每 500ms 重试 ×5**，孩子选完白等约 2.5s 才收到报错，且 `selected` 状态已变 → **UI 显示已选、实际模型没变**。
- **✅ 拍板（2026-09-27）**：直接去掉该 UI。
- **改动清单（半行量）**：
  1. `Learn.tsx`：删侧栏「模型」Bot 图标按钮 + `showModel` state + 模型弹框块（连「ModelSelector 必须常驻挂载」注释——本地 agent 时代遗留顾虑，桩化后无意义）；
  2. `ModelSelector.tsx` 整文件删除（唯一消费方是 Learn）；
  3. `preload.ts` 的 `piSwitchModel` + `ipc-handlers.ts` 的 `pi:switch_model` 死桩一并删。
- **⚠️ 必须保留（误删防线）**：`piGetModels`（**Settings.tsx 3 处 + VisionSettings 2 处在用**）、`piGetDefaultModel`（Settings.tsx）、`listModels`（server-agent-client.ts:445，服务 pi:get_models）。
- **回归**：家长设置页模型 key/默认模型选择不受影响；视觉设置多模态过滤不受影响（piGetModels 的 input 字段透传）；孩子端边栏少一图标（ISSUE-026 行收敛）；无孤儿 import/死代码（tsc + build 验证）。
- **关联核查：201 生产环境孩子 agent 实际用什么模型（2026-09-27 只读探针；同日用户质疑后二次核实修正表述）**：
  - **settings 表有两行 app_settings**：per-parent 行 `86a84278…:app_settings`（**权威，对孩子 agent 生效**）`defaultModel="moyu/DeepSeek-V4.1-flash"`（vision/programming=`mimo-tokenplan/mimo-v2.5`，即识图与编程 agent 用 mimo，**对话主模型不是 mimo**）；无前缀的全局行 `app_settings.defaultModel="mimo/mimo-v2.5"` 是**兜底缺省行**（家长未自配时的缺省），不代表任何家长实际在用；
  - **会话落盘实证**：珊珊（1f050a7f）与闻闻（09406c05）两孩子最新会话 jsonl 头部消息均 **`provider: "moyu", modelId: "DeepSeek-V4.1-flash"`**——与 per-parent defaultModel 一致（`pickWorkerModel`：优先本家长 app_settings.defaultModel，兜底 `qwen-tokenplan/deepseek-v4-flash-0731`；runtime/index.ts:56-71）；
  - **结论：201 两个孩子的 agent 当前都用魔芋 DeepSeek-V4.1-flash**；链路记忆：model-sync.ts 注释明示「改 defaultModel 对**已存在会话**永不生效（会话首次创建时解析一次）」——换模型后旧会话仍用旧模型，属已知设计。
- **优先级**：低（清理性质，改动极小）
- **记录时间**：2026-09-27

---

## 实施记录（2026-09-27）

- **Learn.tsx**：删侧栏「模型」Bot 图标按钮、`showModel` state、模型弹框块（连同「ModelSelector 必须常驻挂载」遗留注释）、`ModelSelector` import 与 lucide `Bot` import；ISSUE-156 留一行注释说明删除原因。
- **组件删除**：`src/components/ModelSelector.tsx` 整文件 `git rm`（唯一真实消费方是 Learn；Settings/web-shim 仅注释提及，已同步改写）。
- **死桩三层删除**：preload `piSwitchModel`、ipc `pi:switch_model` handler、web-shim models 域 `piSwitchModel`（各留一行 ISSUE-156 注释说明）。
- **误删防线核验**：`piGetModels`（Settings 3 处 + VisionSettings 2 处）、`piGetDefaultModel`（Settings）、`listModels`（server-agent-client.ts:445）全部未动。
- **验证**：根 tsc 仅剩既有 TS2318/TS2552 环境错（无新增）；`npm run build`（electron-vite）通过；web `npm run build` 通过；web-shim 覆盖测试通过（无孤儿 window.api 消费）。

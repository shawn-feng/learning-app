# [ISSUE-097] 家长 agent 调 parent_build_material 报「agent 模型未配置」，但家长设置里显示已配置

- **类型**：bug（配置读写分散在「本地 app-settings.json」与「服务端 app_settings」两处，导致显示与真实生效不一致）
- **优先级**：中
- **状态**：✅ 已解决（2026-09-14：链路核实自洽 + 清除分裂机制）
- **记录时间**：2026-09-14
- **标签**：`家长agent` `parent_build_material` `programming-agent` `app_settings` `app-settings.json` `配置分裂` `stale-build`

---

## 一、现象

家长在「家长设置 → 模型配置」里已选好「编程 agent 模型」，界面显示「当前已保存的编程 agent 模型：xxx/yyy」；但家长 agent 调 `parent_build_material` 报：

> 编程 agent 未配置模型：请到「设置 → 模型配置」选择「编程 agent 模型」后重试

## 二、排查结论（2026-09-14 实测，本地环境）

1. **报错触发点**唯一：`server/src/agent/programming-agent.ts` `getProgrammingSession`——服务端读到的 `<parentId>:app_settings` 里没有 `programmingModel` 字符串。
2. **当前源码三路同键**（核实）：设置页显示（`pi:get_programming_model` → `GET /models/settings`）、设置写入（`pi:set_programming_model` → `POST /models/app_settings`）、agent 读取（`readParentSettings`）全部收口服务端 `<parentId>:app_settings`，parentId 均来自同一 JWT。
3. **服务端实存数据**（`server/data/server.sqlite` settings 表）：
   - 主家长 `86a84278…:app_settings`：`programmingModel = "qwen-tokenplan/deepseek-v4-flash-0731"` ✅（2026-09-07 15:11 写入后未变）；
   - 另有 **一条无家长前缀的全局 `app_settings`**（非 tokenplan 旧值）——历史遗留，现行代码无任何读取方，无害；
   - 其余 16 个家长行只有 `materialsLimit`（无模型配置）。
4. **运行中服务端端到端验证**：用服务端 jwtSecret 铸诊断 token 调 `GET /models/settings`（设置页同款接口）→ 返回 `programmingModel` 与 agent 读的同一值。**当前环境链路健康，bug 在现行源码下不可复现** ⇒ 原「假设 A（旧构建走本地分支）」成立，属构建/状态滞后问题。

## 三、真正根因与隐患（本次修复点）

排查中发现一个**仍存在于源码里的覆盖机制**（假设 B 的现行版本）：

- `electron/lib/app-settings.ts` 的 `saveSettings`：任何本地保存（含改 `materialsLimit`）都会 `pushConfig("app_settings", 整个本地文件内容)`；
- 服务端 `/config/set` 对 `app_settings` 是**整键替换**（非合并）；
- ⇒ 本地文件里的过期/缺失模型字段会把服务端真源**整体覆盖**——只要某设备本地文件旧（无 programmingModel 或值过期），一次无关保存就能把服务端配置打没，随后 agent 报「未配置」而设置页（重新读服务端前/另一设备）仍显示旧值。与 ISSUE-075「整键覆盖」同一类事故形态。

## 四、修复（2026-09-14）

1. **`electron/lib/app-settings.ts` 重写**：本地文件只承载 `materialsLimit`（离线回退），**删除全部模型字段的本地读写函数**（`getDefaultModelKey`/`setProgrammingModelKey`/`setVisionModelKey` 等，全仓零调用方）；`setMaterialsLimit` 的服务端同步改走 `POST /models/app_settings` **合并端点**（只传 materialsLimit，绝不整键覆盖模型配置）。
2. **`electron/lib/config-sync.ts`**：`reconcileMissingSecrets` 移除 app_settings 模型字段补齐块（本地文件已无模型字段，防过期值补传），保留 auth 补齐。
3. **`server/src/agent/programming-agent.ts`**：「未配置」报错带诊断信息——附上所查的 parentId，一眼可辨「agent 读的家长」与「设置页登录家长」是否一致。
4. **`src/pages/Settings.tsx`**：更新过时注释（模型配置真源=服务端）。

## 五、验证

- 根 `tsc --noEmit` 通过（仅 5 条预存环境级错误）；server `tsc --noEmit` 通过；esbuild 构建通过（dist/server.cjs v0.4.0）。
- 端到端：`GET /models/settings` 实测返回 `programmingModel`（与 agent 同源）。
- **冒烟**（用户侧）：重启客户端+服务端 → 设置页确认编程 agent 模型 → 让家长 agent 调 `parent_build_material` 跑通；再改一次「资料保留数量」，确认编程模型配置仍在（不再被整键覆盖）。

## 六、关联

- ISSUE-020（编程 agent「未配置即报错不静默回退」设计原点）。
- ISSUE-075（同构事故：整键无作用域覆盖服务端数据）。
- ISSUE-093/095/096（服务端化迁移后暴露的联调/构建一致性问题家族）。

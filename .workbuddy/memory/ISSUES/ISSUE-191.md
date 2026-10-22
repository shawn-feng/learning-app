# ISSUE-191：录音音量阈值改为「每个孩子单独设置」+ 家长端聊天不做音量检测

- **类型**：需求 / 优化（ISSUE-183 / ISSUE-189 的延伸）
- **优先级**：中（同一阈值对不同设备/年龄的孩子不公平：麦克风灵敏的嫌严、设备差的永远不达标）
- **记录时间**：2026-10-22
- **用户原话**：「找一下语音音量检测的issue，我现在要优化一下这个功能，为每个孩子单独设置音量阈值。因为每个孩子的设备不一样，年龄也不一样。家长就不需要音量阈值检测。」
- **关联 issue**：**ISSUE-183**（`ISSUES/ISSUE-183.md`，考核朗读/背诵录音音量前置校验 + 家长可设阈值）、**ISSUE-189**（`ISSUES/ISSUE-189.md`，把音量检测扩到聊天语音输入/音频转写/考核全题型 + 孩子端「声音检测」弹框）。

## 背景与现状（改前）

- 阈值是**家长级一条线**：`assessment_config.minVolumeNorm`（AES 加密，默认 42≈-35dBFS，0=不校验），一个家长下所有孩子共用。
- 用到的三处：孩子端聊天（按住说话、音频附件转写）、考核 iframe（`GET /exam/config/:childId` 下发 `examRules.minVolumeNorm`）、服务端评测兜底（`/assessment/assess` 再算一次）。
- 家长端聊天与孩子端共用 `ChatWindow`，也走同一个 `useVolumeThreshold()`——家长自己说话录轻了会被当成「声音太小，不送识别」，并且录音时还显示孩子的达标线音量条。
- 实际使用中不同孩子设备麦克风灵敏度、年龄/说话音量差异很大，一条线无法同时适配（麦克风好的孩子 42 仍嫌严，设备差的孩子怎么大声都不过线）。

## 设计（2026-10-22 定案）

| 项 | 方案 |
|---|---|
| **存储** | 仍在该家长的 `assessment_config` 加密 JSON 内，新增 `minVolumeNormByChild: { [childId]: 0-100 }`（0 = 该孩子不校验）。原 `minVolumeNorm` 降为**默认线**：孩子没有单独设置时用它（新孩子 / 旧配置 / 未单独配置的孩子） |
| **解析优先级** | `minVolumeNormByChild[childId] ?? minVolumeNorm`；`childId` 为空 = 家长端上下文 → **不做音量检测（0）** |
| **设置入口** | 设置 → 发音评测 →「录音音量与朗读评分」区块（用户拍板）：保留「默认录音最低平均音量」滑条，下面按孩子逐行滑条（孩子名 + 值 + 「用默认」按钮） |
| **继承语义** | 没单独设置的孩子显示默认线并保持继承（不写显式值）；拖动滑条才写该孩子的覆盖；「用默认」= 提交 `null` 删除覆盖，回到默认线 |
| **兼容/保存** | 服务端 patch 采用**合并式**更新：只更新传入的 childId 条目，`null` 删除该条；旧客户端（0.1.32 及以前）保存配置时不带该字段 → 整表保留，不会被清空 |
| **家长端聊天** | `owner="parent"` 时：不做 ASR 前置音量拦截、不解码测音量、不显示录音实时音量条（家长不需要音量阈值检测） |
| **考核 / 服务端兜底** | 按当前孩子解析：`/exam/config/:childId` 的 `examRules.minVolumeNorm` 与 `/assessment/assess`（带 childId）都用该孩子的线；家长「测试评测」试音 childId 为空 → 不校验 |

## 实施（2026-10-22）

| 文件 | 改动 |
|---|---|
| `server/src/assessment/config.ts` | `AssessmentConfig` 新增 `minVolumeNormByChild`；`parseVolumeNormByChild` / `mergeVolumeNormByChild`（数值夹取 0-100、`null` 删除、非法丢弃）；`resolveMinVolumeNorm(cfg, childId)`（单独优先/默认线兜底）；load 解析旧配置、mask 原样回显、patch 合并式更新 |
| `server/src/assessment/index.ts` | 导出上述三个函数 |
| `server/src/routes/exam.ts` | `/exam/config/:childId` 的 `examRules.minVolumeNorm` 改 `resolveMinVolumeNorm(assessCfg, childId)` |
| `server/src/routes/assessment.ts` | 配置 POST 接收 `minVolumeNormByChild`；评测兜底按孩子取线；**childId 为空（家长试音）不校验** |
| `src/lib/audio-volume.ts` | 新增 `resolveVolumeThreshold(config, childId)`：与服务端同语义；无 childId → 0 |
| `src/hooks/useVolumeThreshold.ts` | 增加 `childId` 参数；按 childId 分键的 60s 缓存；无 childId 直接返回 0；用 `resolveVolumeThreshold` 解析 |
| `src/components/ChatWindow.tsx` | `useVolumeThreshold(isParent ? undefined : childId)`；家长端两个录音入口跳过音量测量/拦截；家长端不显示实时音量条 |
| `src/components/VolumeCheckModal.tsx` | 新增 `childId` 必填 prop，按孩子读达标线 |
| `src/pages/Learn.tsx` | 传 `childId={child.childId}` 给检测弹框 |
| `src/components/AssessmentSettings.tsx` | 「默认录音最低平均音量」+「每个孩子的录音阈值」逐孩子滑条（childList 拉孩子；「用默认」= null 删除覆盖）；保存/设为默认都提交 `minVolumeNormByChild`；文案注明家长端聊天不检测 |
| `test/issue191-per-child-volume.test.ts`（新增） | 13 例：解析/夹取/删除、解析优先级、加密落库往返、合并式更新（旧客户端不丢表）、客户端 `resolveVolumeThreshold`（无 childId=0）、接线守卫（考核/兜底/聊天/弹框/设置页/hook） |
| `test/issue183-volume-gate.test.ts` | 新增 4 例端到端：该孩子 60 时小声按 60 拦、该孩子 0 不拦、另一个孩子回退默认线、家长试音（childId 空）不拦 |
| `test/issue189-volume-gate.test.ts` | hook 断言改为 `resolveVolumeThreshold`（解析收口到纯函数） |
| `test/assessment-type-thres.test.ts` | `AssessmentConfig` fixture 补 `minVolumeNormByChild`，并断言打码回显保留 |

**未改**：阈值公式/门判定（`rmsToVolumeNorm` / `isVolumeTooLow` / `volumeVerdict`）与考核 iframe 逻辑不变；`recitePassDefault` 仍是家长级。

## 验收场景

1. 设置 → 发音评测：默认线 42；给珊珊单独设 60、闻闻设 30 → 保存后重新进入设置，两个滑条分别显示 60 / 30；
2. 珊珊聊天录到 50 分 → 被拦（需要 60）；闻闻录到 50 分 → 放行（需要 30）；
3. 新加一个孩子（没有单独设置）→ 自动使用默认线 42；
4. 点「用默认」再保存 → 该孩子回到跟随默认线（数据库里该 childId 条目被删除），之后改默认线对该孩子生效；
5. 考核：珊珊开考 → `examRules.minVolumeNorm=60`；闻闻开考 → 30；服务端兜底同值；
6. 家长端聊天：小声说话也正常送去识别，录音时不显示孩子的音量条/达标线；
7. 家长设置页「测试评测」：小声录也不被音量拦（只按评测凭证/服务报错）。

## 验证（2026-10-22）

- 定向回归 **40/40 全绿**：`issue191-per-child-volume` 13 例 + `issue183-volume-gate` 8 例（含新增 4 例）+ `issue189-volume-gate` 16 例 + `assessment-type-thres` 3 例。
- 类型：server `tsc --noEmit` 本次改动文件零错误（仅既有 token-usage/models/topic-package 三处类型债）；客户端用 server 侧 TS 5.9 复核，本次改动文件零错误（根 TS7 原生包在本机报全局 lib 缺失=环境问题）。
- 构建：`web` 生产构建通过（本机 `%TEMP%` ACL 问题需 `TEMP=<repo>/tmp/esbuild-tmp`，同 ISSUE-187/188/189 环境记录）。
- ⚠️ 未跑：真实麦克风端到端（需打包客户端后实测「同设备不同孩子阈值分别生效」与家长端不再拦截）。

## 待办 / 边界

- **需要部署**：服务端（配置模型 + 考核/评测兜底）+ 客户端重打包 + `web/dist` 换装。未部署 201。
- **旧客户端**（0.1.32 及以前）：聊天/附件转写仍按家长级默认线拦（读不到每孩子配置），但**考核 iframe 与服务端评测兜底已经按孩子生效**（服务端解析）；家长端旧客户端仍会显示音量条（新客户端才去掉）。
- 配置读取仍是 60s 模块级缓存（按 childId 分键）：家长改完设置，孩子端最迟 60s 后或重新打开检测弹框生效。
- 删除孩子后其 `minVolumeNormByChild` 条目不会被主动清理（无害；该 childId 不再出现）。
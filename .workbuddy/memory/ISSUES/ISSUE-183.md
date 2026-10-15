# ISSUE-183：考核朗读/背诵录音先校验平均音量（不达标=没答、要求重录，阈值家长可设）+ 阿里测评最终分改「各维度平均」

- **类型**：需求（考核体验 + 评分口径变更）
- **优先级**：中-高（直接针对"孩子声音小→评分失真"的真实痛点）
- **记录时间**：2026-10-13
- **用户原话**：「考核朗诵和背诵题目时，孩子录完音频后，先校验音频的音量。音量不达标，算这题没答，要求重新录。音量计算平均值，在家长页面里可以设置要求的音量平均值。这么做是让孩子大声朗读和背诵，减轻声音小导致的评分误差。同时，调用阿里发音测评的最终评分用所有维度的评分算平均值。」
- **✅ 已实施（2026-10-15）**：需求 A/B 全部落地（客户端 0.1.30 起 / **服务端 0.5.34 已于 2026-10-15 19:11 部署 201 并线上冒烟通过**），详见文末「实施记录」。

## 背景与现状（代码已核）

**录音链路**：考核页逐题录音（客户端 MediaRecorder，webm）→ 多段合并 WAV → 送服务端评测（阿里声希 SSECP，中文走 `cn.pred.score` 长文本、英文 `en.sent.score`）→ `toSpeechAssessment`（pron=score）→ 客户端 `pointGot=round(total/100×pointMax)`、`correct=total≥recitePass`（默认 90，ISSUE-119）。**当前录音后没有任何音量校验**——声音很小也会原样送评，声希对低音量音频的准确度/流利度打分失真（偏低且不稳定），孩子被误判。

**评分取法**：`server/src/assessment/providers/aliyun-ssecp.ts:175` — `score: Math.round(r.overall ?? r.pron ?? 0)`，即**直接采信阿里返回的 overall 综合分**；accuracy / fluency / integrity（完整度）三个维度分当前只是并列提取展示（`:175` 附近的归一化结构），**不参与最终分计算**。

## 需求 A：录音音量前置校验

| 项 | 设计 |
|---|---|
| 校验点 | **客户端录完即校**（每题录完、提交评分前）：AudioContext `decodeAudioData` 解码录音 → 计算全程 **平均音量**（RMS 均方根，换算 dBFS 或 0-100 归一分）；多段合并的在合并后整体算一次 |
| 不达标流程 | **该题视为没答、不送评分**：界面提示「声音太小啦，请大声一点再读一遍」→ 原地重录；重录通过才计分。**无次数限制，直到达标为止**（2026-10-13 用户定案）——不做"连续 N 次放行/计 0 分"的兜底逻辑 |
| **考核页音量可视化**（2026-10-13 补充） | 让孩子**知道自己差在哪**：① 录音中显示**实时音量条**（绿=达标区/黄=偏轻/红=太小，达标线画在条上）；② 录完显示**本次平均音量 + 与达标线的差距**（儿童友好文案：「声音刚刚好 ✓」／「还差一点点，再大声一些」／「太小了听不清，大声读」），配数值（0-100 归一分，不显示 dBFS 原始值）；③ 不达标重录界面保持音量条可见，孩子能对着调 |
| 阈值配置 | **家长设置页新增「考核录音最低平均音量」**：存家长级 `app_settings`（既有 `{parent_id}:{key}` 通道，`server/src/routes/config.ts:35`），**默认值待实测标定**（建议先按设备实测分布给 -35dBFS 档，再按真实孩子录音校准）；阈值=0 或关闭 = 不校验 |
| 生效范围 | 仅考核的朗读（speech_read）/背诵（speech_recite）题；日常聊天录音、ASR 转写不受影响 |
| 服务端兜底（可选） | 提交/评测前对合并 WAV 再算一次平均音量，低于阈值同样按未答处理并返回明确错误码（防客户端绕过/旧版本客户端） |

**注意**：webm(opus) 与 wav 的音量口径不同（opus 有编解码增益），校验统一在**解码后的 PCM** 上算，不要直接读容器电平；合并 WAV 链路复用 `electron/lib/voice/audio.ts` 既有解码工具。

## 需求 B：阿里测评最终分 = 各维度平均

- **改法**：`aliyun-ssecp.ts` 的 `score` 从 `overall ?? pron` 改为 **`mean(accuracy, fluency, integrity)`**（存在的维度取平均，四舍五入；三个都缺时才回退 overall，再缺回退 0）——不再单独采信阿里的综合分（其综合权重不可控，低音量下 overall 掉分不明显但维度分已经很难看，或反之）；
- **范围**：只改 aliyun-ssecp 提供商（当前实际在用的，家长已确认）；tencent-soe 兜底提供商同口径顺手对齐（SuggestedScore→维度平均）但不动它的维度集；
- **联动影响（要一并评估）**：`recitePass=90` 通过线现在作用在"维度平均分"上——平均分天然比"取信 overall"更严格/更宽松取决于阿里权重（integrity 低会显著拉低平均）；**上线后需观察 201 真实考核的分数分布，必要时调整通过线**；
- **recitePass 通过线家长可配（2026-10-13 拍板）**：家长设置页新增「朗读/背诵通过线」（默认 90，存家长级 `app_settings`；**题目自带通过线的以题目为准**，未设的用家长默认值）——分数漂移时家长可自行调整，不用改代码；
- 测试：`server/src/assessment` 既有 provider 测试补「维度平均」「维度缺失回退」两用例。

## 验收场景

1. 家长设置页可设置/关闭最低平均音量，保存后孩子端下次录音即生效；
2. 故意小声录 → 立即提示重录、该题不产生得分记录；**反复小声 → 反复提示重录，无次数上限**；大声重录 → 正常送评计分；
3. 交付的评分结果里，背诵题最终分 ≈ （准确度+流利度+完整度）/3（用 raw 原始响应对账）；
4. 家长修改「朗读/背诵通过线」→ 之后判分按新线执行（自带线的题目不受影响）；
5. 录音界面实时音量条随声音大小变化；录完显示平均音量+达标线对比，孩子能看出"还差多少"并据此调整；
4. 音量校验不影响聊天/ASR 链路；旧版客户端未升级时服务端兜底（若做）仍拦得住。

## 实施记录（2026-10-15）

**音量口径（两端同一公式，互为锚）**：解码后 PCM 全程 RMS → `norm = clamp(round((20·log10(rms)+60)×100/60), 0, 100)`（-60dBFS→0，0dBFS→100；-35dBFS→42）。服务端实现 `server/src/assessment/volume.ts` + `audio.ts wavAverageVolumeNorm`；客户端实现 `src/lib/exam-template.ts`（iframe 独立 HTML 无法 import，注释互指，**改公式必须两边同步**）。统一在解码后 PCM 上算（不读容器电平，opus/wav 口径差异消解）。

### 需求 A：录音音量前置校验
- **校验点（客户端）**：考核页口语/背诵题（questionType 非空）**每段录完即校**——`decodeAudioData` 解码整段 PCM 算平均音量；不达标该段**不入答案**（=没答）、原地重录，无次数上限；达标段才拼接（合并 RMS ≥ 各段最小值 ⇒ 送评音频必然达标）。文字题/聊天/ASR 链路零改动。
- **音量可视化**：录音中实时音量条（AudioContext+AnalyserNode，绿=达标/黄=偏轻/红=太小，达标线画在条上）；录完显示「本次音量 N（需要 M）」+ 儿童友好文案（声音刚刚好 ✓ / 还差一点点，再大声一些 / 太小了听不清，大声读）；口语题题干提示「读得太轻不算数」。
- **阈值配置**：家长设置页「发音评测」新增**「考核录音最低平均音量」**（滑条 0-100，0=不校验，默认 42≈-35dBFS 档，待真实孩子录音校准）+ **「朗读/背诵通过线」**（默认 90）。存家长级 `assessment_config`（AES 加密，`AssessmentConfig.minVolumeNorm/recitePassDefault`，随既有 assessmentConfigGet/Set 通道读写）。
- **生效链路**：`GET /exam/config` 随配置下发 `examRules{minVolumeNorm,recitePassDefault}` → ExamView 传给 `buildExamHtml(volumeRule)` + 判分用；每次开考新鲜读取，改设置下一场生效。
- **服务端兜底（已做）**：`POST /assessment/assess` 评测启用且阈值>0 时，评测前对合并音频整体再算一次平均音量，低于阈值 → **422 `{code:"VOLUME_TOO_LOW", volumeNorm, minVolumeNorm}`** 按未答拦下（拦旧版客户端/绕过）；评测未启用时不拦（保持原报错，兼容 issue143 语义）。

### 需求 B：最终分 = 各维度平均
- `aliyun-ssecp.ts`：`score = mean(accuracy, fluency, integrity)`（存在维度平均、四舍五入）；三维度全缺回退 `overall ?? pron`，再缺 0。`tencent-soe.ts` 同口径（Pron* 三维平均，回退 SuggestedScore），维度集不动。共用 `assessment/score.ts dimensionMeanScore`。
- **通过线语义**：题目/主题方法/排期 scope 自带 `recitePass` 以题目为准；**未带 = 0**（assess-selection/attachPlanQuestions 未设语义由硬编码 90 改 0）→ 客户端回退家长默认（examRules.recitePassDefault）→ 再兜底 90。旧客户端 `Number(0)||90` 行为不变。
- **联动影响**：维度平均分与原 overall 有漂移（integrity 低会拉低平均），`recitePass` 家长可自行调整，**上线后需观察 201 真实分数分布**。

### 测试与验证
- `test/issue183-dimension-mean.test.ts`（9 例）：维度平均/部分缺失/全缺回退（两 provider）+ 音量公式锚（-35dBFS→42、静音→0、WAV RMS）。
- `test/issue183-volume-gate.test.ts`（4 例）：真 fastify+sqlite+ffmpeg——小声 422 VOLUME_TOO_LOW（volumeNorm=18）/大声过音量关/阈值 0 关闭/未启用不拦。
- 相关回归 10 文件 58 例全绿（exam + issue112/115/121/135/143/150 + issue183×2）；全量 vitest 对照基线无新增失败；server tsc 零新增错误（既有 6 处类型债与本次无关）；server bundle / 客户端 electron-vite / web 三端构建通过；考核 iframe script `node --check` 通过。
- **待办**：客户端需打包发版（孩子端/家长端同包）；服务端部署 201 后用真实孩子录音校准默认阈值；观察维度平均分后的通过线分布。

### 201 部署记录（2026-10-15 19:11，server 0.5.34）
- 流程：`tmp/deploy/deploy_0534_issue183.py`（上传→备份 bundle bak-20261015-191124 + 数据 deploy-0.5.34-20261015-191124 85M→替换→重启）。
- 验证：version=0.5.34、VOLUME_TOO_LOW/minVolumeNorm/examRules/dimensionMeanScore 四标记在 bundle、health ok、journal 无 error。
- **线上冒烟**（`smoke_0534_issue183_v3.py`，自签家长 JWT）：配置默认值 42/90 → 阈值改 50 → 上传真实"安静"WAV（-49dBFS）→ `/assessment/assess` 返回 **422 `{code:"VOLUME_TOO_LOW", volumeNorm:18, minVolumeNorm:50}`**（journal 落 warn「录音平均音量低于阈值，按未答拦下」）→ 恢复 42/90 回读一致 → 真实考核计划 `exam/config?schedule=` 返回 `examRules{42,90}`。部署前状态（enabled=true/aliyun-ssecp）原样恢复，冒烟临时文件已清理。
- **下一场考核即生效（服务端兜底 + 通过线/音量阈值新口径）**；孩子端实时音量条与前置重录交互等客户端 0.1.30 打包发布。

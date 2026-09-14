# [ISSUE-093] 家长端发音评测「测试测评」结果展示错乱：总分 undefined、流利度 [object Object]

- **类型**：bug（前端字段映射与 `SpeechAssessment` 契约不一致）
- **优先级**：中
- **状态**：✅ 已解决（2026-09-14）
- **记录时间**：2026-09-14
- **解决摘要**：`AssessmentSettings.tsx` 的 `handleTest` 展示读错 `SpeechAssessment` 字段——`res.score`→`res.pron`（总分）、`res.fluency`→`res.fluency?.overall`（流利度数字）、`res.completeness`→`res.integrity`（完整度），并对缺失字段做防御（`?? "未返回"` / `?? 0`），消除 `undefined` / `[object Object]`。正式考核判分本就读 `pron`，不受影响。
- **标签**：`发音评测` `aliyun-ssecp` `AssessmentSettings` `SpeechAssessment` `字段映射`

---

## 一、现象（用户反馈）

家长端「设置 → 发音评测」配置阿里服务（声希 / 阿里少儿读词，provider=`aliyun-ssecp`）后，点「测试评测」（录 "hello" 上传评测），返回结果文案异常：

> 评测成功：总分 undefined 分，准确度 90，流利度 [object Object]（1 个词）

即三个异常：
1. **总分显示 `undefined`** —— 应为一个 0~100 的数字。
2. **流利度显示 `[object Object]`** —— 应为一个数字，却把整个对象直接插值成字符串。
3. 准确度 90、词数 1 个属正常（说明评测链路本身已跑通，仅展示层错）。

## 二、根因（已定位，精确）

**真正的评测结果对象形状由服务端 `toSpeechAssessment` 决定，前端读取的字段名与之不符。**

服务端契约（`electron/lib/exam.ts` 的 `SpeechAssessment`）：

```ts
interface SpeechAssessment {
  provider: "tencent-soe" | "aliyun-ssecp";
  overall?: number;
  pron: number;                 // ← 发音总分（踩分用），没有 score 字段
  accuracy?: number;
  integrity?: number;
  fluency?: { overall: number; pause?: number; speed?: number }; // ← 是对象，不是数字
  ...
}
```

- 服务端 `server/src/assessment/toSpeechAssessment.ts`：把总分放进 `pron`（`pron: r.score`），并把 `fluency` 包成对象 `{ overall: r.fluency }`。
- 考核判分 `speechPronToPoint(speech)` 也是读 `speech.pron` —— 即**权威总分段字段名是 `pron`**。

而前端测试展示代码 `src/components/AssessmentSettings.tsx` 的 `handleTest`（约 120–127 行）读的是：

```ts
`评测成功：总分 ${res.score} 分` +                       // ❌ 字段应为 res.pron
  (res.accuracy !== undefined ? `，准确度 ${res.accuracy}` : "") +
  (res.fluency !== undefined ? `，流利度 ${res.fluency}` : "") + // ❌ res.fluency 是对象 → "[object Object]"
  (res.completeness !== undefined ? `，完整度 ${res.completeness}` : "") +
  `（${res.words.length} 个词）`
```

对照现象完全吻合：
- `res.score` 在 `SpeechAssessment` 上不存在 → `undefined` → "总分 undefined 分"。
- `res.fluency` 是 `{overall}` 对象，模板字符串插值直接 toString → `[object Object]`。
- `res.accuracy` 命中（90）、`res.words.length` 命中（1），故这两者正常。

**结论**：评测与解析链路均正常，纯属测试展示 UI 读错了 `SpeechAssessment` 的字段名（总分应为 `pron`、流利度应读 `fluency.overall`）。

## 三、影响范围

- **家长**：在「设置 → 发音评测」点「测试评测」时看到错乱文案，误以为配置/评测失败，实际链路 OK。
- **不影响**：正式考核流程（判分走 `speechPronToPoint` 读 `pron`，字段一致，正常）。
- 仅 `aliyun-ssecp` 触发报告，但 `tencent-soe` 走同一 `toSpeechAssessment` 契约，同样会因 `res.score`/`res.fluency` 错读而显示异常（只是当前用户先用阿里服务复现）。

## 四、修复方向

改 `src/components/AssessmentSettings.tsx` 的 `handleTest` 展示逻辑，对齐 `SpeechAssessment` 真契约：

1. 总分：`res.score` → `res.pron`（或 `(res.pron ?? res.overall)`），消除 `undefined`。
2. 流利度：`res.fluency` → `res.fluency?.overall`，对象解成数字；同时完整度 `res.completeness` 字段名在 `SpeechAssessment` 上是 `integrity`，若也想展示应读 `res.integrity`。
3. 防御：对可能为 `undefined` 的数值做 `?? 0` 或保留"未返回"文案，避免再出现 `undefined`/`[object Object]`。
4. 验证：配置 `aliyun-ssecp` → 点测试评测 → 文案应为「总分 NN 分，准确度 NN，流利度 NN（1 个词）」；同理用 `tencent-soe` 回归一次。

## 五、关联

- 服务端映射真源：`server/src/assessment/toSpeechAssessment.ts`、`server/src/assessment/providers/aliyun-ssecp.ts`（`parseSsecpResult` 产出 `AssessmentResult`）。
- 契约定义：`electron/lib/exam.ts` 的 `SpeechAssessment` / `speechPronToPoint`（读 `pron`）。
- 测试入口链路：前端 `AssessmentSettings.tsx` `handleTest` → IPC `assessment:test`（`electron/lib/ipc-handlers.ts`）→ `POST /api/v1/assessment/assess`（`server/src/routes/assessment.ts`）→ `toSpeechAssessment`。
- 技术实现文档 `技术实现文档-功能实现与数据流转-2026-09-13.md` 发音评测相关章节（字段以 `pron`/`fluency.overall` 为准）。

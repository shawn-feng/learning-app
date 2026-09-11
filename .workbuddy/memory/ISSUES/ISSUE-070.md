## [ISSUE-070] 背诵/跟读题：一次录音后题目即被锁定（变「完成」），无法多段录音拼接

- **类型**：缺陷 / 考核（背诵题录音交互逻辑）
- **现象**：背诵（speech_recite，如 cn_recitation / cn_poem）与跟读（speech_read）类题目，孩子**按住说一遍、松手后**，本题立刻进入「已答完 / 🔒 不可修改」状态：麦克风按钮变灰禁用、进度点变绿（done）、页面显示「🔒 本题已答完，不可修改」。孩子无法再补录第二段，也不能把几段背的内容拼成完整一篇。
  - 这与设计预期相反：背诵应像口述题（ASR 路径）一样**可多次按住补充、多段拼接**，直到孩子点「下一题」才锁定。
- **根因**：`src/lib/exam-template.ts` 的 `startRec()` → `rec.onstop` 回调里，对口语题（`q.questionType` 为真）的处理分支在**第一段录音结束时**就置位锁定：
  - 约 L370-376：
    ```js
    if(qIndex(qid) === idx && !recA.locked){
      if(q.questionType){
        // 背诵/跟读题：无需 ASR，录完即存（提交时统一评测）
        if(!recA.answeredAt) recA.answeredAt = Date.now();
        if(recA.sec) recA.durationMs = recA.sec * 1000;
        recA.locked = true;   // ← 缺陷：第一段录完即锁定，阻断后续补录
        paintState();
      } else { ... } // 口述题不锁，等 ASR，可继续录
    }
    ```
  - 而「离开本题锁定」本应由 `saveCurrent()`（点「上一题/下一题」时调用）负责（L298-309：有内容则 `a.locked = true`）。口语题分支把这道锁**提前**到第一次录音结束，导致 `curLocked()` 立即为真、`setBtn()` 禁麦、`paintState()` 渲染锁定态、进度点 `done`。
  - 多段拼接能力本就具备（`segs.push(...)` 每次录音段 base64 入数组，提交时宿主合并），问题只是锁得太早让后续段无法录入。
- **影响范围**：所有「背诵 / 跟读 / 朗读」口语题（`questionType` 有值）的作答；口述主观题（无 `questionType`，走 ASR）不受影响，仍可多段拼接。背诵考核因此**无法按设计完成「分几段背、拼成完整一篇」**，孩子背错只能整题作废（实际无任何重录/删除入口，当前 in-app 版本已无 rerec 按钮）。
- **排查/修改入口**（均「可直接执行」）：
  - 核心：`src/lib/exam-template.ts`
    - `startRec()` → `rec.onstop` 的 `if(q.questionType){ ... recA.locked = true ... }`（约 L370-376）——**删除该分支里的 `recA.locked = true`**，改为与口述题一致：**只把本次段 push 进 `segs`、刷新 `recStatus`/导航，不锁**；锁定统一交给 `saveCurrent()`（点「下一题/上一题」时）。
    - `saveCurrent()`（L298-309）：确认其「有内容即锁定」逻辑对口语题同样正确（当前已实现，无需改）。
    - `curLocked()`（L168）/ `paintState()`（L191-206，`setBtn(locked ? "🔒 已答完" : ...)` 与 `lockTag` 渲染）：锁定态展示无需改，锁的时机改对即可自然正确。
    - `renderQuestion()` 背诵提示文案（约 L287-289，`qHint`）：补充「可多段录音，背错了只需再背一遍、不用删前面的录音」的明示提示。
  - 宿主合并/评测（仅确认，不属本次修复）：`src/components/ExamView.tsx` `handleSubmit`（约 L304）接收 `exam:submit` 后按 `perQuestion.audioB64s` 合并多段为单音频再做评测；`electron/lib/exam-engine.ts` 提交判分。多段拼接已支持，改对锁定时序即可生效。
- **期望行为（用户明确）**：
  1. 背诵/跟读题可**多次按住录音**，每段 `segs.push` 拼接成完整作答；
  2. 仅当孩子点「下一题」（或「上一题」切走）时 `saveCurrent()` 才锁定本题、之后不可再录/改；
  3. 背诵题页面需有提示：可多段录音；背错了只需再背一遍，**不需要删掉前面的录音**。
- **优先级**：中（功能缺陷：背诵考核核心流程不可用为设计意图；不影响口述题与跨平台录音权限）
- **记录时间**：2026-09-11

## 修复记录（2026-09-11）

- **根因确认**：与登记一致——`startRec()` → `rec.onstop` 的 `if(q.questionType)` 分支在**第一段录音结束时**即置 `recA.locked = true`，导致背诵/跟读题第一次录完即锁定，后续补录被 `curLocked()`/`setBtn()` 阻断。
- **改动文件**：`src/lib/exam-template.ts`（唯一改动点；`assets/exam-template.html` 仅为设计稿、不参与运行时，未改）
  1. 删除口语题分支里的提前锁定：去掉 `if(!recA.answeredAt) recA.answeredAt = Date.now();`、`if(recA.sec) recA.durationMs = recA.sec*1000;`、`recA.locked = true;` 三行；该分支改为只 `paintState()`，把本段 `segs.push` 后**不锁**，锁定统一交回 `saveCurrent()`（点「下一题/上一题」切走时）。
     - 顺带效果：计时器在 `!a.locked && !a.answeredAt` 时才累计本题用时，故多段录音期间总用时持续累计、不会因首段即置 answeredAt 而停表。
  2. 背诵/跟读提示文案（`renderQuestion()` 的 `qHint`）补充明示：**可分段录好几遍拼接；背/读错了只需再录一遍，不用删前面的录音**。
- **未改动**：`saveCurrent()`（L298 附近，有内容即锁定的逻辑对口语题本就正确）、`curLocked()`/`paintState()`（锁态展示无需改）、`ExamView.tsx` 的 `voiceMerge` 多段合并评测（已确认支持，非本次范围）。
- **验证**：
  - 提取内联脚本 `node --check` 语法校验通过（SYNTAX_EXIT=0）。
  - 宿主合并逻辑确认：`ExamView.tsx` L410-431 / L529-537 对 `segs.length>1` 调 `window.api.voiceMerge` 合并多段为单 WAV 再送 SSECP 评测——多段拼接能力已具备，改对锁定时序即生效。
  - 遗留 `rec.onstop` 的 `else` 分支（录音后已切走 → 立即锁定）保留，属防漏锁设计，不属缺陷。
- **状态**：✅ 已实施（待用户在 201 生产环境或本地实测一次多段背诵确认）

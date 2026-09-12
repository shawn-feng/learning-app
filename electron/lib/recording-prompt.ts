/**
 * recording 定时任务专用 prompt —— 客户端入口。
 *
 * 2026-09-12 P0：真源已上移到共享包 `packages/agent-core/src/prompts/recording-prompt.ts`，
 * 客户端与服务端（无头 worker）import 同一份，不再各存副本。
 * 原两端副本在合并时已发生漂移：客户端含「daily 标题禁止追加状态后缀」规则、服务端含
 * 「掌握度/首次学习传了会被拒绝」的显式说明——合并版取两者并集，见包内文件头注释。
 */
export { RECORDING_PROMPT, RECORDING_SYSTEM_PROMPT } from "../../packages/agent-core/src/prompts/recording-prompt";

/**
 * 客户端入口：learning-guard 扩展已上移到共享包（唯一真源）。
 * 保留本文件是为了不改动 electron 侧的既有 import（pi-session.ts 的 extensionFactories）。
 */
export { default } from "../../packages/agent-core/src/guard/learning-guard";

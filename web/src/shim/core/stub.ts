/**
 * Phase 1 stub 辅助：未实现的 window.api 方法统一在**调用时**抛错
 * （不能在组装对象时抛，否则 install 阶段就炸）。
 * 各域实现时删除对应条目即可；错误文案带方法名便于定位。
 */
export function todo(name: string): never {
  throw new Error(`[web-shim] 未实现: ${name}`);
}

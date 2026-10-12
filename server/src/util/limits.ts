/**
 * 上传/外发大小限制（ISSUE-151 用户拍板 2026-10-11，两类区分）：
 *
 * 1. **存储类**（app 客户端 → server 落盘：聊天附件 /files/upload、资料入库 /materials/upload、
 *    网盘 /fs/upload、主题包导入等）——局域网/本机传输，**不设限制**（multipart 全通道
 *    `fileSize: Infinity`，见 index.ts）；server→server 内部拷贝（如 transferUploadMaterial）同此。
 *
 * 2. **外发类**（server 收到后转发第三方：ASR 音频→DashScope/MiMo、评测音频→阿里云 SSECP、
 *    图片→视觉模型、聊天内联图→LLM）——**设限**：外发有带宽/耗时/第三方大小上限与费用，
 *    超限在入口就拒（413 + 可读文案），不把大 payload 转码/base64 完才在外发时失败。
 *
 * 改动限制值须同步 ISSUE-151 记录；护栏见 test/issue151-limits.test.ts。
 */

/** ASR 音频外发上限（DashScope / MiMo；MiMo 官方口径 ≤10MB base64 ≈ 7.5MB 原始，20MB 留足余量）。 */
export const ASR_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

/** 口语评测音频外发上限（阿里云儿童评测；跟读/背诵场景 20MB ≈ 10 分钟 16k wav）。 */
export const ASSESS_AUDIO_MAX_BYTES = 20 * 1024 * 1024;

/** 视觉模型图片外发上限（base64 解码后的原始字节；主流视觉 API 普遍 10MB 档）。 */
export const VISION_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** JSON body 全局上限（Fastify 默认 1MiB 是孩子聊天内联 base64 图片的隐藏坑；
 *  16MB ≈ 3~4 张手机原图 base64，覆盖外发兜底场景；存储类大文件一律走 multipart 不受限）。 */
export const JSON_BODY_LIMIT = 16 * 1024 * 1024;

/** 字节数的展示文案（错误信息用）。 */
export function bytesLabel(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round(n / (1024 * 1024))}MB` : `${Math.round(n / 1024)}KB`;
}

/**
 * 聊天附件标记（ISSUE-124）。
 *
 * 附件内容不进 prompt 正文，只发一条**可逆标记**给 agent：
 *   【附件图片：微信图片_xxx.jpg|<引用>】 / 【附件文件：作业.txt|<引用>】
 * agent 侧用 parent_read_image / parent_read_upload 读这个引用（见 server/src/agent/upload-ref.ts）。
 *
 * 引用从哪来：家长 agent 跑在服务端，服务端读不到家长本机 `data/parents/<pid>/uploads/` 的文件——
 * 所以主进程落盘后会顺带把附件上传到服务端 files 通道，返回 `ref`（`files/<id>`）。
 * 本模块把「用哪个引用」定成单一实现：**ref 优先，退回本机路径**（老主进程 / 上传失败时），
 * 两者都没有则「未保存」（与既有历史恢复逻辑兼容）。
 */

export interface AttachmentRefSource {
  /** 本机落盘的相对路径（相对 data/），用于本机打开/预览 */
  path?: string;
  /** 服务端可读引用（如 `files/<id>`），用于发给服务的 agent */
  ref?: string;
}

/** 发往 agent 的附件引用：ref 优先 → path 兜底 → 「未保存」。 */
export function attachmentRefFor(att?: AttachmentRefSource | null): string {
  const ref = String(att?.ref ?? "").trim();
  if (ref) return ref;
  const p = String(att?.path ?? "").trim();
  return p || "未保存";
}

export type AttachmentKind = "图片" | "文件" | "音频";

/** 组装附件标记；格式改动必须同步 `RESTORE_ATTACHMENT_RE`（历史恢复依赖它）。 */
export function attachmentMarker(kind: AttachmentKind, name: string, att?: AttachmentRefSource | null): string {
  return `【附件${kind}：${name}|${attachmentRefFor(att)}】`;
}

/** 历史消息里附件标记的解析正则（与 attachmentMarker 一一对应）。 */
export const RESTORE_ATTACHMENT_RE = /【附件(图片|文件|音频)：([^|】]*)\|([^】]*)】/g;

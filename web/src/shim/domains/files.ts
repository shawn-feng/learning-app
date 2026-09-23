/**
 * files 域（Phase 3 实现）：聊天上传文件的落盘/打开/读取（孩子与家长隔离）。
 *
 * Electron 原语义（ipc-handlers file:save_upload 等）：写本地 data/children|parents/<id>/uploads/，
 * 返回 {success, path(相对 data/ 的路径), size}；open/read 按路径定位文件。
 * Web 映射（服务端大文件通道 server/src/routes/files.ts）：
 *   - saveUpload/saveParentUpload → POST /files/upload（multipart，孩子上下文带 child_id 字段；
 *     家长上下文不带——服务端本就按 session parent_id 归属隔离）。返回的 path 用服务端
 *     files.id（uuid，渲染层与 Electron 版一样只当**不透明 token**回传给 open/read）。
 *   - openUpload/openParentUpload → window.open(GET /files/:id?token=)（浏览器新标签打开，
 *     由浏览器决定用何程序/预览呈现，等价 shell.openPath 的「交给系统处理」语义）。
 *   - readUpload/readParentUpload → GET /files/:id → ArrayBuffer → base64，返回
 *     {success, data}（对齐 file:read_upload 的 base64 载荷，历史消息播放录音用）。
 * 差异：Electron 端 pruneUploads 会清理过期 uploads；服务端无该逻辑（注释说明，不做）。
 * 签名逐条摘自 electron/preload.ts。
 */
import { http, httpBinary, apiUrl, getStoredToken } from "../core/server-fetch";

interface FileMeta {
  id: string;
  parent_id: string;
  child_id: string | null;
  original_name: string;
  mime: string;
  size: number;
  created_at: string;
}

/** ArrayBuffer → base64（分块转换避免 String.fromCharCode 爆栈）。 */
function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let bin = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(bin);
}

/** 通用上传：POST /files/upload，返回 {success, path(=files.id), ref(=files/<id>), size}（对齐 save_upload 返回面）。 */
async function uploadToFiles(
  childId: string | null,
  name: string,
  _mime: string,
  data: ArrayBuffer
): Promise<{ success: boolean; path?: string; ref?: string; size?: number; error?: string }> {
  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([data]),
      String(name || "file").replace(/[^\w.\-\u4e00-\u9fa5()]/g, "_").slice(0, 80) || "file"
    );
    if (childId) form.append("child_id", childId);
    const data2 = await http<{ file: FileMeta }>("/files/upload", { method: "POST", body: form });
    return {
      success: true,
      path: data2.file.id,
      ref: `files/${data2.file.id}`,
      size: Number(data2.file.size ?? data.byteLength),
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** GET /files/:id（:id = saveUpload 返回的 path token）→ {success, data(base64)}。 */
async function readFromFiles(relPath: string): Promise<{ success: boolean; data?: string; error?: string }> {
  try {
    const id = encodeURIComponent(String(relPath || "").trim());
    if (!id) return { success: false, error: "文件不存在（可能已被清理）" };
    const buf = await httpBinary(`/files/${id}`);
    return { success: true, data: arrayBufferToBase64(buf) };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

/** 新标签打开服务端文件（?token= 认证，浏览器标签无法带 Authorization 头）。 */
function openInNewTab(relPath: string): { success: boolean; error?: string } {
  const id = encodeURIComponent(String(relPath || "").trim());
  if (!id) return { success: false, error: "文件不存在（可能已被清理）" };
  const token = getStoredToken();
  const url = `${apiUrl(`/files/${id}`)}?token=${encodeURIComponent(token)}`;
  const win = window.open(url, "_blank");
  if (!win) return { success: false, error: "浏览器拦截了新标签打开，请允许弹窗后重试" };
  return { success: true };
}

export const filesDomain = {
  /** saveUpload: (childId, name, mime, data) => Promise<{ success; path?; size?; error? }>（POST /files/upload，child_id 关联） */
  saveUpload: (childId: string, name: string, mime: string, data: ArrayBuffer) =>
    uploadToFiles(childId, name, mime, data),

  /** openUpload: (childId, relPath) => Promise<{ success; error? }>（window.open /files/:id?token=） */
  openUpload: async (_childId: string, relPath: string): Promise<{ success: boolean; error?: string }> =>
    openInNewTab(relPath),

  /** readUpload: (childId, relPath) => Promise<{ success; data?(base64); error? }>（GET /files/:id → base64） */
  readUpload: async (_childId: string, relPath: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    readFromFiles(relPath),

  /** saveParentUpload: (parentId, name, mime, data) => Promise<{ success; path?; size?; error? }>（服务端按 session parent 隔离，与孩子 files 解耦） */
  saveParentUpload: (parentId: string, name: string, mime: string, data: ArrayBuffer) =>
    uploadToFiles(null, name, mime, data).then((r) => {
      void parentId; // Electron 版用于落盘目录隔离；服务端归属由 token 决定，参数仅保留签名兼容
      return r;
    }),

  /** openParentUpload: (parentId, relPath) => Promise<{ success; error? }>（同 openUpload） */
  openParentUpload: async (_parentId: string, relPath: string): Promise<{ success: boolean; error?: string }> =>
    openInNewTab(relPath),

  /** readParentUpload: (parentId, relPath) => Promise<{ success; data?(base64); error? }>（同 readUpload） */
  readParentUpload: async (_parentId: string, relPath: string): Promise<{ success: boolean; data?: string; error?: string }> =>
    readFromFiles(relPath),
};

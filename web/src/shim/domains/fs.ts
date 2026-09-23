/**
 * fs 域（ISSUE-131 P1）：文件区网盘（家长=materials/uploads/workspaces 整棵虚拟树；
 * 孩子=自己工作区）。映射服务端 server/src/routes/fs.ts：
 *   - list/mkdir/rename/move/delete/refs → POST /fs/*（JSON；needsConfirm 原样上浮给渲染层）；
 *   - upload → POST /fs/upload（multipart：file + path/overwrite/childId）；
 *   - downloadUrl → GET /fs/download?path=&childId=&token=（?token= 与 files/materials
 *     GET 二进制路由同一暴露面；Electron 版由 ipc fs:download_url 同构返回）。
 * 返回形状逐条对齐 electron/lib/ipc-handlers.ts 同名通道的 {success, ...} 包装。
 */
import { http, uploadMultipart, apiUrl, getStoredToken } from "../core/server-fetch";

export interface FsEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
  fileId?: string;
}

export interface FsRefHit {
  source: "course" | "display" | "exam_plan";
  detail: string;
}

function requireToken(): string | null {
  return getStoredToken() || null;
}

function childFields(childId?: string): Record<string, string> {
  return childId ? { childId } : {};
}

export const fsDomain = {
  /** fsList: ({path?, childId?}) => Promise<{success, path?, entries?}> */
  fsList: async (payload: { path?: string; childId?: string } = {}) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ path?: string; entries?: FsEntry[] }>("/fs/list", {
        method: "POST",
        body: { path: payload.path ?? "", childId: payload.childId || undefined },
      });
      return { success: true as const, path: data.path, entries: data.entries ?? [] };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsSearch: ({path?, query, childId?}) => Promise<{success, entries?, truncated?}>（当前目录范围内向下检索） */
  fsSearch: async (payload: { path?: string; query: string; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ entries?: FsEntry[]; truncated?: boolean }>("/fs/search", {
        method: "POST",
        body: { path: payload.path ?? "", query: payload.query ?? "", childId: payload.childId || undefined },
      });
      return { success: true as const, entries: data.entries ?? [], truncated: !!data.truncated };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsMkdir: ({path, name, childId?}) => Promise<{success, path?}> */
  fsMkdir: async (payload: { path: string; name: string; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ path: string }>("/fs/mkdir", {
        method: "POST",
        body: { path: payload.path, name: payload.name, childId: payload.childId || undefined },
      });
      return { success: true as const, path: data.path };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsRename: ({path, newName, confirm?, childId?}) => Promise<{success, path?} | {needsConfirm, refs}> */
  fsRename: async (payload: { path: string; newName: string; confirm?: boolean; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ path?: string; needsConfirm?: boolean; refs?: FsRefHit[] }>("/fs/rename", {
        method: "POST",
        body: {
          path: payload.path,
          newName: payload.newName,
          confirm: payload.confirm === true,
          childId: payload.childId || undefined,
        },
      });
      if (data.needsConfirm) return data;
      return { success: true as const, path: data.path };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsMove: ({from, toDir, confirm?, childId?}) => Promise<{success, path?} | {needsConfirm, refs}> */
  fsMove: async (payload: { from: string; toDir: string; confirm?: boolean; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ path?: string; needsConfirm?: boolean; refs?: FsRefHit[] }>("/fs/move", {
        method: "POST",
        body: {
          from: payload.from,
          toDir: payload.toDir,
          confirm: payload.confirm === true,
          childId: payload.childId || undefined,
        },
      });
      if (data.needsConfirm) return data;
      return { success: true as const, path: data.path };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsDelete: ({path, confirm?, childId?}) => Promise<{success} | {needsConfirm, refs}> */
  fsDelete: async (payload: { path: string; confirm?: boolean; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await http<{ ok?: boolean; needsConfirm?: boolean; refs?: FsRefHit[] }>("/fs/delete", {
        method: "POST",
        body: { path: payload.path, confirm: payload.confirm === true, childId: payload.childId || undefined },
      });
      if (data.needsConfirm) return data;
      return { success: true as const };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsRefs: ({path, childId?}) => Promise<{success, refs}>（R-1 引用影响预检） */
  fsRefs: async (payload: { path: string; childId?: string }) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录", refs: [] as FsRefHit[] };
      const data = await http<{ refs?: FsRefHit[] }>("/fs/refs", {
        method: "POST",
        body: { path: payload.path, childId: payload.childId || undefined },
      });
      return { success: true as const, refs: data.refs ?? [] };
    } catch (err) {
      return { success: false as const, error: (err as Error).message, refs: [] as FsRefHit[] };
    }
  },

  /** fsUpload: ({path, name, mime, data, overwrite?, childId?}) => Promise<{success, entry?}> */
  fsUpload: async (
    payload: { path: string; name: string; mime: string; data: ArrayBuffer; overwrite?: boolean; childId?: string }
  ) => {
    try {
      if (!requireToken()) return { success: false as const, error: "未登录" };
      const data = await uploadMultipart<{ entry?: FsEntry }>(
        // File（带原始文件名）而非裸 Blob：服务端 safeName/扩展名都取 part.filename
        "/fs/upload",
        new File([payload.data], payload.name || "file", {
          type: payload.mime || "application/octet-stream",
        }),
        {
          path: payload.path,
          overwrite: payload.overwrite ? "true" : "false",
          ...childFields(payload.childId),
        }
      );
      return { success: true as const, entry: data.entry };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },

  /** fsDownloadUrl: ({path, childId?}) => Promise<{success, url?}>（GET /fs/download + ?token=） */
  fsDownloadUrl: async (payload: { path: string; childId?: string }) => {
    try {
      const token = requireToken();
      if (!token) return { success: false as const, error: "未登录" };
      const qs = new URLSearchParams({ path: payload.path, token });
      if (payload.childId) qs.set("childId", payload.childId);
      return { success: true as const, url: `${apiUrl("/fs/download")}?${qs.toString()}` };
    } catch (err) {
      return { success: false as const, error: (err as Error).message };
    }
  },
};

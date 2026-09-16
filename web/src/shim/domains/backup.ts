/**
 * backup 域（Phase 3 实现）：服务端数据 zip 备份 / 恢复（ISSUE-003）。
 *
 * 对齐 electron/lib/ipc-handlers.ts 的 backup:* 通道：
 *   - backup:create：Electron 弹目录选择框 → 服务端 zip 落盘，返回 {success, file, count, bytes}。
 *     Web：浏览器无「选目录保存」语义 → GET /backup（zip 二进制）→ Blob → a[download] 触发
 *     浏览器下载（落用户下载目录）；file 取自 Content-Disposition 文件名，count 取 X-Backup-Count
 *     头，bytes 为实际字节数。返回结构逐字段对齐（无 canceled 分支——不弹框即无取消）。
 *   - backup:restore：Electron 弹 zip 选择框 → 上传覆盖服务端。Web：隐藏 <input type=file
 *     accept=.zip> 的 Promise 包装选文件 → POST /backup/restore（multipart）→ 服务端先自动
 *     备份当前数据再覆盖，返回 {ok, restored, skipped, preRestore} → 映射为
 *     {success, restored, skipped, preRestore}；用户取消选择 → {success:false, canceled:true}。
 *   - backup:config:get/set：Electron 数据源是**设备级本地** scheduler-config.json 的 backup 段
 *     （定时备份到本机目录——浏览器无此能力也无本机目录），Web 用等价的设备级存储 localStorage
 *     （web.backupConfig）存取同一结构 {enabled,hour,minute,destDir}（get/set 均直接返回配置对象，
 *     与 ipc 一致、无 {success} 封套；定时执行本身是桌面端能力，Web 仅保留配置读写）。
 * 签名逐条摘自 electron/preload.ts。
 */
import { http } from "../core/server-fetch";

const LS_KEY_BACKUP_CONFIG = "web.backupConfig";

/** 与 electron/lib/scheduler.ts SchedulerBackupConfig / DEFAULT_BACKUP_CONFIG 同构。 */
export interface WebBackupConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  destDir: string;
}

const DEFAULT_BACKUP_CONFIG: WebBackupConfig = { enabled: false, hour: 22, minute: 30, destDir: "" };

/**
 * 浏览器文件选择 Promise 包装（隐藏 <input type=file>；本域与 parent 域共用）。
 * 用户确认 → resolve(File[])；取消（cancel 事件或焦点恢复兜底）→ resolve([])。
 */
export function pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.style.display = "none";
    if (opts.accept) input.accept = opts.accept;
    if (opts.multiple) input.multiple = true;
    let settled = false;
    const finish = (files: File[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("focus", onFocus);
      input.remove();
      resolve(files);
    };
    // 用户确认选择
    input.addEventListener("change", () => finish(Array.from(input.files ?? [])));
    // 现代浏览器（Chrome 113+）取消选择会触发 cancel
    input.addEventListener("cancel", () => finish([]));
    // 兜底：部分浏览器/版本不派发 cancel——窗口焦点恢复后短暂延时仍未选择则视为取消
    const onFocus = () => setTimeout(() => finish([]), 500);
    window.addEventListener("focus", onFocus);
    document.body.appendChild(input);
    input.click();
  });
}

function backupTimestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export const backupDomain = {
  /** createBackup: () => Promise<{ success; file?; count?; bytes?; error? }>（GET /backup → blob → a[download]） */
  createBackup: async (): Promise<{ success: boolean; file?: string; count?: number; bytes?: number; error?: string }> => {
    try {
      // raw: 直接拿 Response（读下载文件名 / 备份条目数响应头）；非 2xx 已由 http() 翻译为异常
      const res = await http<Response>("/backup", { raw: true, timeoutMs: 120000 });
      const blob = await res.blob();
      const m = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
      const file = m?.[1] || `backup-${backupTimestamp()}.zip`;
      const count = Number(res.headers.get("X-Backup-Count") || 0);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return { success: true, file, count, bytes: blob.size };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** restoreBackup: () => Promise<{ success; restored?; skipped?; preRestore?; canceled?; error? }>（选 zip → POST /backup/restore） */
  restoreBackup: async (): Promise<{
    success: boolean;
    restored?: number;
    skipped?: string[];
    preRestore?: string;
    canceled?: boolean;
    error?: string;
  }> => {
    try {
      const [file] = await pickFiles({ accept: ".zip" });
      if (!file) return { success: false, canceled: true };
      const r = await http<{ ok: boolean; restored: number; skipped: string[]; preRestore: string }>(
        "/backup/restore",
        { method: "POST", body: ((): FormData => {
            const form = new FormData();
            form.append("file", file, file.name);
            return form;
          })(),
          timeoutMs: 120000 }
      );
      return { success: true, restored: r.restored, skipped: r.skipped ?? [], preRestore: r.preRestore };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },

  /** backupConfigGet: () => Promise<WebBackupConfig>（设备级 localStorage；结构与 ipc 直返一致） */
  backupConfigGet: (): WebBackupConfig => {
    try {
      const raw = localStorage.getItem(LS_KEY_BACKUP_CONFIG);
      if (!raw) return { ...DEFAULT_BACKUP_CONFIG };
      const b = JSON.parse(raw) as Partial<WebBackupConfig>;
      return {
        enabled: b.enabled ?? DEFAULT_BACKUP_CONFIG.enabled,
        hour: Number.isFinite(b.hour) ? Number(b.hour) : DEFAULT_BACKUP_CONFIG.hour,
        minute: Number.isFinite(b.minute) ? Number(b.minute) : DEFAULT_BACKUP_CONFIG.minute,
        destDir: typeof b.destDir === "string" ? b.destDir : "",
      };
    } catch {
      return { ...DEFAULT_BACKUP_CONFIG };
    }
  },

  /** backupConfigSet: (cfg) => Promise<WebBackupConfig>（整体替换 backup 段，返回保存后的配置） */
  backupConfigSet: (cfg: Partial<WebBackupConfig>): WebBackupConfig => {
    const saved: WebBackupConfig = {
      enabled: cfg.enabled ?? DEFAULT_BACKUP_CONFIG.enabled,
      hour: Number.isFinite(cfg.hour) ? Number(cfg.hour) : DEFAULT_BACKUP_CONFIG.hour,
      minute: Number.isFinite(cfg.minute) ? Number(cfg.minute) : DEFAULT_BACKUP_CONFIG.minute,
      destDir: typeof cfg.destDir === "string" ? cfg.destDir : "",
    };
    try {
      localStorage.setItem(LS_KEY_BACKUP_CONFIG, JSON.stringify(saved));
    } catch {
      /* 隐私模式/配额异常时静默（仅影响下次读回默认值） */
    }
    return saved;
  },
};

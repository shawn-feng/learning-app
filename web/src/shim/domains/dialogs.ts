/**
 * dialogs 域（Phase 2 实现）：
 *   - confirmDialog：Electron 用主进程 dialog.showMessageBox（防 Windows 模态焦点残留），
 *     返回 {confirmed}。Web 映射 window.confirm（浏览器原生模态，无焦点残留问题）；
 *     detail 无法单独展示 → 拼进正文（message + 空行 + detail），按钮文案浏览器固定
 *     （confirmLabel/cancelLabel 不生效，渲染层只消费 confirmed 布尔）。
 *   - pickDirectory：浏览器无目录选择语义。渲染层唯一消费点 BackupSettings.handlePickDir
 *     （`r && !r.canceled && r.path` 判空跳过）→ 返回 {canceled:true} 让 UI 保持默认，
 *     不抛错（对齐「调用方容错为准」）。
 */
export const dialogsDomain = {
  /** confirmDialog: (opts) => Promise<{ confirmed: boolean }>（dialog:confirm → window.confirm） */
  confirmDialog: async (opts: {
    title?: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
    cancelLabel?: string;
  }): Promise<{ confirmed: boolean }> => {
    const text = opts?.detail
      ? `${opts.message}\n\n${opts.detail}`
      : opts?.message || String(opts?.title || "确认");
    return { confirmed: window.confirm(text) };
  },

  /** pickDirectory: (title?) => Promise<{ canceled: true }>（浏览器不支持选择文件夹；调用方按取消处理） */
  pickDirectory: async (_title?: string): Promise<{ canceled: true }> => {
    return { canceled: true };
  },
};

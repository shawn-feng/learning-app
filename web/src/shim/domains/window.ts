/**
 * window 域（Phase 2 实现）：窗口控制 + Edit 菜单 + View 菜单。
 *
 * Web 语义（设计方案 §2 #12：窗口控制为浏览器天然能力，TitleBar web 分支隐藏窗口按钮）：
 *   - windowMinimize / windowMaximizeToggle / windowClose：浏览器页面无法控制宿主窗口
 *     （且 TitleBar 的 web 分支本就隐藏这些按钮）→ no-op resolve，保证菜单项可安全点击。
 *   - windowFullscreenToggle：唯一有真实浏览器等价物的项——document.documentElement
 *     的 Fullscreen API 切换（对齐 webContents.setFullScreen 语义）；失败静默 resolve。
 *   - windowIsMaximized / onWindowMaximized：浏览器无最大化概念，恒 false（Phase 1 已定），
 *     事件经 eventBus 派发（本域永不触发）。
 *   - Edit 菜单（edit:undo/redo/cut/copy/paste → webContents.undo/…）：映射
 *     document.execCommand，作用于当前聚焦的可编辑元素；paste 受浏览器权限限制，
 *     execCommand 失败时经 Clipboard API 读文本 + insertText 兜底（TitleBar 菜单不消费返回值）。
 *   - View 菜单：zoom 对齐 ipc view:zoom-in/out 的 webContents.setZoomLevel(±0.5) 语义
 *     （Electron zoomFactor = 1.2^zoomLevel，即每档约 ±9.5%，reset=0 → 1.0x），经
 *     document.body.style.zoom 应用；devtools 为浏览器 F12 能力，no-op。
 */
import { eventBus } from "../core/event-bus";

export const windowDomain = {
  /** windowMinimize: () => Promise<void>（浏览器不可控宿主窗口，no-op） */
  windowMinimize: async (): Promise<void> => {},

  /** windowMaximizeToggle: () => Promise<void>（浏览器不可控宿主窗口，no-op） */
  windowMaximizeToggle: async (): Promise<void> => {},

  /** windowClose: () => Promise<void>（浏览器不可控宿主窗口，no-op） */
  windowClose: async (): Promise<void> => {},

  /** windowIsMaximized: () => Promise<boolean>（浏览器无窗口最大化概念，恒 false） */
  windowIsMaximized: async (): Promise<boolean> => false,

  /** windowFullscreenToggle: () => Promise<void>（Fullscreen API 切换页面全屏；异常静默） */
  windowFullscreenToggle: async (): Promise<void> => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await document.documentElement.requestFullscreen();
      }
    } catch {
      // 浏览器策略拒绝（如无用户手势）时静默——与 ipc 通道「无返回值」的容错形态一致
    }
  },

  /** onWindowMaximized: (callback) => void（事件订阅，接入 eventBus；Web 恒不触发） */
  onWindowMaximized: (callback: (maximized: boolean) => void): void => {
    eventBus.on("window:maximized-changed", (m) => callback(!!m));
  },

  // ---- Edit 菜单（对齐 ipc edit:undo/redo/cut/copy/paste；作用于当前聚焦的可编辑元素） ----

  /** editUndo: () => Promise<boolean>（document.execCommand("undo")） */
  editUndo: async (): Promise<boolean> => document.execCommand("undo"),

  /** editRedo: () => Promise<boolean>（document.execCommand("redo")） */
  editRedo: async (): Promise<boolean> => document.execCommand("redo"),

  /** editCut: () => Promise<boolean>（document.execCommand("cut")） */
  editCut: async (): Promise<boolean> => document.execCommand("cut"),

  /** editCopy: () => Promise<boolean>（document.execCommand("copy")） */
  editCopy: async (): Promise<boolean> => document.execCommand("copy"),

  /** editPaste: () => Promise<boolean>（execCommand("paste") 被浏览器普遍禁用 → Clipboard API 读文本 + insertText 兜底；再失败静默返回 false，渲染层不消费返回值） */
  editPaste: async (): Promise<boolean> => {
    if (document.execCommand("paste")) return true;
    try {
      const text = await navigator.clipboard.readText();
      if (text) return document.execCommand("insertText", false, text);
    } catch {
      // 无剪贴板读权限（未授权/非聚焦可编辑元素）→ 静默
    }
    return false;
  },

  // ---- View 菜单（对齐 ipc view:devtools / view:zoom-in|out|reset） ----

  /** viewDevtools: () => Promise<void>（浏览器自带 F12 开发者工具，no-op） */
  viewDevtools: async (): Promise<void> => {},

  /** viewZoomIn: () => Promise<void>（对齐 setZoomLevel(+0.5)：zoomFactor = 1.2^level） */
  viewZoomIn: async (): Promise<void> => {
    applyZoomLevel(zoomLevel + 0.5);
  },

  /** viewZoomOut: () => Promise<void>（对齐 setZoomLevel(-0.5)） */
  viewZoomOut: async (): Promise<void> => {
    applyZoomLevel(zoomLevel - 0.5);
  },

  /** viewZoomReset: () => Promise<void>（对齐 setZoomLevel(0)：zoomFactor 回 1） */
  viewZoomReset: async (): Promise<void> => {
    applyZoomLevel(0);
  },
};

// ---------------------------------------------------------------------------
// Zoom（webContents.setZoomLevel 语义：zoomFactor = 1.2^level，档距 0.5 ≈ ±9.5%）
// ---------------------------------------------------------------------------

let zoomLevel = 0;

function applyZoomLevel(level: number): void {
  zoomLevel = Math.max(-6, Math.min(6, level)); // 0.2x ~ 3.0x，防溢出（Electron 同有内部上下限）
  const factor = Math.pow(1.2, zoomLevel);
  document.body.style.zoom = factor === 1 ? "" : String(factor);
}

/**
 * window 域（Phase 2 实现）：窗口控制；Edit/View 菜单通道已随 ISSUE-158 标题栏精简删除。
 *
 * Web 语义（设计方案 §2 #12：窗口控制为浏览器天然能力，TitleBar web 分支隐藏窗口按钮）：
 *   - windowMinimize / windowMaximizeToggle / windowClose：浏览器页面无法控制宿主窗口
 *     → no-op resolve（TitleBar web 分支本就隐藏这些按钮）。
 *   - windowFullscreenToggle：唯一有真实浏览器等价物的项——document.documentElement
 *     的 Fullscreen API 切换（对齐 webContents.setFullScreen 语义）；失败静默 resolve。
 *   - windowIsMaximized / onWindowMaximized：浏览器无最大化概念，恒 false（Phase 1 已定），
 *     事件经 eventBus 派发（本域永不触发）。
 *   - windowIsFullscreen / onWindowFullscreen（ISSUE-158）：Fullscreen API 的
 *     document.fullscreenElement 初值 + fullscreenchange 事件（全屏按钮图标态）。
 *   - （ISSUE-158：edit:* 走 document.execCommand 的通道与 view:zoom/devtools no-op 已删——
 *     标题栏菜单移除后无消费方；编辑快捷键由浏览器/Chromium 原生处理。）
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

  /** windowIsFullscreen: () => Promise<boolean>（document.fullscreenElement 初值） */
  windowIsFullscreen: async (): Promise<boolean> => !!document.fullscreenElement,

  /** onWindowFullscreen: (callback) => void（订阅浏览器 fullscreenchange 事件；Electron 走 preload 同名通道） */
  onWindowFullscreen: (callback: (fullscreen: boolean) => void): void => {
    const handler = () => callback(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", handler);
  },
};

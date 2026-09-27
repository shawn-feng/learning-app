import { useState, useEffect } from "react";
import { Minus, Square, Copy, X, Maximize, Minimize, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import IconButton from "./IconButton";

interface Props {
  /** ISSUE-158 续：家长中心模式在全屏右侧显示左/右栏折叠按钮（登录页/孩子端无面板可折叠，不显示） */
  panelToggles?: boolean;
}

/**
 * 自定义标题栏（双端共用：家长 Dashboard 与孩子 Learn 顶部）。
 *
 * ISSUE-158（2026-09-27）：原 File/Edit/View/Window 下拉菜单整组移除——
 * 窗口控制由右上三键承担；Edit 剪切/复制/粘贴/撤销快捷键由 Chromium 在可编辑区域原生处理；
 * 缩放/DevTools 属调试功能按拍板删除。原「全屏」项（View 菜单深处）提为左上角常驻按钮：
 * 图标随全屏态切换（window:is-fullscreen 初始态 + enter/leave-full-screen 推送）。
 *
 * ISSUE-158 续（用户反馈）：全屏右侧加两枚折叠按钮——左=折叠家长菜单侧栏、右=折叠家长聊天栏。
 * 面板折叠状态持有在 Dashboard（含 localStorage 持久化），经窗口 CustomEvent 解耦：
 * 标题栏发 `parent:toggle-left|right-sidebar` 切换请求，Dashboard 回报
 * `parent:sidebar-changed` / `parent:right-panel-changed`（detail.collapsed）供图标切换。
 */
export default function TitleBar({ panelToggles = false }: Props) {
  const [maximized, setMaximized] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  // Web 版（window.api.__web）：浏览器窗口无最小化/最大化/关闭控制权 → 隐藏右侧窗口按钮（保留标题）
  const isWeb = !!window.api?.__web;

  useEffect(() => {
    window.api.windowIsMaximized().then((m: boolean) => setMaximized(!!m));
    window.api.onWindowMaximized((m: boolean) => setMaximized(!!m));
    window.api.windowIsFullscreen().then((f: boolean) => setFullscreen(!!f));
    window.api.onWindowFullscreen((f: boolean) => setFullscreen(!!f));
  }, []);

  useEffect(() => {
    if (!panelToggles) return;
    const onLeft = (e: Event) => setLeftCollapsed(!!(e as CustomEvent).detail?.collapsed);
    const onRight = (e: Event) => setRightCollapsed(!!(e as CustomEvent).detail?.collapsed);
    window.addEventListener("parent:sidebar-changed", onLeft);
    window.addEventListener("parent:right-panel-changed", onRight);
    return () => {
      window.removeEventListener("parent:sidebar-changed", onLeft);
      window.removeEventListener("parent:right-panel-changed", onRight);
    };
  }, [panelToggles]);

  return (
    <div className="title-bar">
      <div className="title-bar-menus">
        <IconButton
          icon={fullscreen ? Minimize : Maximize}
          title={fullscreen ? "退出全屏" : "全屏"}
          size={14}
          className="tb-ctrl"
          onClick={() => window.api.windowFullscreenToggle()}
        />
        {panelToggles && (
          <>
            <IconButton
              icon={leftCollapsed ? PanelLeftOpen : PanelLeftClose}
              title={leftCollapsed ? "展开左侧菜单栏" : "折叠左侧菜单栏"}
              size={14}
              className="tb-ctrl"
              onClick={() => window.dispatchEvent(new CustomEvent("parent:toggle-left-sidebar"))}
            />
            <IconButton
              icon={rightCollapsed ? PanelRightOpen : PanelRightClose}
              title={rightCollapsed ? "展开右侧聊天栏" : "折叠右侧聊天栏"}
              size={14}
              className="tb-ctrl"
              onClick={() => window.dispatchEvent(new CustomEvent("parent:toggle-right-sidebar"))}
            />
          </>
        )}
      </div>

      <div className="title-bar-title">学习伙伴</div>

      {!isWeb && (
        <div className="title-bar-controls">
          <IconButton
            icon={Minus}
            title="最小化"
            size={14}
            className="tb-ctrl window-ctrl"
            onClick={() => window.api.windowMinimize()}
          />
          <IconButton
            icon={maximized ? Copy : Square}
            title={maximized ? "还原" : "最大化"}
            size={14}
            className="tb-ctrl window-ctrl"
            onClick={() => window.api.windowMaximizeToggle()}
          />
          <IconButton
            icon={X}
            title="关闭"
            size={14}
            className="tb-ctrl tb-close window-ctrl"
            onClick={() => window.api.windowClose()}
          />
        </div>
      )}
    </div>
  );
}

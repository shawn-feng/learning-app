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
 * ISSUE-158 续 + 孩子端同款（用户反馈）：全屏右侧两枚折叠按钮——左=折叠左侧栏、右=折叠右栏。
 * 仅在有面板可折叠的界面显示（panelToggles：家长中心 / 孩子学习页）。面板折叠状态持有在各页面
 * （localStorage 持久化），经窗口 CustomEvent 解耦：标题栏发 `ui:toggle-left|right-sidebar`
 * 切换请求，页面回报 `ui:left-sidebar-changed` / `ui:right-panel-changed`（detail.collapsed）供图标切换。
 * 两端「折叠」的终态不同：家长左侧栏折成 icon 条、孩子左侧图标条直接隐藏；右侧栏均为收起为窄条/不渲染。
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
    window.addEventListener("ui:left-sidebar-changed", onLeft);
    window.addEventListener("ui:right-panel-changed", onRight);
    return () => {
      window.removeEventListener("ui:left-sidebar-changed", onLeft);
      window.removeEventListener("ui:right-panel-changed", onRight);
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
              title={leftCollapsed ? "展开左侧栏" : "折叠左侧栏"}
              size={14}
              className="tb-ctrl"
              onClick={() => window.dispatchEvent(new CustomEvent("ui:toggle-left-sidebar"))}
            />
            <IconButton
              icon={rightCollapsed ? PanelRightOpen : PanelRightClose}
              title={rightCollapsed ? "展开右侧栏" : "折叠右侧栏"}
              size={14}
              className="tb-ctrl"
              onClick={() => window.dispatchEvent(new CustomEvent("ui:toggle-right-sidebar"))}
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

import { useState, useEffect, useRef } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import IconButton from "./IconButton";

interface MenuItem {
  label: string;
  action?: () => void;
  separator?: boolean;
}

interface Menu {
  label: string;
  items: MenuItem[];
}

const MENUS: Menu[] = [
  {
    label: "File",
    items: [{ label: "退出", action: () => window.api.windowClose() }],
  },
  {
    label: "Edit",
    items: [
      { label: "撤销", action: () => window.api.editUndo() },
      { label: "重做", action: () => window.api.editRedo() },
      { separator: true },
      { label: "剪切", action: () => window.api.editCut() },
      { label: "复制", action: () => window.api.editCopy() },
      { label: "粘贴", action: () => window.api.editPaste() },
    ],
  },
  {
    label: "View",
    items: [
      { label: "全屏", action: () => window.api.windowFullscreenToggle() },
      { separator: true },
      { label: "放大", action: () => window.api.viewZoomIn() },
      { label: "缩小", action: () => window.api.viewZoomOut() },
      { label: "重置缩放", action: () => window.api.viewZoomReset() },
      { separator: true },
      { label: "开发者工具", action: () => window.api.viewDevtools() },
    ],
  },
  {
    label: "Window",
    items: [
      { label: "最小化", action: () => window.api.windowMinimize() },
      { label: "最大化", action: () => window.api.windowMaximizeToggle() },
      { label: "关闭", action: () => window.api.windowClose() },
    ],
  },
];

export default function TitleBar() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.windowIsMaximized().then((m: boolean) => setMaximized(!!m));
    window.api.onWindowMaximized((m: boolean) => setMaximized(!!m));
  }, []);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function runItem(item: MenuItem) {
    setOpenMenu(null);
    item.action?.();
  }

  return (
    <div className="title-bar" ref={barRef}>
      <div className="title-bar-menus">
        {MENUS.map((menu) => (
          <div key={menu.label} className="tb-menu">
            <button
              className={`tb-menu-btn ${openMenu === menu.label ? "open" : ""}`}
              onClick={() => setOpenMenu(openMenu === menu.label ? null : menu.label)}
            >
              {menu.label}
            </button>
            {openMenu === menu.label && (
              <div className="tb-menu-dropdown">
                {menu.items.map((item, i) =>
                  item.separator ? (
                    <div key={i} className="tb-menu-sep" />
                  ) : (
                    <button key={i} className="tb-menu-item" onClick={() => runItem(item)}>
                      {item.label}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="title-bar-title">学习伙伴</div>

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
    </div>
  );
}

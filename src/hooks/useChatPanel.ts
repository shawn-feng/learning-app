import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 可折叠 + 可拖拽调宽的聊天面板控制（家长端 / 孩子端通用）。
 * - 折叠：collapsed=true 时面板收起为窄条（宽度由调用方给，如 44px）；
 * - 调宽：通过 startDrag（绑在面板左边缘的手柄上）拖拽改变宽度，范围 [minW, maxW]；
 * - 状态持久化到 localStorage（key 区分家长/孩子），刷新后保留。
 */
export function useChatPanel(key: string, defaultWidth = 380, minW = 280, maxW = 680) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(`chat:${key}:collapsed`) === "1";
    } catch {
      return false;
    }
  });
  const [width, setWidth] = useState(() => {
    try {
      const raw = parseInt(localStorage.getItem(`chat:${key}:width`) || "", 10);
      if (Number.isFinite(raw)) return Math.min(maxW, Math.max(minW, raw));
    } catch {
      /* 忽略 */
    }
    return defaultWidth;
  });

  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  useEffect(() => {
    try {
      localStorage.setItem(`chat:${key}:collapsed`, collapsed ? "1" : "0");
    } catch {
      /* 忽略 */
    }
  }, [key, collapsed]);

  useEffect(() => {
    try {
      localStorage.setItem(`chat:${key}:width`, String(width));
    } catch {
      /* 忽略 */
    }
  }, [key, width]);

  // 面板左边缘拖拽：向左拖变宽（宽度 = 起点宽度 - 横向位移），向右拖变窄
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthRef.current;
      const onMove = (ev: MouseEvent) => {
        const next = startW - (ev.clientX - startX);
        setWidth(Math.min(maxW, Math.max(minW, Math.round(next))));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [minW, maxW]
  );

  return { collapsed, setCollapsed, width, startDrag };
}

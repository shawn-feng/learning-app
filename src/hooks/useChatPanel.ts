import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 可折叠 + 可拖拽调宽的聊天面板控制（家长端 / 孩子端通用）。
 * - 折叠：collapsed=true 时面板收起为窄条（宽度由调用方给，如 44px）；
 * - 调宽：通过 startDrag（绑在面板左边缘的手柄上）拖拽改变宽度，范围 [minW, maxW]；
 * - 状态持久化到 localStorage（key 区分家长/孩子），刷新后保留。
 */
// ISSUE-035：取消 maxW 上限，面板可随意调宽；持久化（localStorage）现成，只需移除 clamp。
export function useChatPanel(key: string, defaultWidth = 380, minW = 280) {
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
      if (Number.isFinite(raw)) return Math.max(minW, raw);
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

  // 面板左边缘拖拽：向左拖变宽（宽度 = 起点宽度 - 横向位移），向右拖变窄。
  // ISSUE-024：改用 Pointer Events + setPointerCapture —— 孩子端中间展示区是 iframe（独立
  // document），旧实现用 window 级 mousemove/mouseup，鼠标拖到 iframe 上方松手时 mouseup
  // 落在子文档不冒泡回父 window → onUp 永不触发 → 拖拽卡住（"点一下进入、再点一下退出"）。
  // setPointerCapture 后即使指针移入 iframe，pointermove/pointerup 仍路由回手柄元素，松手即停。
  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      let captured = false;
      try {
        target.setPointerCapture(e.pointerId);
        captured = true;
      } catch {
        /* 个别环境捕获失败：退回 window 级监听（极少见） */
        captured = false;
      }
      const startX = e.clientX;
      const startW = widthRef.current;
      const onMove = (ev: PointerEvent) => {
        const next = startW - (ev.clientX - startX);
        setWidth(Math.max(minW, Math.round(next)));
      };
      const onUp = () => {
        if (captured) {
          try {
            target.releasePointerCapture(e.pointerId);
          } catch {
            /* 已释放则忽略 */
          }
          target.removeEventListener("pointermove", onMove);
          target.removeEventListener("pointerup", onUp);
          target.removeEventListener("pointercancel", onUp);
        } else {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onUp);
        }
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      if (captured) {
        target.addEventListener("pointermove", onMove);
        target.addEventListener("pointerup", onUp);
        target.addEventListener("pointercancel", onUp);
      } else {
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onUp);
      }
    },
    [minW]
  );

  return { collapsed, setCollapsed, width, startDrag };
}

/**
 * iframe 学习资料 ↔ AI agent 双向通讯 —— 渲染层桥核心。
 *
 * 职责：
 * 1. BRIDGE_SCRIPT：注入到资料 srcDoc 的桥脚本（运行在沙盒 iframe 内，捕获孩子互动、
 *    生成文本式 DOM 快照、执行下行受控指令），与父页面经 postMessage 通讯。
 * 2. injectBridge：把桥脚本拼接到课程 html（保证 <!DOCTYPE> 仍为文档首字符，不引入 quirks mode）。
 * 3. 协议类型 / EventThrottler / genRequestId：渲染层处理消息的纯函数工具。
 *
 * 安全边界：桥脚本只做 DOM 读取与白名单操作（click/scroll/input/read），
 * 无 eval / new Function / 任意代码执行；postMessage 双向均需校验来源与 requestId。
 */

// —— 协议常量 ——
export const PAGE_MSG_PREFIX = "page:";
export const PAGE_MSG_TYPES = ["page:event", "page:ready", "page:exec", "page:exec:result"] as const;

export type PageEventKind = "open" | "click" | "scroll" | "input" | "submit" | "pagehide";

/** iframe → 父页面：互动事件上报 */
export interface PageEvent {
  type: "page:event";
  kind: PageEventKind;
  seq: number;
  ts: number;
  /** 页面标题（open 时上报，便于 agent 知道孩子在看哪份资料） */
  title?: string;
  detail: {
    tag?: string;
    text?: string;
    index?: number;
    href?: string;
    pct?: number;
    type?: string;
    name?: string;
    value?: string;
    action?: string;
  };
}

/** iframe → 父页面：就绪握手（父页面据此才安全下发指令） */
export interface PageReadyEvent {
  type: "page:ready";
  seq: number;
  ts: number;
  title?: string;
}

/** iframe → 父页面：指令执行回执 */
export interface PageExecResultUplink {
  type: "page:exec:result";
  requestId: string;
  ok: boolean;
  error?: string;
  data?: unknown;
}

export type PageAction = "click" | "scroll" | "input" | "read";

/** 父页面 → iframe：下行指令参数（与桥脚本 execAction 一一对应） */
export interface PageExecParams {
  index?: number;
  text?: string;
  pct?: number;
  value?: string;
  maxDepth?: number;
  maxNodes?: number;
}

/** 父页面 → iframe：下行指令 */
export interface PageExecDownlink {
  type: "page:exec";
  requestId: string;
  action: PageAction;
  index?: number;
  text?: string;
  pct?: number;
  value?: string;
  maxDepth?: number;
  maxNodes?: number;
}

/** 渲染层暴露给 Learn 的命令式句柄 */
export interface MaterialsPanelHandle {
  exec(action: PageAction, params?: PageExecParams): Promise<PageExecResultUplink>;
}

/**
 * 桥脚本（注入 iframe srcDoc 的 <script> 内容）。
 *
 * 约束：IIFE、零依赖、无 eval / new Function / document.write、< ~7KB；
 * 不使用模板字符串/反引号（本常量自身是模板字符串，内部反引号需转义）。
 * 运行在 opaque origin 沙盒内：window.parent.postMessage 必须用 "*"。
 */
export const BRIDGE_SCRIPT = `(function () {
  "use strict";
  if (window.__piBridge) return;
  window.__piBridge = true;

  var seq = 0;
  function send(msg) {
    msg.seq = ++seq;
    msg.ts = Date.now();
    window.parent.postMessage(msg, "*");
  }

  // —— 元素索引：WeakMap 惰性分配，同一元素恒同索引（快照 i / 事件 index / 下行定位同源）——
  var indexMap = typeof WeakMap === "function" ? new WeakMap() : null;
  var idxCounter = 0;
  function idx(el) {
    if (!indexMap || !el) return -1;
    var v = indexMap.get(el);
    if (v !== undefined) return v;
    var n = ++idxCounter;
    indexMap.set(el, n);
    return n;
  }

  // —— 事件去重（轻量，渲染层还有一层兜底）——
  var lastAt = {};
  function throttled(key, windowMs) {
    var now = Date.now();
    var prev = lastAt[key] || 0;
    if (now - prev < windowMs) return false;
    lastAt[key] = now;
    return true;
  }
  var scrollTimer = 0;

  // —— 可交互元素定位（与快照遍历同一套跳过规则）——
  var SKIP_TAGS = { script: 1, style: 1, noscript: 1, svg: 1, iframe: 1, template: 1 };
  var INTERACTIVE_SEL = "a,button,[role=button],input,select,textarea,label,[onclick]";
  function elText(el) {
    var t = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    return t.slice(0, 120);
  }
  function findInteractive(el) {
    var cur = el;
    while (cur && cur !== document.body) {
      if (cur.matches && cur.matches(INTERACTIVE_SEL)) return cur;
      cur = cur.parentElement;
    }
    return el;
  }
  // 按文本找可交互元素（下行 click {text} 用）
  function findInteractiveByText(text) {
    var want = String(text || "").trim();
    if (!want) return null;
    var all = document.querySelectorAll(INTERACTIVE_SEL);
    for (var i = 0; i < all.length; i++) {
      var t = elText(all[i]);
      if (t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) return all[i];
    }
    return null;
  }
  // 按索引找元素（与快照 walk 同序：DFS、同跳过规则）
  function indexToEl(index, maxDepth, maxNodes) {
    var found = null;
    var visited = 0;
    function walk(node, depth) {
      if (found || visited >= maxNodes || depth > maxDepth) return;
      if (!node || node.nodeType !== 1) return;
      var el = node;
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (SKIP_TAGS[tag]) return;
      visited++;
      if (idx(el) === index) { found = el; return; }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    walk(document.body, 0);
    return found;
  }

  // —— 文本式 DOM 快照（read 指令 / 事件定位用同一遍历序）——
  function snapshot(opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 8;
    var maxNodes = opts.maxNodes || 500;
    var items = [];
    var truncated = false;
    function walk(node, depth) {
      if (items.length >= maxNodes) { truncated = true; return; }
      if (depth > maxDepth || !node || node.nodeType !== 1) return;
      var el = node;
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (SKIP_TAGS[tag]) return;
      var text = elText(el);
      if (text) {
        var item = { i: idx(el), tag: tag, text: text };
        var role = el.getAttribute && el.getAttribute("role");
        if (role) item.role = role;
        var href = el.getAttribute && el.getAttribute("href");
        if (href) item.href = href;
        items.push(item);
      }
      var kids = el.children;
      for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1);
    }
    walk(document.body, 0);
    return { items: items, truncated: truncated };
  }

  // —— 事件采集（全部捕获阶段，绝不 preventDefault / stopPropagation，不干扰课程脚本）——
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || t.nodeType !== 1) return;
    var el = findInteractive(t);
    var tag = el.tagName ? el.tagName.toLowerCase() : "";
    var text = elText(el);
    var key = "c:" + idx(el) + ":" + text;
    if (!throttled(key, 3000)) return;
    var d = { tag: tag, text: text, index: idx(el) };
    var href = el.getAttribute && el.getAttribute("href");
    if (href && href.indexOf("#") !== 0) d.href = href;
    send({ type: "page:event", kind: "click", detail: d });
  }, true);

  document.addEventListener("scroll", function () {
    if (scrollTimer) return;
    scrollTimer = setTimeout(function () {
      scrollTimer = 0;
      var se = document.scrollingElement || document.documentElement;
      if (!se) return;
      var max = se.scrollHeight - se.clientHeight;
      var pct = max > 0 ? Math.round((se.scrollTop / max) * 100) : 0;
      if (!throttled("scroll", 3000)) return;
      send({ type: "page:event", kind: "scroll", detail: { pct: pct } });
    }, 800);
  }, true);

  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    if (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA" && el.tagName !== "SELECT") return;
    var key = "ch:" + idx(el);
    if (!throttled(key, 3000)) return;
    var val = String(el.value || "").slice(0, 200);
    send({
      type: "page:event", kind: "input",
      detail: { type: (el.type || el.tagName.toLowerCase()), name: el.name || "", value: val, index: idx(el) }
    });
  }, true);

  document.addEventListener("submit", function (e) {
    var f = e.target;
    if (!f || f.tagName !== "FORM") return;
    var key = "sb:" + idx(f);
    if (!throttled(key, 3000)) return;
    send({ type: "page:event", kind: "submit", detail: { action: f.getAttribute("action") || "", index: idx(f) } });
  }, true);

  function reportPageHide() {
    if (!throttled("hide", 3000)) return;
    send({ type: "page:event", kind: "pagehide", detail: {} });
  }
  window.addEventListener("pagehide", reportPageHide);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") reportPageHide();
  });

  // —— 就绪握手 + 打开事件 ——
  function reportOpen() {
    if (window.__piReady) return;
    window.__piReady = true;
    var title = (document.title || "").trim().slice(0, 80);
    send({ type: "page:event", kind: "open", title: title || undefined, detail: {} });
    send({ type: "page:ready", title: title || undefined });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", reportOpen);
  } else {
    reportOpen();
  }

  // —— 下行指令执行（白名单：click / scroll / input / read，无任意代码）——
  function execAction(d) {
    var action = d.action;
    if (action === "read") {
      var snap = snapshot({ maxDepth: d.maxDepth, maxNodes: d.maxNodes });
      return { items: snap.items, truncated: snap.truncated };
    }
    if (action === "click") {
      var el = (typeof d.index === "number" && d.index >= 0) ? indexToEl(d.index, 12, 1000) : null;
      if (!el && d.text) el = findInteractiveByText(d.text);
      if (!el) throw new Error("未找到要点击的元素");
      el.click();
      return { clicked: true, index: idx(el) };
    }
    if (action === "scroll") {
      if (typeof d.pct === "number") {
        var se = document.scrollingElement || document.documentElement;
        var max = (se ? se.scrollHeight : 0) - (se ? se.clientHeight : 0);
        window.scrollTo(0, Math.round((Math.max(0, Math.min(100, d.pct)) / 100) * max));
        return { scrolledTo: d.pct + "%" };
      }
      if (typeof d.index === "number" && d.index >= 0) {
        var target = indexToEl(d.index, 12, 1000);
        if (!target) throw new Error("未找到要滚动的元素");
        target.scrollIntoView({ block: "center", behavior: "smooth" });
        return { scrolledToIndex: d.index };
      }
      throw new Error("scroll 需要 pct 或 index 参数");
    }
    if (action === "input") {
      if (typeof d.index !== "number" || typeof d.value !== "string") throw new Error("input 需要 index 与 value 参数");
      var input = indexToEl(d.index, 12, 1000);
      if (!input) throw new Error("未找到输入框");
      if (input.tagName !== "INPUT" && input.tagName !== "TEXTAREA" && input.tagName !== "SELECT") {
        throw new Error("目标元素不是输入控件");
      }
      input.value = d.value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return { filled: true, index: d.index };
    }
    throw new Error("未知操作: " + action);
  }

  window.addEventListener("message", function (e) {
    var d = e.data;
    if (!d || d.type !== "page:exec" || !d.requestId) return;
    try {
      var data = execAction(d);
      send({ type: "page:exec:result", requestId: d.requestId, ok: true, data: data });
    } catch (err) {
      send({ type: "page:exec:result", requestId: d.requestId, ok: false, error: String((err && err.message) || err) });
    }
  });
})();`;

/**
 * 把桥脚本注入课程 html，保证 <!DOCTYPE> 仍是文档首字符（避免 quirks mode 破坏课程 CSS）。
 * 注入优先级：<head> 后 → <!doctype> 后 → <html> 后 → 纯 fragment 前置。
 */
export function injectBridge(html: string): string {
  const script = `<script>${BRIDGE_SCRIPT}</script>`;

  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  const doctype = /^(\s*<!doctype[^>]*>)/i.exec(html);
  if (doctype) {
    return doctype[1] + script + html.slice(doctype[1].length);
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const at = root.index + root[0].length;
    return html.slice(0, at) + script + html.slice(at);
  }
  return script + html;
}

/**
 * 事件节流/去重纯函数：同 key 在 windowMs 窗口内只放行一次（滑动窗口）。
 * 用于渲染层对 iframe 上行事件的兜底过滤（桥脚本内已有轻量去重）。
 */
export class EventThrottler {
  private last = new Map<string, number>();

  shouldEmit(key: string, now: number, windowMs: number): boolean {
    const prev = this.last.get(key);
    // 首次（无记录）或距上次放行已过窗口 → 放行
    if (prev === undefined || now - prev >= windowMs) {
      this.last.set(key, now);
      return true;
    }
    return false;
  }

  reset(): void {
    this.last.clear();
  }
}

/** 生成下行指令 requestId（主进程 / 渲染层共用同一规则） */
export function genRequestId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

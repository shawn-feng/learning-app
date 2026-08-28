import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BRIDGE_SCRIPT,
  EventThrottler,
  genRequestId,
  injectBridge,
  PAGE_MSG_TYPES,
} from "../src/lib/page-bridge";
import {
  formatPageEvent,
  PageEventBuffer,
  queuePageEvent,
  recentInteractions,
  setSessionProvider,
} from "../electron/lib/page-bridge";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("injectBridge：桥脚本注入位置（不引入 quirks mode）", () => {
  it("<head> 存在 → 注入到 </head> 之前", () => {
    const html = "<!DOCTYPE html>\n<html><head><meta charset='utf-8'></head><body>hi</body></html>";
    const out = injectBridge(html);
    expect(out.startsWith("<!DOCTYPE html>")).toBe(true);
    const headEnd = out.indexOf("<script>");
    expect(headEnd).toBeGreaterThan(0);
    // script 在 </head> 之前
    expect(out.indexOf("</head>")).toBeGreaterThan(headEnd);
    expect(out).toContain("window.__piBridge");
  });

  it("无 <head> 但有 doctype → 紧跟 doctype 之后", () => {
    const html = "<!doctype html><html><body>x</body></html>";
    const out = injectBridge(html);
    expect(out.startsWith("<!doctype html><script>")).toBe(true);
  });

  it("前导空白 + doctype → script 插入 doctype 后、空白保留在首", () => {
    const html = "  \n<!DOCTYPE html><html><body>x</body></html>";
    const out = injectBridge(html);
    // doctype 前只允许空白（不引入 quirks mode）
    const dIdx = out.indexOf("<!DOCTYPE html>");
    expect(out.slice(0, dIdx)).toMatch(/^\s*$/);
    // script 紧跟 doctype 之后
    expect(out.slice(dIdx).startsWith("<!DOCTYPE html><script>")).toBe(true);
  });

  it("无 doctype 有 <html> → 注入到 <html> 标签后", () => {
    const html = "<html><body>x</body></html>";
    const out = injectBridge(html);
    expect(out.indexOf("<html><script>")).toBe(0);
  });

  it("纯 fragment → 直接前置", () => {
    const html = "<div>hello</div>";
    const out = injectBridge(html);
    expect(out.startsWith("<script>")).toBe(true);
    expect(out).toContain("<div>hello</div>");
  });

  it("空字符串 → 只有桥脚本", () => {
    expect(injectBridge("")).toBe(`<script>${BRIDGE_SCRIPT}</script>`);
  });
});

describe("BRIDGE_SCRIPT：桥脚本静态校验（安全 + 结构）", () => {
  it("以 IIFE 开头、含 postMessage、花括号配平", () => {
    const s = BRIDGE_SCRIPT.trim();
    expect(s.startsWith("(function () {")).toBe(true);
    expect(s.endsWith("})();")).toBe(true);
    expect(s).toContain("postMessage");
    // 花括号配平（忽略字符串内花括号的粗略校验，仅检查整体平衡）
    let depth = 0;
    for (const ch of s) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("无任意代码执行能力（eval / new Function / document.write）", () => {
    expect(BRIDGE_SCRIPT).not.toContain("eval(");
    expect(BRIDGE_SCRIPT).not.toContain("new Function");
    expect(BRIDGE_SCRIPT).not.toContain("document.write");
    expect(BRIDGE_SCRIPT).not.toContain("require(");
  });

  it("含四种白名单操作与协议消息类型", () => {
    for (const t of PAGE_MSG_TYPES) expect(BRIDGE_SCRIPT).toContain(t);
    expect(BRIDGE_SCRIPT).toContain('action === "click"');
    expect(BRIDGE_SCRIPT).toContain('action === "scroll"');
    expect(BRIDGE_SCRIPT).toContain('action === "input"');
    expect(BRIDGE_SCRIPT).toContain('action === "read"');
  });

  it("体积可控（< 12KB，超限提示优化）", () => {
    const kb = BRIDGE_SCRIPT.length / 1024;
    expect(kb).toBeLessThan(12);
  });
});

describe("EventThrottler：滑动窗口节流/去重", () => {
  it("同 key 在窗口内只放行一次", () => {
    const t = new EventThrottler();
    expect(t.shouldEmit("a", 1000, 3000)).toBe(true);
    expect(t.shouldEmit("a", 2000, 3000)).toBe(false);
    expect(t.shouldEmit("a", 3999, 3000)).toBe(false);
    expect(t.shouldEmit("a", 4000, 3000)).toBe(true);
  });

  it("不同 key 互不影响", () => {
    const t = new EventThrottler();
    expect(t.shouldEmit("a", 1000, 3000)).toBe(true);
    expect(t.shouldEmit("b", 1100, 3000)).toBe(true);
  });

  it("scroll 短窗口节流", () => {
    const t = new EventThrottler();
    expect(t.shouldEmit("scroll", 0, 800)).toBe(true);
    expect(t.shouldEmit("scroll", 700, 800)).toBe(false);
    expect(t.shouldEmit("scroll", 800, 800)).toBe(true);
  });

  it("reset 清空状态", () => {
    const t = new EventThrottler();
    t.shouldEmit("a", 0, 3000);
    t.reset();
    expect(t.shouldEmit("a", 1, 3000)).toBe(true);
  });
});

describe("PageEventBuffer：环形缓冲", () => {
  it("容量 50，溢出丢最旧", () => {
    const b = new PageEventBuffer(50);
    for (let i = 0; i < 60; i++) b.push(`e${i}`);
    expect(b.size).toBe(50);
    expect(b.recent(50)).not.toContain("e9"); // 最早的 e0..e9 已被丢弃
    expect(b.recent(50)).toContain("e59");
  });

  it("recent(n) 取最近 n 条合并；空缓冲返回 null", () => {
    const b = new PageEventBuffer(10);
    expect(b.recent()).toBeNull();
    b.push("a");
    b.push("b");
    expect(b.recent(1)).toBe("b");
    expect(b.recent(10)).toBe("a；b");
  });
});

describe("formatPageEvent：事件 → 自然语言", () => {
  it("open 带标题", () => {
    expect(formatPageEvent({ kind: "open", title: "论语学而篇第一章", detail: {} })).toBe("打开了资料「论语学而篇第一章」");
  });
  it("click 带文本与索引", () => {
    expect(formatPageEvent({ kind: "click", detail: { text: "下一步", index: 12 } })).toBe("点击了元素「下一步」(索引 12)");
  });
  it("scroll 带百分比", () => {
    expect(formatPageEvent({ kind: "scroll", detail: { pct: 45 } })).toBe("页面滚动至 45%");
  });
  it("input 带名称与值", () => {
    expect(formatPageEvent({ kind: "input", detail: { name: "answer", value: "苹果" } })).toBe("在输入框「answer」输入了内容，填入「苹果」");
  });
  it("submit / pagehide", () => {
    expect(formatPageEvent({ kind: "submit", detail: {} })).toBe("提交了表单");
    expect(formatPageEvent({ kind: "pagehide", detail: {} })).toBe("离开了资料页面");
  });
});

describe("queuePageEvent：批处理注入 + steer/followUp 选择", () => {
  it("600ms 窗口内多条事件合并为一次注入", () => {
    vi.useFakeTimers();
    const injected: string[] = [];
    setSessionProvider(() => ({
      isStreaming: true,
      steer: vi.fn(async (t: string) => injected.push(t)),
      followUp: vi.fn(async (t: string) => injected.push("F:" + t)),
    }));
    queuePageEvent("c1", { kind: "open", title: "第三课", detail: {} });
    queuePageEvent("c1", { kind: "click", detail: { text: "下一步", index: 5 } });
    queuePageEvent("c1", { kind: "scroll", detail: { pct: 50 } });
    expect(injected).toHaveLength(0);
    vi.advanceTimersByTime(700);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("[页面事件]");
    expect(injected[0]).toContain("打开了资料「第三课」");
    expect(injected[0]).toContain("点击了元素「下一步」(索引 5)");
    expect(injected[0]).toContain("滚动至 50%");
  });

  it("会话运行中走 steer，空闲走 followUp", () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setSessionProvider(() => ({
      isStreaming: false,
      steer: vi.fn(async (t: string) => calls.push("S:" + t)),
      followUp: vi.fn(async (t: string) => calls.push("F:" + t)),
    }));
    queuePageEvent("c2", { kind: "click", detail: { text: "开始" } });
    vi.advanceTimersByTime(700);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("F:");
  });

  it("会话未加载：事件入缓冲但不注入，page_inspect 可读", () => {
    vi.useFakeTimers();
    setSessionProvider(() => null);
    queuePageEvent("c3", { kind: "click", detail: { text: "卡片" } });
    vi.advanceTimersByTime(700);
    expect(recentInteractions("c3", 5)).toContain("点击了元素「卡片」");
  });
});

describe("genRequestId：唯一性", () => {
  it("多次生成不重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(genRequestId());
    expect(ids.size).toBe(1000);
  });
});

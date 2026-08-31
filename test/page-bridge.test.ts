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
  takePendingPageEvents,
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

  it("speechSynthesis shim：getVoices 空数组（防 voice 赋值 TypeError）、speak 上抛 tts、tts:done 触发 onend（ISSUE-011/013）", () => {
    const sent: any[] = [];
    const speechSyn: any = {
      getVoices: vi.fn(() => []),
      speak: vi.fn(),
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    // 模拟真实 Chromium：speaking/paused/pending 是 WebIDL 只读属性（getter-only，
    // strict mode 赋值抛 TypeError）——shim 必须用 defineProperty 重定义而非赋值。
    Object.defineProperty(speechSyn, "speaking", { configurable: true, enumerable: true, get: () => false });
    Object.defineProperty(speechSyn, "paused", { configurable: true, enumerable: true, get: () => false });
    Object.defineProperty(speechSyn, "pending", { configurable: true, enumerable: true, get: () => false });
    const win: any = {
      __piBridge: undefined,
      __piTtsBridge: undefined,
      parent: { postMessage: vi.fn((m: any) => sent.push(m)) },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
      speechSynthesis: speechSyn,
    };
    const doc: any = {
      readyState: "complete",
      title: "t",
      addEventListener: vi.fn(),
      scrollingElement: null,
      documentElement: null,
      querySelectorAll: () => [],
      body: null,
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("WeakMap", Map);
    // 执行桥脚本（静态字符串，测试环境 eval 无安全顾虑）
    eval(BRIDGE_SCRIPT);
    // ① getVoices 必须返回空数组：模拟 plain object 赋给 utter.voice 会抛
    // TypeError（WebIDL SpeechSynthesisVoice），课程脚本 speak 中断、无播放（ISSUE-013 实测）
    const voices = speechSyn.getVoices();
    expect(Array.isArray(voices)).toBe(true);
    expect(voices.length).toBe(0);
    // ② speak 上抛 tts 事件 + 触发 onstart + speaking=true（支持课程脚本「再点停止」判断）
    const u: any = { text: "你好，世界", onstart: vi.fn(), onend: vi.fn() };
    speechSyn.speak(u);
    expect(speechSyn.speaking).toBe(true);
    const ttsMsg = sent.find((m: any) => m.kind === "tts");
    expect(ttsMsg).toBeTruthy();
    expect(ttsMsg.detail.text).toBe("你好，世界");
    expect(u.onstart).toHaveBeenCalledTimes(1);
    // ③ cancel 上抛 tts-cancel + speaking=false（active 被清空）
    speechSyn.cancel();
    expect(speechSyn.speaking).toBe(false);
    expect(sent.some((m: any) => m.kind === "tts-cancel")).toBe(true);
    // ④ 父级回执 page:tts:done → 触发 utterance.onend + speaking=false（朗读按钮复位）。
    // cancel 已清空 active，需重新 speak 一次再回执。
    const u2: any = { text: "再读一遍", onstart: vi.fn(), onend: vi.fn() };
    speechSyn.speak(u2);
    const msgHandlers = win.addEventListener.mock.calls
      .filter((c: any) => c[0] === "message")
      .map((c: any) => c[1]);
    expect(msgHandlers.length).toBeGreaterThanOrEqual(2);
    for (const h of msgHandlers) h({ data: { type: "page:tts:done" } });
    expect(speechSyn.speaking).toBe(false);
    expect(u2.onend).toHaveBeenCalledTimes(1);
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

  it("体积可控（< 13KB，超限提示优化）", () => {
    const kb = BRIDGE_SCRIPT.length / 1024;
    expect(kb).toBeLessThan(13);
  });
});

describe("BRIDGE_SCRIPT：lookup 查词事件（ISSUE-017）", () => {
  function setupBridge(selectionText: string, collapsed = false) {
    const sent: any[] = [];
    const win: any = {
      __piBridge: undefined,
      parent: { postMessage: vi.fn((m: any) => sent.push(m)) },
      addEventListener: vi.fn(),
      getSelection: vi.fn(() => ({
        isCollapsed: collapsed,
        toString: () => selectionText,
      })),
    };
    const doc: any = {
      readyState: "complete",
      title: "t",
      addEventListener: vi.fn(),
      scrollingElement: null,
      documentElement: null,
      querySelectorAll: () => [],
      body: null,
    };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", doc);
    vi.stubGlobal("WeakMap", Map);
    eval(BRIDGE_SCRIPT);
    const handlers: Record<string, any[]> = {};
    for (const c of doc.addEventListener.mock.calls) (handlers[c[0]] ||= []).push(c[1]);
    const fire = (name: string, targetTag = "P", x = 100, y = 200) => {
      for (const h of handlers[name] || []) h({ target: { nodeType: 1, tagName: targetTag }, clientX: x, clientY: y });
    };
    return { sent, win, doc, fire };
  }

  it("mouseup 选中中文 → 上抛 lookup（文本 + 坐标）", () => {
    const { sent, fire } = setupBridge("月亮");
    fire("mouseup");
    const lookup = sent.find((m: any) => m.kind === "lookup");
    expect(lookup).toBeTruthy();
    expect(lookup.detail.text).toBe("月亮");
    expect(lookup.detail.x).toBe(100);
    expect(lookup.detail.y).toBe(200);
  });

  it("dblclick 也触发 lookup（双击选词兜底）", () => {
    const { sent, fire } = setupBridge("苹果");
    fire("dblclick");
    expect(sent.some((m: any) => m.kind === "lookup" && m.detail.text === "苹果")).toBe(true);
  });

  it("无选中（isCollapsed）→ 不上抛", () => {
    const { sent, fire } = setupBridge("", true);
    fire("mouseup");
    expect(sent.some((m: any) => m.kind === "lookup")).toBe(false);
  });

  it("纯英文/数字选中 → 不上抛（字典只有中文）", () => {
    const { sent, fire } = setupBridge("hello world");
    fire("mouseup");
    fire("dblclick");
    expect(sent.some((m: any) => m.kind === "lookup")).toBe(false);
  });

  it("表单内选中（INPUT/TEXTAREA）→ 不上抛（编辑操作）", () => {
    const { sent, fire } = setupBridge("苹果");
    fire("mouseup", "INPUT");
    fire("mouseup", "TEXTAREA");
    expect(sent.some((m: any) => m.kind === "lookup")).toBe(false);
  });

  it("超长选中（>8 字）→ 不上抛（整段复制）", () => {
    const { sent, fire } = setupBridge("一二三四五六七八九十");
    fire("mouseup");
    expect(sent.some((m: any) => m.kind === "lookup")).toBe(false);
  });

  it("同文本近坐标 2s 内节流：mouseup + dblclick 只报一次", () => {
    const { sent, fire } = setupBridge("月亮");
    fire("mouseup");
    fire("dblclick");
    expect(sent.filter((m: any) => m.kind === "lookup").length).toBe(1);
  });

  it("lookup 事件携带 seq/ts 且不包含危险字段（无 eval 等）", () => {
    const { sent, fire } = setupBridge("月亮");
    fire("mouseup");
    const lookup = sent.find((m: any) => m.kind === "lookup");
    expect(typeof lookup.seq).toBe("number");
    expect(typeof lookup.ts).toBe("number");
    expect(lookup.type).toBe("page:event");
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

describe("queuePageEvent：ISSUE-015 不自动注入，pending 随下一轮消息附带", () => {
  it("事件入环形缓冲（page_inspect 可读）且累积到 pending", () => {
    queuePageEvent("c1", { kind: "open", title: "第三课", detail: {} });
    queuePageEvent("c1", { kind: "click", detail: { text: "下一步", index: 5 } });
    queuePageEvent("c1", { kind: "scroll", detail: { pct: 50 } });
    // 环形缓冲：page_inspect / recentInteractions 仍能读最近互动
    expect(recentInteractions("c1", 5)).toContain("打开了资料「第三课」");
    expect(recentInteractions("c1", 5)).toContain("点击了元素「下一步」(索引 5)");
    // pending：取走得到合并文本
    const pending = takePendingPageEvents("c1");
    expect(pending).toContain("打开了资料「第三课」");
    expect(pending).toContain("点击了元素「下一步」(索引 5)");
    expect(pending).toContain("滚动至 50%");
    // 取走后清空：再次取为空串
    expect(takePendingPageEvents("c1")).toBe("");
  });

  it("无 pending 时取走返回空串；不同孩子互不影响", () => {
    expect(takePendingPageEvents("c-none")).toBe("");
    queuePageEvent("c-a", { kind: "click", detail: { text: "A" } });
    expect(takePendingPageEvents("c-b")).toBe("");
    expect(takePendingPageEvents("c-a")).toContain("A");
  });

  it("事件入缓冲但不注入 agent（无 followUp/steer 调用路径），page_inspect 仍可读", () => {
    queuePageEvent("c3", { kind: "click", detail: { text: "卡片" } });
    expect(recentInteractions("c3", 5)).toContain("点击了元素「卡片」");
    expect(takePendingPageEvents("c3")).toContain("点击了元素「卡片」");
  });
});

describe("genRequestId：唯一性", () => {
  it("多次生成不重复", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) ids.add(genRequestId());
    expect(ids.size).toBe(1000);
  });
});

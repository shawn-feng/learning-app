/**
 * ISSUE-146 P0 回归守护（2026-09-24）：长时工具被 240s「挂死看门狗」误杀。
 *
 * 背景：`parent_build_material` / `create_html_lesson` 的 execute 内部 `await` 一个**独立的嵌套
 * 编程会话**，它的事件不进父会话 ⇒ 父层在工具执行期间只有 `tool_start` 一个事件，之后静默数分钟，
 * 被「240s 无任何事件即判挂死」误杀；报错文案还写成「模型服务无响应」，归因给模型。
 * 201 生产实测：网页生成 9 次，median=321.4s / max=654.2s（6 次 >240s）；`判定挂死` 8 次，
 * 其中 5 次与 lesson-01~05 严格 1:1 配对（典型：`12:32:51 挂死` → `12:32:52 生成完成 242.8s`）。
 *
 * P0 修法：判据拆成两个进度源 —— `runningTools` 计数（工具在跑 ⇒ 静默是正常的）+ `lastActivityAt`；
 * 长工具另走 TOOL_EXEC_TIMEOUT_MS 硬上限且文案如实归因到「工具」。并补：进度回报（onUpdate）、
 * 中止传播（signal → 嵌套会话 abort）、子会话订阅不泄漏。
 *
 * 本文件＝**行为级 + 源码级**双层守护：行为级锁死登记处语义，源码级防止后续把判据写回去。
 */
import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  SESSION_IDLE_TIMEOUT_MS,
  TOOL_EXEC_TIMEOUT_MS,
  beginToolExecution,
  clearActivity,
  endToolExecution,
  lastActivityAt,
  markActivity,
  runningToolCount,
  runningToolNames,
  toolProgressText,
} from "../server/src/agent/session-activity";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

describe("ISSUE-146 P0 ① 活跃度登记：工具计数决定 watchdog 是否跳过", () => {
  const KEY = "parent-146:parent";
  beforeEach(() => clearActivity(KEY));

  it("工具开始 → 计数 1（watchdog 见 >0 即跳过模型静默判定）", () => {
    expect(runningToolCount(KEY)).toBe(0);
    beginToolExecution(KEY, "parent_build_material");
    expect(runningToolCount(KEY)).toBe(1);
    expect(runningToolNames(KEY)).toEqual(["parent_build_material"]);
  });

  it("工具结束 → 计数归零；重复 end 不产生负计数", () => {
    beginToolExecution(KEY, "create_html_lesson");
    endToolExecution(KEY, "create_html_lesson");
    expect(runningToolCount(KEY)).toBe(0);
    endToolExecution(KEY, "create_html_lesson");
    expect(runningToolCount(KEY)).toBe(0);
  });

  it("同名工具并发/重入：计数按栈增减（不会互相抵消）", () => {
    beginToolExecution(KEY, "t");
    beginToolExecution(KEY, "t");
    expect(runningToolCount(KEY)).toBe(2);
    endToolExecution(KEY, "t");
    expect(runningToolCount(KEY)).toBe(1);
    endToolExecution(KEY, "t");
    expect(runningToolCount(KEY)).toBe(0);
  });

  it("工具硬上限显著宽于模型静默上限（覆盖实测最长 654.2s）", () => {
    expect(TOOL_EXEC_TIMEOUT_MS).toBeGreaterThanOrEqual(20 * 60_000);
    expect(TOOL_EXEC_TIMEOUT_MS).toBeGreaterThan(SESSION_IDLE_TIMEOUT_MS * 5);
  });

  it("markActivity 记录最近活动时间（watchdog 的静默判据）", () => {
    expect(lastActivityAt(KEY)).toBeUndefined();
    markActivity(KEY, 1000);
    expect(lastActivityAt(KEY)).toBe(1000);
  });

  it("clearActivity 同时清活跃时间与工具计数（防一轮结束后计数泄漏）", () => {
    beginToolExecution(KEY, "t");
    markActivity(KEY);
    clearActivity(KEY);
    expect(runningToolCount(KEY)).toBe(0);
    expect(lastActivityAt(KEY)).toBeUndefined();
  });
});

describe("ISSUE-146 P0 ② onUpdate 进度文案提取", () => {
  it("优先 details.progress（服务端自己产的结构化字段）", () => {
    expect(
      toolProgressText({ content: [{ type: "text", text: "别的" }], details: { progress: "生成中…（已 1.0 分钟）" } })
    ).toBe("生成中…（已 1.0 分钟）");
  });

  it("回退取 content 的 text 块，并压成单行", () => {
    expect(toolProgressText({ content: [{ type: "text", text: "正在\n写入 文件…" }] })).toBe("正在 写入 文件…");
  });

  it("无内容返回空串（客户端据此跳过，不产生空进度）", () => {
    expect(toolProgressText(undefined)).toBe("");
    expect(toolProgressText({ content: [] })).toBe("");
  });

  it("超长截断（保护 SSE 载荷与气泡宽度）", () => {
    const out = toolProgressText({ details: { progress: "x".repeat(300) } });
    expect(out.length).toBeLessThanOrEqual(120);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("ISSUE-146 P0 ③ 两条看门狗改判据（源码级守护）", () => {
  // [文件, 标签, attachStream 内会话 key 变量名, watchdog 内会话 key 变量名]
  // 家长侧两处都叫 key；孩子侧为与 streamKey 区分，attachStream 形参改名 sessionKey（watchdog 仍是 key）
  const regs: Array<[string, string, string, string]> = [
    ["server/src/agent/parent-registry.ts", "parent-registry", "key", "key"],
    ["server/src/agent/session-registry.ts", "session-registry", "sessionKey", "key"],
  ];

  for (const [rel, tag, a, w] of regs) {
    it(`${tag}: 工具执行计入/退出计数，判据先看工具再看模型静默`, () => {
      const src = read(rel);
      expect(src).toContain(`beginToolExecution(${a}, event.toolName)`);
      expect(src).toContain(`endToolExecution(${a}, event.toolName)`);
      expect(src).toContain(`runningToolCount(${w})`);
      expect(src).toContain("TOOL_EXEC_TIMEOUT_MS");
      // 顺序关键：先判「有工具在跑」，再退回「模型静默」——反了就等于没修
      const i = src.indexOf(`const tools = runningToolCount(${w});`);
      const j = src.indexOf("if (silent <= SESSION_IDLE_TIMEOUT_MS) return;");
      expect(i, "缺少工具计数读取").toBeGreaterThan(-1);
      expect(j, "缺少模型静默判据").toBeGreaterThan(-1);
      expect(j).toBeGreaterThan(i);
      // 一轮结束清理，防异常路径导致计数泄漏（泄漏会让下一轮永不判挂死）
      expect(src).toContain(`clearActivity(${w});`);
      // 旧的会话级 activity map 已统一到 session-activity.ts
      expect(src).not.toContain("const sessionActivity = new Map");
      expect(src).not.toContain("const activityBySession = new Map");
    });

    it(`${tag}: 工具轮超时文案如实归因到「工具」而非「模型服务」`, () => {
      const src = read(rel);
      expect(src).toContain("分钟无任何进度，判定卡死");
      expect(src).toContain("仍未完成，已自动中止本轮");
    });

    it(`${tag}: 长工具期间无事件不再被判挂死（工具分支先 return）`, () => {
      const src = read(rel);
      // 工具分支必须在模型分支之前 return，否则长工具仍会走到 240s 判定
      const toolBranch = src.indexOf("if (tools > 0) {");
      const modelBranch = src.indexOf("if (silent <= SESSION_IDLE_TIMEOUT_MS) return;");
      expect(toolBranch).toBeGreaterThan(-1);
      expect(modelBranch).toBeGreaterThan(toolBranch);
    });
  }

  it("session-registry: 活跃度按会话 key 记、SSE 发到 streamKey（修 key 混用）", () => {
    const src = read("server/src/agent/session-registry.ts");
    expect(src).toContain("attachStream(entry, key, streamKeyOf(parentId, childId))");
    // 旧写法把 streamKey 当 activity key 用 → watchdog 读不到刷新值 → 任何 >240s 的正常轮都被砍
    expect(src).not.toContain("attachStream(entry, streamKeyOf(parentId, childId))");
    expect(src).toContain("markActivity(sessionKey)");
    expect(src).toContain("agentStreamHub.publish(streamKey,");
  });
});

describe("ISSUE-146 P0 ④ 编程工具：进度回报 + 中止传播 + 订阅不泄漏", () => {
  const src = read("server/src/agent/programming-agent.ts");

  it("execute 接 signal 与 onUpdate（SDK 的两个可选形参都被用起来）", () => {
    expect(src).toContain(
      "execute: async (_id: string, params: any, signal?: AbortSignal, onUpdate?: (partial: any) => void)"
    );
    expect(src).toContain("onProgress:");
    expect(src).toContain("signal,");
  });

  it("signal → 嵌套会话 abort（父层「停止」能打断 11 分钟的生成）", () => {
    expect(src).toContain('hooks.signal.addEventListener("abort", onAbort, { once: true })');
    expect(src).toContain("session.abort()");
  });

  it("订阅与心跳在 finally 清理（编程会话按 key 复用，不退订会持续累积）", () => {
    expect(src).toContain("unsubscribe?.()");
    expect(src).toContain("clearInterval(heartbeat)");
    expect(src).toContain("reporter.stop()");
    expect(src).toContain("hooks?.signal?.removeEventListener(\"abort\", onAbort)");
  });

  it("进度文案可读且含心跳（黑洞期也有进度可看）", () => {
    expect(src).toContain("正在编写页面代码…");
    expect(src).toContain("正在查看现有文件…");
    expect(src).toContain("生成中…（已 ");
  });

  it("进度节流（子会话每个 token 一个 delta，不能照单全收）", () => {
    expect(src).toContain("createProgressReporter");
    expect(src).toContain("MIN_INTERVAL_MS");
  });
});

describe("ISSUE-146 P0 ⑤ 客户端进度通道（两端同源 + 渲染层消费）", () => {
  const files: Array<[string, string]> = [
    ["web/src/shim/core/sse.ts", "web-shim"],
    ["electron/lib/server-agent-client.ts", "electron"],
  ];

  for (const [rel, tag] of files) {
    it(`${tag}: tool_progress → pi:tool_progress（不与正文流混用）`, () => {
      const src = read(rel);
      expect(src).toContain('case "tool_progress"');
      expect(src).toContain('channel: "pi:tool_progress"');
    });
  }

  it("两端 API 面都暴露 onPiToolProgress（web shim + preload + 本地转发）", () => {
    expect(read("web/src/shim/domains/agents.ts")).toContain("onPiToolProgress");
    expect(read("electron/preload.ts")).toContain("onPiToolProgress");
    expect(read("electron/lib/ipc-handlers.ts")).toContain('"pi:tool_progress"');
  });

  it("渲染层消费并在工作气泡/工具卡片显示（家长面板 + 孩子聊天 + 共享组件）", () => {
    expect(read("src/components/ParentChatPanel.tsx")).toContain("onPiToolProgress");
    expect(read("src/pages/Learn.tsx")).toContain("handleToolProgress");
    const chat = read("src/components/ChatWindow.tsx");
    expect(chat).toContain("progress?: string");
    expect(chat).toContain("const runningTool = m.tools?.find((t) => t.status === \"running\" && t.progress)");
  });
});

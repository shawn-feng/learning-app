/**
 * ISSUE-145 回归守护（2026-09-24）：两类「服务端正常、客户端却坏事」的缺口。
 *
 * 背景：家长 web 端出现「一直等待模型返回」+「刷新/重进看不到任何历史消息」两个症状，
 * 201 只读诊断（会话 jsonl / SSE 回放探针 / ss -ti 心跳比对 / 全天请求日志）证明
 * **服务端与模型完全正常**，缺口都在客户端：
 *  ① 送达链路**静默停摆**：连接没断、心跳照到（TCP 全 ACK），但 JS 一条事件都没消费，
 *     而旧实现只在 `done`/`throw` 时重连 → 永不重连 → 永久「等待模型返回」。
 *  ② 历史**从未被请求**：web shim 的 piStartParent/piStartParentContent 直接把 history
 *     写死成 `[]`（误以为"历史由服务端事件推送驱动"）→ 服务端 `/parent-agent/open`
 *     全天零调用（日志实证），刷新后家长端永远空白。
 *
 * 本文件是**源码级守护**（与 test/web-shim-coverage.test.ts 同风格）：断言"修复不能被写回去"。
 * 行为级验证口径见 ISSUE-145：`lastEventId=1` 回放探针应拿到 turn_end；open 应返回 messages>0。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf-8");

/** 取对象方法体：从 `<name>: async (` 起，到下一个两格缩进的 `},` 为止。 */
function methodBody(src: string, name: string): string {
  const start = src.indexOf(`${name}: async`);
  expect(start, `${name} 未在文件中找到`).toBeGreaterThan(-1);
  const end = src.indexOf("\n  },", start);
  return src.slice(start, end > start ? end : undefined);
}

describe("ISSUE-145 ① SSE 静默停摆看门狗（两端同源）", () => {
  const files: Array<[string, string]> = [
    ["web/src/shim/core/sse.ts", "web-sse"],
    ["electron/lib/server-agent-client.ts", "electron-sse"],
  ];

  for (const [rel, tag] of files) {
    it(`${tag}: 有存活判据与静默停摆超时阈值`, () => {
      const src = read(rel);
      expect(src, "缺少停摆阈值常量").toContain("SSE_STALL_TIMEOUT_MS");
      // 任何字节（含 15s `: ping` 心跳注释行）都必须刷新 lastByteAt，否则心跳不被当存活信号
      expect(src, "读循环未在收到字节时刷新 lastByteAt").toMatch(
        /const \{ value, done \} = await reader\.read\(\);\s*\n\s*if \(done\) break;\s*\n\s*[^\n]*\n\s*lastByteAt = Date\.now\(\)/
      );
      // 超时必须主动 abort 交给既有重连（而不是只打日志）
      expect(src, "超时未 abort，不会触发重连").toMatch(/ac\.abort\(\)/);
      // 每次重连必须新建 AbortController：复用同一个 ac 会在 abort 后退化成死循环重连
      expect(src, "未在 connect 内新建 AbortController").toMatch(
        /const connect = \(\) => \{[\s\S]{0,200}?const ac = new AbortController\(\)/
      );
      // 停表必须挂在关闭/重连路径上，避免定时器泄漏
      expect(src).toContain("clearStall");
    });
  }
});

describe("ISSUE-145 ② 家长会话必须回填历史（不得硬编码空数组）", () => {
  it("web shim: piStartParent / piStartParentContent 都真去拉 /parent-agent/open", () => {
    const src = read("web/src/shim/domains/agents.ts");
    expect(src, "shim 未定义 openParentSession").toMatch(/async function openParentSession/);
    expect(src).toContain('"/parent-agent/open"');
    for (const fn of ["piStartParent", "piStartParentContent"]) {
      const body = methodBody(src, fn);
      expect(body, `${fn} 未调用 openParentSession 回填历史`).toContain("openParentSession");
      expect(body, `${fn} 仍然硬编码空历史`).not.toMatch(/history:\s*\[\]/);
    }
  });

  it("Electron: pi:start_parent / pi:start_parent_content 同样回填且失败留痕", () => {
    const src = read("electron/lib/ipc-handlers.ts");
    for (const fn of ["pi:start_parent", "pi:start_parent_content"]) {
      const i = src.indexOf(`ipcMain.handle("${fn}"`);
      expect(i, `${fn} 未找到`).toBeGreaterThan(-1);
      const body = src.slice(i, src.indexOf("\n  });", i));
      expect(body, `${fn} 未回填历史`).toContain("openParentSession");
      // 失败不得静默吞成空历史（否则线上无从判断是"服务端没历史"还是"请求失败"）
      expect(body, `${fn} 的 open 失败被静默吞掉`).not.toMatch(/\.catch\(\(\)\s*=>\s*\[\]/);
    }
  });

  it("渲染层回填不覆盖流式已到的增量（刷新/切换竞态）", () => {
    const src = read("src/components/ParentChatPanel.tsx");
    expect(src).toMatch(/setMessages\(\(prev\)\s*=>\s*\(prev\.length \? prev : restored\)\)/);
  });
});

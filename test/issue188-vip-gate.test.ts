/**
 * ISSUE-188 回归（渲染层契约）：VIP 到期 → 任务门禁（不是登录页），且文案明确「不需要重新扫码」。
 *
 * 这条路径用源码断言守：App 是状态机（无路由），组件测试成本高；关键契约只有三点——
 * ①启动分支必须按 license.is_expired 进 task-gate；②门禁页必须带 expired 语义；
 * ③「去完成任务」的地址来自服务端 me_url（benefit token 免登录）。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(root, p), "utf-8");

describe("ISSUE-188 App：VIP 到期走任务门禁", () => {
  it("authCheck 返回未登录且 license.is_expired → 进 task-gate，而不是 parent-login", () => {
    const src = read("src/App.tsx");
    const i = src.indexOf("window.api.authCheck().then");
    expect(i).toBeGreaterThan(-1);
    const body = src.slice(i, i + 1200);
    expect(body).toMatch(/result\.license\?\.is_expired/);
    expect(body).toMatch(/setView\("task-gate"\)/);
    // 只有不具备"到期"语义时才回登录页
    expect(body).toMatch(/setView\("parent-login"\)/);
    expect(body.indexOf("is_expired")).toBeLessThan(body.indexOf('setView("parent-login")'));
  });

  it("门禁页收到 expired 标志 + 兜底 me_url（旧服务端也不至于死按钮）", () => {
    const src = read("src/App.tsx");
    expect(src).toContain("expired={taskGate?.expired === true}");
    expect(src).toContain("ME_FALLBACK_URL");
  });

  it("app 运行期间周期复检（仅 home/dashboard，不打断 learn）", () => {
    const src = read("src/App.tsx");
    expect(src).toMatch(/view !== "home" && view !== "dashboard"/);
    expect(src).toContain("5 * 60_000");
  });
});

describe("ISSUE-188 TaskGate：到期文案与免扫码承诺", () => {
  it("expired 变体明确「账号仍处于登录状态，不需要重新扫码」", () => {
    const src = read("src/pages/TaskGate.tsx");
    expect(src).toContain("学习权益已到期");
    expect(src).toMatch(/不需要重新扫码登录/);
    expect(src).toMatch(/无需重新登录\/扫码/);
  });

  it("仍每 5 秒轮询 authCheck，解锁即回调 onUnlocked", () => {
    const src = read("src/pages/TaskGate.tsx");
    expect(src).toContain("POLL_INTERVAL_MS = 5000");
    expect(src).toContain("window.api.authCheck()");
    expect(src).toContain("onUnlocked(");
  });
});

describe("ISSUE-188 服务端契约：/auth/license 带 me_url + 滑动续签钩子", () => {
  it("auth 路由返回 me_url（用 benefit_user_token 拼免登录地址）", () => {
    const src = read("server/src/routes/auth.ts");
    expect(src).toContain("buildMeUrl(");
    expect(src).toContain("benefit_user_token");
    expect(src).toMatch(/return \{ license, me_url: meUrl \}/);
    expect(src).toMatch(/degraded: true, me_url: meUrl/);
  });

  it("index.ts 在所有路由前挂续签钩子（X-Session-Token）", () => {
    const src = read("server/src/index.ts");
    expect(src).toContain("registerSessionRenewHook(app");
    expect(src.indexOf("registerSessionRenewHook")).toBeLessThan(src.indexOf("registerVersionRoutes(app)"));
  });
});

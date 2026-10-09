/**
 * 抖音扫码登录（benefit-auth IdP 接入，2026-09-21；2026-10-08 改 App 内窗口）。
 *
 * 流程：本地起一次性回调 HTTP 服务（127.0.0.1:17888，端口与 benefit-auth
 * 「学习伙伴」应用注册的 redirect_uri 一致）→ 打开 App 内授权窗口（persist 分区，
 * 登录会话跨启动保留，再次登录免重扫）→ 授权后 302 回本地回调带 code → 调
 * LAN server /api/v1/auth/douyin（code 由云端 benefit-auth 免 secret 换身份 →
 * license → 会话）→ 返回登录结果，授权窗口自动关闭。
 *
 * 抖音新家长初始订阅即时过期（待解锁）：license.is_expired = true 时由渲染层
 * 引导去 benefit-auth 个人中心完成任务；云端在每次 /auth/license 查询时自动把
 * 新完成的任务权益折算进有效期，客户端轮询到有效后即自动进入主页。
 */
import http from "http";
import crypto from "crypto";
import { BrowserWindow } from "electron";
import { getCloudApiBase } from "./config";
import { serverFetch, ServerError } from "./server-client";
import { activateParentSession, cacheLicense, type License } from "./auth-manager";

// benefit-auth「学习伙伴」应用 app_id（OAuth client_id，公开标识非机密；env 可覆盖）
const BENEFIT_CLIENT_ID = process.env.BENEFIT_CLIENT_ID ?? "app_2cd2b7263372a407";
const CALLBACK_PORT = 17888;
const CALLBACK_PATH = "/callback";
const FLOW_TIMEOUT_MS = 5 * 60 * 1000;

export interface DouyinLoginResult {
  success: boolean;
  /** license 过期 → 需去 benefit-auth 个人中心完成任务解锁 */
  needs_task: boolean;
  license: License | null;
  email: string;
  benefit_user_token: string;
  /** benefit-auth 个人中心地址（任务/权益页，浏览器打开） */
  me_url: string;
  error?: string;
}

/** App 内授权窗口（模块级单例，重复发起时复用/替换） */
let authWin: BrowserWindow | null = null;

function openAuthWindow(url: string): BrowserWindow {
  if (authWin && !authWin.isDestroyed()) authWin.destroy();
  const win = new BrowserWindow({
    width: 500,
    height: 700,
    title: "抖音扫码登录",
    autoHideMenuBar: true,
    webPreferences: {
      // 持久分区：benefit-auth 登录会话（ba_sid Cookie）跨启动保留，已登录时免重扫
      partition: "persist:douyin-auth",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 授权流程全程本窗内跳转（含最终回本地回调），不允许弹新窗
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("closed", () => {
    if (authWin === win) authWin = null;
  });
  void win.loadURL(url);
  authWin = win;
  return win;
}

function closeAuthWindow(): void {
  if (authWin && !authWin.isDestroyed()) authWin.destroy();
  authWin = null;
}

function waitForCallback(): {
  promise: Promise<{ code: string; state: string }>;
  cancel: () => void;
} {
  let server: http.Server | null = null;
  const promise = new Promise<{ code: string; state: string }>((resolve, reject) => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${CALLBACK_PORT}`);
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      const err =
        url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "";
      server.close();
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (err || !code) {
        res.end(
          `<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h3>授权未完成</h3><p>${err || "未返回授权码"}，请回到应用重试</p></body></html>`
        );
        reject(new Error(err || "授权未完成"));
        return;
      }
      res.end(
        `<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h3>✅ 操作成功</h3><p>请回到「学习伙伴」应用继续</p></body></html>`
      );
      resolve({ code, state });
    });
    server.on("error", (e) =>
      reject(new Error(`本地回调端口(${CALLBACK_PORT})监听失败：${e.message}`))
    );
    server.listen(CALLBACK_PORT, "127.0.0.1");
  });
  return { promise, cancel: () => server?.close() };
}

/** 打开 App 内授权页并等待用户扫码确认，返回授权码（登录/重置密码共用）。 */
async function runCodeFlow(): Promise<{ code: string; redirectUri: string }> {
  const state = crypto.randomBytes(8).toString("hex");
  const redirectUri = `http://127.0.0.1:${CALLBACK_PORT}${CALLBACK_PATH}`;
  const authorizeUrl =
    `${getCloudApiBase()}/oauth/authorize?client_id=${encodeURIComponent(BENEFIT_CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&state=${state}`;

  const { promise: pending, cancel } = waitForCallback();
  const win = openAuthWindow(authorizeUrl);
  const cancelled = new Promise<never>((_, rej) => {
    win.once("closed", () => rej(new Error("授权窗口已关闭，请重试")));
  });
  try {
    const cb = await Promise.race([
      pending,
      cancelled,
      new Promise<never>((_, rej) =>
        setTimeout(() => rej(new Error("授权超时（5 分钟），请重试")), FLOW_TIMEOUT_MS)
      ),
    ]);
    if (cb.state !== state) throw new Error("state 校验失败，请重试");
    return { code: cb.code, redirectUri };
  } finally {
    cancel();
    closeAuthWindow();
  }
}

export async function douyinLoginFlow(): Promise<DouyinLoginResult> {
  const fail = (error: string): DouyinLoginResult => ({
    success: false,
    needs_task: false,
    license: null,
    email: "",
    benefit_user_token: "",
    me_url: "",
    error,
  });

  let code: string;
  let redirectUri: string;
  try {
    const flow = await runCodeFlow();
    code = flow.code;
    redirectUri = flow.redirectUri;
  } catch (e) {
    return fail((e as Error).message);
  }

  try {
    const data = await serverFetch<{
      session_token: string;
      license: Omit<License, "token" | "cached_at">;
      email: string;
      benefit_user_token: string;
    }>("/auth/douyin", { method: "POST", body: { code, redirect_uri: redirectUri } });
    const licenseData = await serverFetch<{
      license: Omit<License, "token" | "cached_at">;
    }>("/auth/license", { token: data.session_token });
    const license: License = {
      ...licenseData.license,
      email: data.email,
      token: data.session_token,
      cached_at: new Date().toISOString(),
    };
    cacheLicense(license);
    activateParentSession(license.parent_id);
    return {
      success: true,
      // 初始即过期（待解锁）→ 引导去完成任务；完成任务后云端延长有效期
      needs_task: license.is_expired === true,
      license,
      email: data.email,
      benefit_user_token: data.benefit_user_token,
      me_url: `${getCloudApiBase()}/me?token=${encodeURIComponent(data.benefit_user_token)}`,
    };
  } catch (e) {
    return fail(e instanceof ServerError ? e.message : (e as Error).message);
  }
}

export interface DouyinResetResult {
  success: boolean;
  error?: string;
}

/**
 * 忘记家长中心密码：抖音重新扫码确认身份 → 按抖音关联家长直接重置密码。
 * 新密码由调用方先收集；扫码成功即重置成功（无需旧密码）。
 */
export async function douyinResetParentPassword(newPassword: string): Promise<DouyinResetResult> {
  try {
    const { code, redirectUri } = await runCodeFlow();
    await serverFetch("/auth/douyin-reset-password", {
      method: "POST",
      body: { code, redirect_uri: redirectUri, new_password: newPassword },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof ServerError ? e.message : (e as Error).message };
  }
}

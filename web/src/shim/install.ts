/**
 * Web 版 window.api 适配层安装入口（设计方案 §0/§4）。
 *
 * 方法面与 electron/preload.ts 逐条对齐（preload 共 204 个方法），按域分组组装：
 *   agents(46) parent(17) exam(19) misc(19) scheduler(13) models(11) voice(8)
 *   children(8) plans(8) learning(7) files(6) auth(6) assessment(11) window(6)
 *   config(4) backup(4) skills(5) sessions(3) dialogs(2) materials(1) db(0)
 *
 * Phase 1 状态：
 *   - 真实现：auth 域全部（authLogin/authRegister/authCheck/authLogout/authVerify/
 *     getSessionParentId）、misc 域的 serverGetConfig/serverSetConfig/getAppVersion、
 *     window 域的 windowIsMaximized/onWindowMaximized（App 启动到登录页的必经调用）。
 *   - 其余为 throw stub（[web-shim] 未实现: <name>），后续 Phase 按域替换。
 *
 * 渲染层共享分支一律以 window.api.__web 守卫（Electron 路径零改动）。
 */
import { authDomain } from "./domains/auth";
import { childrenDomain } from "./domains/children";
import { dbDomain } from "./domains/db";
import { configDomain } from "./domains/config";
import { modelsDomain } from "./domains/models";
import { sessionsDomain } from "./domains/sessions";
import { opsDomain } from "./domains/ops";
import { schedulerDomain } from "./domains/scheduler";
import { materialsDomain } from "./domains/materials";
import { filesDomain } from "./domains/files";
import { fsDomain } from "./domains/fs";
import { backupDomain } from "./domains/backup";
import { parentDomain } from "./domains/parent";
import { plansDomain } from "./domains/plans";
import { examDomain } from "./domains/exam";
import { assessmentDomain } from "./domains/assessment";
import { voiceDomain } from "./domains/voice";
import { skillsDomain } from "./domains/skills";
import { learningDomain } from "./domains/learning";
import { agentsDomain } from "./domains/agents";
import { dialogsDomain } from "./domains/dialogs";
import { windowDomain } from "./domains/window";
import { miscDomain } from "./domains/misc";
// Phase 4 接线：页面卸载时关闭全部 agent SSE 流（服务端会话持久，重进页面按需重建）
import { closeAllSseStreams } from "./core/sse";
// Phase 2 接线：config-sync 2min 轮询 + 60s 到期提醒轮询（misc 域导出）
import { startMiscLoops } from "./domains/misc";

/** 组装完整的 window.api（域之间方法名互不重叠，展开顺序无关）。 */
function buildWebApi() {
  return {
    /** Web 宿主标志：渲染层共享分支的唯一守卫（设计方案 §4） */
    __web: true as const,
    ...authDomain,
    ...childrenDomain,
    ...dbDomain,
    ...configDomain,
    ...modelsDomain,
    ...sessionsDomain,
    ...opsDomain,
    ...schedulerDomain,
    ...materialsDomain,
    ...filesDomain,
    ...fsDomain,
    ...backupDomain,
    ...parentDomain,
    ...plansDomain,
    ...examDomain,
    ...assessmentDomain,
    ...voiceDomain,
    ...skillsDomain,
    ...learningDomain,
    ...agentsDomain,
    ...dialogsDomain,
    ...windowDomain,
    ...miscDomain,
  };
}

/** 在 React 挂载前调用（web/src/main.tsx）：安装与 preload 同签名面的 window.api。 */
export function installWebApi(): void {
  (window as any).api = buildWebApi();
  // Phase 2：config-sync + 提醒轮询随安装启动（内部惰性 ensure 兜底仍在，双保险）
  startMiscLoops();
  // Phase 4：SSE 流随页面存活，卸载即全部关闭（避免僵尸连接；登录态/服务端会话不受影响）
  window.addEventListener("beforeunload", closeAllSseStreams);
}

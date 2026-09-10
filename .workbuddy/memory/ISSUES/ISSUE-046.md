## [ISSUE-046] 学习考核 Ubuntu 客户端点「按住说话」录音按钮提示「没有权限」（Linux 特有媒体权限预检缺失）

- **类型**：缺陷 / 跨平台 bug（仅 Linux/Ubuntu 暴露）
- **现象**：闻闻的 Ubuntu 客户端在考核页点「开始答题 / 按住说话」录音按钮时，提示「没有权限」，无法录音；Windows / macOS 客户端正常（client 0.1.9 在 Win/Mac 工作，因 10:15 已修过 `allow-same-origin` 沙盒 iframe 录音权限，当时只靠 `setPermissionRequestHandler` 放行 `media` 在 Win/Mac 够用）。
- **根因**：考核页录音是在 **`srcDoc` 沙盒 iframe** 里调用 `navigator.mediaDevices.getUserMedia({audio:true})`；`getUserMedia` 在弹「权限请求」前会先走一次**权限预检** `session.setPermissionCheckHandler`。代码**只实现了 `setPermissionRequestHandler`（放行 `media`），漏掉了 `setPermissionCheckHandler`**。Electron 对未实现的 check handler，在 **Linux(Ubuntu) 上默认拒绝媒体权限**，预检被拒就直接抛 `NotAllowedError` → 表现即「没有权限」。而 Windows/macOS 对未设 check 的默认行为不同，所以一直没暴露——典型「只在一个平台测过漏掉的跨平台坑」。
- **修复**（`electron/main.ts`，主进程）：新增 `const allowMedia = (p: string) => p === "media" || p === "microphone" || p === "camera";`，同时实现两个 handler：
  ```ts
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(permission));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowMedia(permission));
  });
  ```
  覆盖 `media`/`microphone`/`camera` 全部媒体权限串，兼容不同 Electron 分支。
- **版本**：客户端 0.1.9 → **0.1.10**（纯客户端修复，服务端 0.3.1 不变）。
- **验证**：`tsc --noEmit` 对 `main.ts` 0 错；改动已提交 git（commit `76ecf9d`）+ 打 tag `v0.1.10` 并推送到 origin/github 双远端，已触发 GitHub Actions `build-linux` 出 `deb`/`AppImage`（产物名 `学习伙伴_0.1.10_amd64.deb`）。
- **部署 / 现状**：改的是**主进程**，闻闻 Ubuntu 客户端必须**重装新 Linux 包（deb/AppImage）+ 本地重启 GUI 客户端**才生效（SSH 杀不掉桌面进程，见 PACKAGING §4.2）。截至记录时：CI 已在跑、产物待手动取回部署到 201（192.168.1.201）。关联 ISSUE-027（学习考核）真 bug。
- **优先级**：P0（已修复未发布，等构建产物部署）
- **记录时间**：2026-09-03

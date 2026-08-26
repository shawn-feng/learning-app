# 打包记录与操作细节（PACKAGING）

> 本文档集中记录「学习伙伴 / xuexihub」桌面应用的打包流程、环境约束、踩坑清单与认证网络修复史。
> 当前目标版本：**0.1.0**，优先交付 **Ubuntu 24 x64** 安装包（deb + AppImage）。
> 应用信息：`name=learning-app`，`productName=学习伙伴`，`appId=com.learning-app.desktop`，`executableName=xuexihub`。

---

## 1. 跨平台打包能力结论

| 平台 | 是否可打包 | 约束 |
|------|-----------|------|
| Ubuntu 24 (x64) | ✅ 可 | 需在 **Linux 环境** 构建（见 §3 远程构建机）；deb + AppImage 已产出 |
| Mac (dmg) | ⚠️ 必须 macOS | dmg 只能在 macOS 机器上构建，无法在 Windows/Linux 交叉产出 |
| Windows (nsis) | ✅ 可 | `npm run dist:win`，本机即可 |
| Web 端 | ❌ 不可 | 全应用走 IPC（contextBridge + ipcRenderer/ipcMain），无浏览器 HTTP 入口，不能当纯 web 服务 |

**关键约束**：Linux 包依赖 tree-sitter 等原生模块，必须在 Linux 环境构建。本机（Windows）的 **WSL / Docker 被沙箱策略禁用**，无法直接产出 Linux 包，因此走局域网 Ubuntu 远程构建链路。

---

## 2. 用户数据路径（打包态）

代码根目录判定（`electron/lib/config.ts`）：

```ts
} else if (app?.isPackaged) {
  dataDir = path.join(app.getPath("userData"), "app-data");
}
```

- `app.getPath("userData")` 在 Linux 默认 = `~/.config/<appName>`，`<appName>` 取自 `package.json` 的 `name`（`learning-app`，代码无 `setName` 覆盖）。
- 若设了 `XDG_CONFIG_HOME`，则为 `$XDG_CONFIG_HOME/learning-app/app-data`。

**用户数据根目录：**

```
/home/<用户名>/.config/learning-app/app-data/
```

目录结构：

```
~/.config/learning-app/app-data/
├── shared/                    # 共享数据（getSharedDir）
│   ├── auth.json              # 家长登录态
│   ├── scheduler-config.json  # 录制等定时任务配置（per-child）
│   ├── skills/                # 共享技能
│   ├── kb.sqlite              # 共享知识库
│   └── *.jsonl                # 同步日志
├── children/                  # 按 childId 隔离（getChildrenDir）
│   └── <childId>/
│       ├── sessions/          # 会话落盘（ISSUE-023 后每孩子一个 kb.sqlite）
│       ├── uploads/           # 孩子上传文件
│       └── learning/          # 学习资料（如 lunyu/materials）
├── license.json               # 授权（getLicensePath）
├── task-state.json            # 任务状态
└── app-settings.json          # 应用设置
```

**要点**：程序本体装在 `/opt/`（deb 默认 `/opt/学习伙伴/...` 或 `xuexihub` 可执行），**所有用户数据都在 home 下**，重装只需备份 `~/.config/learning-app/` 整个目录。早期版本 Pi SDK 曾泄漏到 `~/.pi/agent/sessions/`，0.1.0 已统一收敛到 `app-data/children/<childId>/`。

---

## 3. 远程构建机（Ubuntu，局域网）

| 项 | 值 |
|----|----|
| IP | `192.168.1.201` |
| 用户 | `shanshan` |
| 密码 | `123456`（局域网测试机，勿用于公网） |
| 工作目录 | `/home/shanshan/pi` |
| 工具 | PuTTY `plink` / `pscp`（Windows 侧），需 `-hostkey` 跳过首次指纹确认 |

**plink host key（首次连接必需）**：
```
SHA256:u90140y+d4butWm1tF/Jlsx6CvNO9AoPE+bxW2R5nK4
```
使用示例：
```bat
plink -ssh -hostkey "SHA256:u90140y+d4butWm1tF/Jlsx6CvNO9AoPE+bxW2R5nK4" shanshan@192.168.1.201 -pw 123456 "cd /home/shanshan/pi && rm -rf out dist && npm run dist:linux"
```

### 完整发版流程（远程机已初始化 node_modules 后，仅增量同步改动文件）

1. 本机用 `pscp` 把**改动的文件**同步到 `/home/shanshan/pi/`（注意中文文件名会乱码，先改 ASCII 名再传，远端 `mv` 回去）。
2. 远端执行干净构建：
   ```bash
   cd /home/shanshan/pi
   rm -rf out dist
   npm run dist:linux          # = electron-vite build && electron-builder --linux
   ```
3. 产物在 `dist/`（`learning-app_0.1.0_amd64.deb` + `学习伙伴-0.1.0.AppImage`）。
4. 用 `pscp` 拉回本机 `dist-ubuntu/`（AppImage 中文名也需先 `mv` 为 ASCII 名再拉，本地改回）。

> 依赖同步陷阱：若新增了文件（如 `delivery.ts`）或新增了依赖（如 `lucide-react`），必须整目录重同步并在远端 `npm install <pkg> --legacy-peer-deps`，否则打包会因缺模块失败。

---

## 4. 踩坑清单（已解决）

| # | 现象 | 根因 | 解决 |
|---|------|------|------|
| 1 | plink 卡在 host-key 交互 | 首次连接需确认指纹 | 加 `-hostkey "SHA256:u90140y+..."` |
| 2 | pscp 中文文件名乱码 | PuTTY 传输编码 | 远端先 `mv` 为 ASCII 名再传/拉，本地改回中文 |
| 3 | deb 构建报错缺字段 | 缺 `homepage`/`author`/`linux.maintainer` | package.json 补齐（见 §5） |
| 4 | `npm ci` peer 冲突失败 | `typescript@7` 与 `edge-tts` 冲突 | 用 `--legacy-peer-deps` |
| 5 | 打包后运行缺模块 | 远端依赖不同步（缺 `delivery.ts`、`lucide-react`） | 整目录重同步 + 远端 `npm install lucide-react --legacy-peer-deps` |
| 6 | 打包态 templates 路径错误 | `user-init.ts` 用 `process.cwd()` 取 templates | 改为 `app.isPackaged ? process.resourcesPath : process.cwd()`（见 §5） |

---

## 5. 代码改动清单（打包相关）

| 文件 | 改动 |
|------|------|
| `electron/lib/user-init.ts` | 修复打包态 templates 路径 bug，加 `app.isPackaged ? process.resourcesPath : process.cwd()` |
| `package.json` | `version` 钉 0.1.0；`linux` 加 `deb`+`AppImage`、`arch: x64`、`executableName: xuexihub`、补齐 `homepage`/`author`/`linux.maintainer`；新增 `dist:linux` 脚本 |
| `.github/workflows/build-linux.yml` | ubuntu-latest CI 构建工作流（备用，本机未跑） |
| `electron/lib/config.ts` | `getCloudApiBase()` 纯公网（见 §6）；`getDataDir()` 打包态 `userData/app-data` |
| `electron/lib/cloud-net.ts` | **electron.net.fetch 优先**，抛错降级 Node fetch，包裹可读错误（见 §6） |
| `electron/lib/ipc-handlers.ts` | 删除 `auth:setServer`、恢复 `auth:login/register` 为 `(email, password)` |
| `electron/preload.ts` | `authLogin/authRegister` 恢复 `(email, password)`，删 `authSetServer` |
| `src/pages/ParentLogin.tsx` | 删除"服务端地址"输入框，仅 email/password |

---

## 6. 认证 / 云端网络修复史（fetch failed）

**需求演进**：家长登录报 `fetch failed` → 用户要求【不做本地 pi-web，所有认证走公网，不写任何本地地址，不显示认证地址输入框】。

| 阶段 | 尝试 | 结果 |
|------|------|------|
| A | 误改 `cloud-net.ts`（实际 login 被 rollup 内联成直接 fetch，`cloud-net` 未进包） | 无效，查明根因不在该文件 |
| B | 加"服务端地址"输入框可配化 + 重打包 | 用户否决：不要输入框、纯公网 |
| C | 删输入框、`config.ts` 纯公网、`cloud-net.ts` 改纯 Node fetch | 远程机能连，但本机 `npm run dev` 仍 `fetch failed` |
| D | **改回 `electron.net.fetch` 主路径**（Chromium 栈，读系统代理/证书），Node fetch 仅兜底 | ✅ 解决（本机浏览器可访问、dev 也能连） |

**根因结论**：`fetch failed` 是**运行机网络/代理/证书**问题，非打包 bug。`Node 全局 fetch` 不读系统代理与企业证书；`electron.net.fetch` 与浏览器同栈，能正常连 `https://www.aixuexihao.top`。

**当前实现**（`electron/lib/cloud-net.ts`）：优先 `electron.net.fetch`，抛错降级 Node fetch，错误信息包裹为「无法连接云端服务（url）：…」。

**云端地址环境变量**（可选覆盖，只读，默认均指向公网，不写本地地址）：
- `CLOUD_API_URL` → 覆盖认证/license 地址，默认 `https://www.aixuexihao.top`（`getCloudApiBase`）
- `UPDATE_FEED_URL` → 覆盖自动更新 feed，默认 `https://www.aixuexihao.top/download/`（`getUpdateFeedUrl`，ISSUE-040）

> ⚠️ 家长账号 `79734745@qq.com` 必须在公网云端 `www.aixuexihao.top` **已注册**，否则登录失败（与本地无关）。

---

## 7. 交付物（当前 0.1.0）

位于 `dist-ubuntu/`：
- `dist-ubuntu/learning-app_0.1.0_amd64.deb`（约 138 MB）
- `dist-ubuntu/学习伙伴-0.1.0.AppImage`（约 184 MB）

安装：`sudo dpkg -i learning-app_0.1.0_amd64.deb`（或双击；AppImage 加执行权限 `chmod +x` 后直接运行）。

---

## 8. 后续发版检查清单

- [ ] 修改文件同步到 `/home/shanshan/pi`（注意中文名、依赖同步）
- [ ] 远端 `rm -rf out dist && npm run dist:linux`
- [ ] 拉回 `dist-ubuntu/` 并重命名中文 AppImage
- [ ] 验证 deb 字段齐全（homepage/author/maintainer）
- [ ] 确认 `cloud-net.ts` 为 `electron.net.fetch` 主路径
- [ ] 确认 `getCloudApiBase()` 纯公网、无本地地址残留
- [ ] 家长账号已在 `www.aixuexihao.top` 注册
- [ ] 升级 `package.json` 的 `version` 后再构建（如需新版本号）

---

## 9. Mac 打包（本地 macOS 构建，不签名 ad-hoc）

> 选型：**在自己的 Mac 上本地构建 + 不签名（ad-hoc）** 为主。Mac dmg 必须 macOS 环境，Windows/Linux 无法交叉编译。
> 2026-08-26 更新：已新建 GitHub 仓库 `git@github.com:shawn-feng/learning-app.git`，因此 **GitHub Actions 自动构建（macos-latest）现也已可用**，作为替代路径。两种路径共用同一套 `dist:mac` 脚本与 `build.mac` 配置。本机已生成专属 deploy key（`~/.ssh/github_learning_app`，见 §9.7）。

### 9.1 已完成的配置（本机直接复用）

- `package.json`：新增脚本 `"dist:mac": "electron-vite build && electron-builder --mac"`；`build.mac` 补 `"category": "Education"`、`"minimumSystemVersion": "10.15"`、`"artifactName": "${productName}-${version}-${arch}.${ext}"`，`target` 为 **两个独立 dmg：`[{ "target": "dmg", "arch": "x64" }, { "target": "dmg", "arch": "arm64" }]`**（即 `学习伙伴-0.1.0-x64.dmg` + `学习伙伴-0.1.0-arm64.dmg`）。**不写 `identity`** → 无 Developer ID 证书时 electron-builder 自动 fallback 为 ad-hoc 签名（零成本，用户下载后手动放行）。
- **为何「两个独立 dmg」而非 universal**：GitHub `macos-latest` 是 Apple Silicon 机器，默认打出 **arm64-only** dmg；Intel Mac（实测用户为 **Intel macOS 12.7.6**）无法执行 arm64 二进制，会报"该 Mac 不支持这个应用"。先试 `universal`（x64+arm64 合一）在合并阶段报错：`@earendil-works/pi-tui` 的原生 `.node` 被同时打进 x64/arm64 两临时包（`Detected file ... darwin-arm64/darwin-modifiers.node ... same in both`）。最终改为**两个独立单架构 dmg**（各自打包、不经合并）绕开冲突：x64 给 Intel 原生、arm64 给 Apple Silicon 原生。`minimumSystemVersion: 10.15` 防止 Runner 抬高最低系统版本误拦旧 macOS。
- `.github/workflows/build-mac.yml`：**已可用**。GitHub 仓库 `shawn-feng/learning-app` 已建立，push `v*` tag 或到 Actions 页手动 Run 即触发 macos-latest 自动构建，产出 **x64 + arm64 两个 dmg**（Artifact `macos-dmg`，约 340MB）。本机已配置 deploy key 用于推送（见 §9.7）。

### 9.2 环境准备（Mac 上）

- **Node 22+**：项目依赖 typescript@7 / electron 43，建议 `nvm install 22 && nvm use 22` 或官网 pkg。
- **Xcode Command Line Tools（必须）**：`xcode-select --install`。electron-builder 打包 dmg 依赖系统的 `hdiutil` / 签名工具，缺失会构建失败。
- **代码**：从 Gitee 拉取（`git clone <你的Gitee地址> && cd pi`，已有则 `git pull`）。

### 9.3 构建

```bash
cd pi
npm ci --legacy-peer-deps      # 必须 --legacy-peer-deps（typescript@7 与 edge-tts peer 冲突）
npm run dist:mac               # electron-vite build + electron-builder --mac
# 产物：dist/学习伙伴-0.1.0.dmg （或 learning-app-0.1.0.dmg）
```
> 中国网络下 package.json 的 `electronDownload.mirror` 已指向 npmmirror，下载 electron 二进制较快；若在海外 Mac 上下载慢，可临时 `ELECTRON_MIRROR=https://github.com/electron/electron/releases/download/ npm run dist:mac`。

### 9.4 用户安装（不签名）

1. 双击 `dmg` 拖到「应用程序」。
2. 首次打开会被 Gatekeeper 拦截（"无法验证开发者"），二选一放行：
   - **方式 A**：系统设置 → 隐私与安全性 → 底部「仍要打开」；
   - **方式 B（终端）**：`sudo xattr -rd com.apple.quarantine /Applications/学习伙伴.app`
3. 之后正常启动。

### 9.5 常见问题

- 报 `xcodebuild` / `hdiutil` 相关错误 → 没装 Xcode CLT，执行 `xcode-select --install`。
- `npm ci` 报 ERESOLVE → 漏了 `--legacy-peer-deps`，务必加上。
- Node 版本过低 → 升级到 22+。
- **安装时弹"该 Mac 不支持这个应用"** → 旧版 dmg 是 arm64-only，Intel Mac 无法执行。现已产出 **x64 + arm64 两个独立 dmg**（见 §9.1）：Intel Mac 装 `*-x64.dmg`、Apple Silicon 装 `*-arm64.dmg`，均锁 `minimumSystemVersion: 10.15`。重新下载 Actions 里最新 `macos-dmg` 即可；若仍报，确认下载的是对应架构的最新包而非旧的 arm64 包。

### 9.6 升级签名（可选）

若要对外分发、免手动放行，需 Apple 开发者账号（$99/年）+ 证书，在 `build.mac` 配置 Developer ID 签名 + 公证（notarize，可本地 `xcrun notarytool` 或 CI 注入 `CSC_LINK`/`CSC_KEY_PASSWORD`）。当前按「不签名」交付，后续可平滑升级。

### 9.7 GitHub Actions 构建（替代路径，2026-08-26 起可用）

> 前提：GitHub 仓库 `shawn-feng/learning-app` 已建立，本机已生成 deploy key（`~/.ssh/github_learning_app`，无密码，仓库级只读/读写取决于 GitHub 上的 Deploy key 勾选）。

**步骤：**

1. **把公钥加到 GitHub**（二选一）：
   - **仓库 Deploy key（推荐，权限最小）**：仓库 `Settings → Deploy keys → Add deploy key`，Title 填 `learning-app-deploy`，粘贴公钥，✅ 勾选 `Allow write access`（否则无法 `git push`），Add key。
   - **账号 SSH key（宽松）**：GitHub `Settings → SSH and GPG keys → New SSH key`，粘贴公钥。
   - 公钥内容（本机已生成）：
     ```
     ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH/wwyQni/rzfnryc2s3mEGUqlvc/MvZnEru78cqj5+k deploy-learning-app@github
     ```
2. **推送代码**（本机已配 `github` 远程）：
   ```bash
   git push github master          # 当前分支为 master
   ```
3. **触发 Mac 构建**（二选一）：
   - **打 tag 自动触发**：`git tag v0.1.0 && git push github v0.1.0`
   - **手动触发**：GitHub 仓库 `Actions → Build macOS → Run workflow`
4. **下载产物**：运行结束后 `Artifacts → macos-dmg`（含 `学习伙伴-0.1.0.dmg`）。

> 注意：`build-mac.yml` 的 `on` 是 `workflow_dispatch` + `push: tags: ['v*']`，**普通 push 到 master 不会自动构建**，必须打 `v*` tag 或手动 Run。
> 安全提示：deploy key 私钥 `~/.ssh/github_learning_app` 无密码落在本地磁盘，仅限本机/可信环境使用；若机器不再使用，到 GitHub 删除对应 Deploy key 即可吊销。

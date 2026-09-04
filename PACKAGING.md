# 打包发布操作手册（PACKAGING）

> 当前基线：客户端 **0.1.11** / 服务端 **0.3.2**（2026-09-04 实战验证）。
> 本文覆盖「客户端 + 服务端」完整发布链路：本机打 Windows 包 + 服务端打包 → 部署到局域网服务器 **201** → 公网（**ECS**）发布 Win/Linux/Mac。

---

## 0. 拓扑与目标环境

| 目标 | 主机 | 部署内容 | 说明 |
|---|---|---|---|
| 局域网服务端（**201**） | `192.168.1.201`（家庭 LAN） | `learning-server` 0.3.x + 学习伙伴 Ubuntu 客户端 0.1.x | 孩子/家长实际连接的服务器；服务端为 systemd 服务，客户端为桌面 GUI |
| 公网分发（**ECS**） | `47.96.154.226` / `i-bp15zfctbt147ktl39pk`（cn-hangzhou） | `learning-cloud`（静态下载源 + `/api/version`） | nginx 从 **本地目录** `/opt/learning-cloud/download/` 提供 `www.aixuexihao.top/download/` |

> ⚠️ **两个名字易混，别搞错**：
> - `learning-server` = 业务服务端（在 **201** 上跑，版本 0.3.x）；
> - `learning-cloud` = 公网下载源（在 **ECS** 上跑，FastAPI + nginx）。
> 二者互不相干。

### 前置

| 项 | 说明 |
|---|---|
| 仓库 remote | `origin` = gitee（nanchang-um-um-network/learning-partner）；`github` = GitHub（shawn-feng/learning-app，Actions 在此构建 Linux/Mac） |
| OSS 中转 | bucket `aixuexihao-app`（**公共读**），AK/SK 在仓库根 `aliyun-aksk.txt`（格式 `accessKeyId xxx` / `accessKeySecret xxx`） |
| Python venv | `C:/Users/79734/.workbuddy/binaries/python/envs/default/Scripts/python.exe`，需装 `oss2`、`aliyun-python-sdk-core`、`paramiko` |
| 登记 Token | `ADMIN_TOKEN` 在 ECS `/opt/learning-cloud/.env`，发布时现取，勿硬编码 |
| 201 凭据 | 家庭 LAN 服务器，SSH 用户名/密码见本地/团队记录（非公网，不在文档内留明文） |

---

## 1. 版本号

- **客户端版本**：`package.json` 顶层 `version`（如 `0.1.9`）。
- **服务端版本**在两处，且必须一致：
  - `server/src/routes/version.ts` 的 `SERVER_VERSION` —— 真正写入响应、被客户端校验的版本，**以它为准**；
  - `server/package.json` 的 `version` —— 仅用于构建横幅标签。
- 递增规则：客户端小版本递进（0.1.8→0.1.9），服务端配套递进（0.3.0→0.3.1）。`MIN_CLIENT_VERSION` 一般保持 `0.1.0`；`SERVER_FEATURES` 保持 `["session_sync","worker","exam"]`。

---

## 2. 客户端打包

### 2.1 Windows（本机）
```bash
# ⚠️ 必须 unset NODE_OPTIONS：沙箱注入的 genie-safe-delete shim 会破坏 electron-builder 清 tmp，导致打包失败
rm -rf dist && unset NODE_OPTIONS && npm run dist:win
# 依赖若报 peer 冲突（typescript@7 vs edge-tts），先：npm install --legacy-peer-deps
# 产物：dist/latest.yml + 学习伙伴 Setup <ver>.exe + 学习伙伴 Setup <ver>.exe.blockmap
```
> 若 Defender 锁 `dist/win-unpacked` 导致打包失败，把 `package.json` 的 `build.directories.output` 临时改成全新目录（如 `dist-release-019`）再打，打完改回 `dist`。

### 2.2 Linux / macOS（GitHub Actions，本机无法打）
- 触发：把打好 tag 的 commit **push 到 `github`**（`v*`，如 `v0.1.9`）即自动构建。
- `build-linux.yml` → 产物 `dist/*.deb` + `dist/*.AppImage`（x64）。
- `build-mac.yml` → matrix `arch:[x64, arm64]` → **两次运行**，产物 `dist/*.dmg`（分别 x64 / arm64）。
- 注意事项：
  - CI 用 `npm ci --legacy-peer-deps`（typescript@7 与 edge-tts 的 peer 冲突）。
  - macOS 必须按目标架构 rebuild `ffmpeg-static`（`npm rebuild ffmpeg-static`），否则 Intel Mac 会跑 arm64 ffmpeg 导致语音输入不可用；并锁 `MACOSX_DEPLOYMENT_TARGET=10.15` 防止旧 Mac 报“不支持此应用”。
- 取产物（`gh run download` 要的是 `databaseId`，不是列表序号）：
```bash
gh run list --repo shawn-feng/learning-app --limit 5
gh run download <databaseId> --repo shawn-feng/learning-app --dir artifacts
# 得到：linux-x64-installers / macos-dmg-x64 / macos-dmg-arm64
```

---

## 3. 服务端打包

```bash
cd server && node scripts/build.mjs
# 产物：server/dist/server.cjs（esbuild 单文件；node:sqlite 外置；已自动打 import_meta.url 补丁）
# 构建横幅会打印 learning-server v<x.y.z>，确认版本正确
```
> ⚠️ **pkg 二进制已废弃**：agent SDK 动态 import 会触发 `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING`。201 上直接用 `node /opt/learning-server/server.cjs` 运行（见 §4.1）。
> ⚠️ 构建脚本会把所有 `import_metaN.url` 替换为 `__filename` 等价物——这是必须的，否则启动即崩（2026-08-31 实测）。
> 数据库在服务端启动时**自动 migrate**（如 `study_plan_items`），无需手工建表。

---

## 4. 部署到局域网 201（`192.168.1.201`）

用 paramiko（或任意 SSH 工具）登录 201。以下为关键步骤示意。

### 4.1 服务端
```python
# paramiko 脚本要点：
# 1) 上传本地 server/dist/server.cjs  →  /opt/learning-server/server.cjs
# 2) sudo 重启服务：
#    echo "<201-sudo密码>" | sudo -S systemctl restart learning-server
# 3) 验证：
#    curl -s http://127.0.0.1:8788/api/v1/version   # 应含 version=0.3.x
#    curl -s http://127.0.0.1:8788/health           # ok
```
> ⚠️ `server/scripts/learning-server.service` 仍写 `ExecStart=/opt/learning-server/learning-server`（旧 pkg 路径），**需改为** `ExecStart=/usr/bin/node /opt/learning-server/server.cjs`，否则服务起不来。
> 服务端数据目录：`SERVER_DATA_DIR=/opt/learning-server/data`（service 的 Environment 已设）。

### 4.2 客户端（Ubuntu GUI）
```bash
# 上传本地 deb → 201，sudo 安装：
# echo "<201-sudo密码>" | sudo -S dpkg -i /tmp/learning-app_<ver>_amd64.deb
# 验证：dpkg -l learning-app   →   ii  learning-app  <ver>
```
> ⚠️ **GUI 进程无法经 SSH 重启**：`dpkg -i` 覆盖了 `/opt/学习伙伴/xuexihub`，但桌面会话里的旧进程仍在内存中，SSH 杀不掉它。必须在 **201 本地**手动重启「学习伙伴」客户端，0.1.x 才会真正生效。

---

## 5. 公网发布（ECS `47.96.154.226`）

核心链路：**先传 OSS（中转）→ 再 curl 拷到 ECS 本地 `/opt/learning-cloud/download/`**（nginx 实际从这里取文件，不是直接读 OSS）。

### 5.1 Windows（`publish-update.py` 一步到位 OSS + 登记）
```bash
PY=C:/Users/79734/.workbuddy/binaries/python/envs/default/Scripts/python.exe
$PY scripts/publish-update.py --dist dist \
  --register <ver> --release-notes "<更新说明>" \
  --admin-token <从ECS现取的ADMIN_TOKEN>
# 作用：
#   - 上传 dist/latest.yml + 学习伙伴 Setup <ver>.exe + .blockmap 到 OSS aixuexihao-app/learning-app/
#   - POST /api/version 登记 <ver>（download_url 指向 OSS 直链）
```
> 取 ADMIN_TOKEN：`$PY scripts/aliyun-run.py "grep ADMIN_TOKEN /opt/learning-cloud/.env"`

### 5.2 🔴 致命坑：publish-update.py 只传 OSS，不拷 ECS
公网 `/download/` 由 ECS nginx 从 **本地目录** `/opt/learning-cloud/download/` 提供，**不是直接读 OSS**。Windows 文件上传 OSS 后，仍必须再 curl 拷到 ECS 本地，否则 `/download/latest.yml` 显示旧版、Windows 客户端走旧下载链。
```bash
# 用 aliyun-run.py 让 ECS 从 OSS 公共直链把 Windows 三件套拉到本地目录：
$PY scripts/aliyun-run.py 'bash -c "set -e; mkdir -p /opt/learning-cloud/download;
B=https://aixuexihao-app.oss-cn-hangzhou.aliyuncs.com/learning-app;
for f in latest.yml 学习伙伴%20Setup%20<ver>.exe 学习伙伴%20Setup%20<ver>.exe.blockmap; do
  curl -fsSL -o /opt/learning-cloud/download/$(printf %s \"$f\" | sed \"s/%20/ /g\") \"$B/$f\";
done;
ls -la /opt/learning-cloud/download | tail -5"'
```

### 5.3 Linux / macOS（CI 产物 → OSS → ECS）
```bash
# 1) 上传 CI 产物到 OSS（oss2 脚本，路径同 Windows）：
#    deb / AppImage / *.dmg  →  aixuexihao-app/learning-app/
# 2) 生成 latest-linux.yml / latest-mac.yml（列出 deb / dmg 路径 + sha512 + size）
# 3) 同样用 aliyun-run.py 把 deb/AppImage/dmg/latest-*.yml curl 拷到 ECS 本地
```
> Linux/Mac 的 in-app 自动升级目前**未做平台路由**（download_url 仍指向 Windows exe），本期只发布安装包、不接代码。新装用户走完整安装包；旧版 Mac/Linux 客户端不会自动收到差量升级。

### 5.4 文件名空格必须 `%20`
Windows 安装包名含空格（`学习伙伴 Setup 0.1.9.exe`）。ECS 上 curl 的 URL 空格必须编码为 `%20`，否则 curl 返回 `000`、文件 size=0；OSS key 本身也用 `%20`。

---

## 6. 公网验证

```bash
curl -s https://www.aixuexihao.top/download/latest.yml | head -4        # version: <ver>
curl -sI "https://www.aixuexihao.top/download/学习伙伴%20Setup%20<ver>.exe" | head -3  # HTTP/2 200 + content-length
curl -s https://www.aixuexihao.top/api/version | head -2               # version: <ver>
```

---

## 7. 收尾：提交 + 双远端 push + tag

```bash
git add package.json server/src/routes/version.ts server/package.json server/dist/server.cjs
git commit -m "release: 客户端 <ver> / 服务端 <sver> 打包发布"
git push origin master          # gitee
git push github master          # GitHub（触发 Actions 的前提）
git tag v<ver> && git push origin v<ver> && git push github v<ver>
```
> ⚠️ **GitHub Push Protection**：测试代码里别塞像云厂商密钥的串（曾因假值 `AKID...` 被拒）。真实 AK 在 `aliyun-aksk.txt`（应已被 .gitignore 忽略，勿提交）。

---

## 8. 已知坑速查（重点）

1. **NODE_OPTIONS 沙箱 shim**：`npm run dist:win` 前 `unset NODE_OPTIONS`。
2. **Defender 锁 `dist/win-unpacked`**：换全新 output 目录（如 `dist-release-0XX`）。
3. **OSS 公共读**：AK 只有上传权限，用公共直链（`https://bucket.endpoint/learning-app/<file>`）；签名 URL 全 403。
4. **🔴 publish-update.py 只传 OSS 不拷 ECS**：Windows 三件套必须再 curl 拷到 ECS `/opt/learning-cloud/download/`（`/download/` 实际从这里取）。0.1.9 曾漏拷 Windows → feed 显示旧版。
5. **curl 空格 `%20`**：Windows 文件名含空格，URL 必须 `%20` 编码，否则 `000`/size=0。
6. **RunCommand 中文/空格文件名**：`-o` 输出路径用单引号包裹。
7. **GitHub Actions**：`npm ci --legacy-peer-deps`；mac 必须按 arch rebuild `ffmpeg-static`；mac YAML matrix 两 arch → 两次运行（x64/arm64 dmg）。
8. **服务端 pkg 废弃**：用 `node /opt/learning-server/server.cjs`；`learning-server.service` 的 ExecStart 需从 pkg 路径改回 `node`。
9. **服务端 import_meta.url 补丁**：`build.mjs` 已自动打，勿删。
10. **201 客户端 GUI 无法 SSH 重启**：`dpkg -i` 后须在 201 **本地**手动重启客户端。
11. **ADMIN_TOKEN 现取现用**，不硬编码。
12. **两服务名易混**：`learning-server`（业务，201）vs `learning-cloud`（公网源，ECS）。

---

## 9. 发布后待办

- 已装旧版 Windows 客户端启动即弹升级（electron-updater 走 `/download/latest.yml` 差量）。
- 201 上需人工重启 GUI 客户端；服务端自动 migrate 新表（如 `study_plan_items`），无需手工建表。
- Linux/Mac 仅提供完整安装包，客户端内自动升级暂未接平台路由。

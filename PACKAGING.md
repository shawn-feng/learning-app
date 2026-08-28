# 打包记录与操作细节（PACKAGING）

> 本文档记录「学习伙伴」桌面应用（客户端 + 服务端）的**当前打包/发版流程**。
> 应用信息：`name=learning-app`，`productName=学习伙伴`，`appId=com.learning-app.desktop`，`executableName=xuexihub`。
> 最后更新：2026-08-28（v0.1.3 全平台发布）

---

## 1. 跨平台打包能力（现状）

| 平台 | 构建方式 | 产物 |
|------|---------|------|
| Windows (nsis) | **本机** `npm run dist:win` | `学习伙伴 Setup <v>.exe` + `.blockmap` + `latest.yml` |
| Ubuntu 24 (x64) | **GitHub Actions** `build-linux.yml`（ubuntu-latest） | `learning-app_<v>_amd64.deb` + `学习伙伴-<v>.AppImage` |
| macOS (dmg) | **GitHub Actions** `build-mac.yml`（macos-latest，x64/arm64 双 job） | `学习伙伴-<v>-x64.dmg` + `学习伙伴-<v>-arm64.dmg` |
| Web 端 | ❌ 不可 | 全应用走 IPC（contextBridge），无浏览器 HTTP 入口 |

**触发方式**：push `v*` tag 到 GitHub（`shawn-feng/learning-app`）同时触发 Linux + macOS 两个 workflow（`on: workflow_dispatch + push: tags: ['v*']`）；普通 push master 不触发。

**GitHub 仓库与凭据**：远程 `github` = `git@github.com:shawn-feng/learning-app.git`（deploy key `~/.ssh/github_learning_app`）；gh CLI 已认证（`gh auth status` 可查）。

---

## 2. 一次完整发版流程（v0.x.y）

### 2.1 升版本号 + 配置检查

```bash
# 修改 package.json 的 version（如 0.1.3）
# 确认 build 配置：
#   - build.directories.output = "dist"（⚠️ CI 硬编码 dist/*.deb、dist/*.dmg，勿改）
#   - build.publish.url = https://www.aixuexihao.top/download/（升级渠道）
#   - linux: deb + AppImage、x64；mac: dmg x64+arm64 双架构
```

### 2.2 本机打包 Windows（发布升级渠道用）

```bash
# ⚠️ 先清空 dist（避免 electron-builder 删除旧目录被 safe-delete 拦截）
mv dist/win-unpacked legacy/build-tmp/ 2>/dev/null; ls dist/ | grep -v win-unpacked

export ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm run dist:win
# 产物：dist/学习伙伴 Setup <v>.exe + .blockmap + latest.yml
```

### 2.3 发布到升级渠道（阿里云 ECS / OSS，脚本见 §3）

```bash
# ① OSS 中转上传（bucket aixuexihao-app，public-read）
python scripts/publish-update.py --dist dist
# ② 生成签名 URL（900 秒有效，尽快执行下一步）
python scripts/gen-signed-urls.py dist 900
# ③ 云助手：服务器 curl 签名 URL 覆盖 /opt/learning-cloud/download/
python scripts/aliyun-run.py "$(cat dist/publish-cmd.sh 生成的覆盖命令)" --name publish-<v>
# ④ 云端登记版本（ADMIN_TOKEN 在服务器 /opt/learning-cloud/.env，token 不出服务器）
python scripts/aliyun-run.py '<curl POST http://127.0.0.1:8000/api/version ...>' --name reg-<v>
```

> ⚠️ ②③ 之间签名 URL 会过期：建议用 python 脚本读 `dist/signed-urls.json` 拼 shell 一步执行（见 §3 示例）。

### 2.4 触发 Linux + macOS 构建（GitHub Actions）

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_learning_app -o StrictHostKeyChecking=no" git push github master
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_learning_app -o StrictHostKeyChecking=no" git tag v<v>
GIT_SSH_COMMAND="ssh -i ~/.ssh/github_learning_app -o StrictHostKeyChecking=no" git push github v<v>

# 监控：gh run list / gh run watch <run-id> --interval 20
```

### 2.5 下载产物

```bash
# ⚠️ Windows 上 gh run download 静默失败，用 curl.exe + token 下载 artifact zip
TOKEN=$(gh auth token)
for NAME in linux-x64-installers macos-dmg-x64 macos-dmg-arm64; do
  ART_ID=$(gh api "repos/shawn-feng/learning-app/actions/artifacts?per_page=20" --jq ".artifacts[] | select(.name==\"$NAME\" and .expired==false) | .id" | head -1)
  /c/Windows/System32/curl.exe -s -L --max-time 900 \
    -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" \
    -o ".tmp-art/$NAME.zip" \
    "https://api.github.com/repos/shawn-feng/learning-app/actions/artifacts/$ART_ID/zip"
  python3 -c "import zipfile; zipfile.ZipFile('.tmp-art/$NAME.zip').extractall('dist-<平台目录>')"
done
```

产物归档约定：`dist-ubuntu/`（deb+AppImage）、`dist-mac/`（x64/arm64 dmg）——已 gitignore，不入库。

### 2.6 验证升级链路（公网）

```bash
curl -s https://www.aixuexihao.top/download/latest.yml | head -4    # 应显示新 version
curl -s https://www.aixuexihao.top/api/version                       # 应返回新 version + download_url
curl -s -r 0-1023 -o /dev/null -w "%{http_code}" "https://www.aixuexihao.top/download/<安装包 URL 编码>"  # 206
```

---

## 3. 发布工具链（scripts/）

AK/SK 全部自动从仓库根 `aliyun-aksk.txt` 读取（accessKeyId / accessKeySecret）：

| 脚本 | 用途 |
|------|------|
| `publish-update.py` | 上传 latest.yml + *.exe + *.exe.blockmap 到 OSS bucket `aixuexihao-app`（`learning-app/` 前缀）；`--register <v> --admin-token` 可登记版本 |
| `gen-signed-urls.py <dist目录> [秒]` | 生成 3 个文件的 OSS 签名 URL → `dist/signed-urls.json` |
| `aliyun-run.py "<shell命令>" [--timeout 秒]` | 阿里云 ECS 云助手 RunCommand 通用执行（实例 `i-bp15zfctbt147ktl39pk`，cn-hangzhou），等待并输出结果 |

**服务器覆盖命令生成示例**（读 signed-urls.json 拼 shell）：

```bash
python3 - << 'EOF'
import json
urls = json.load(open('dist/signed-urls.json', encoding='utf-8'))
lines = ['set -e', 'cd /opt/learning-cloud/download']
for name, url in urls.items():
    lines.append(f"curl -fsSL '{url}' -o '{name}'")
lines += ['ls -la', 'head -4 latest.yml']
open('dist/publish-cmd.sh', 'w', encoding='utf-8').write('\n'.join(lines))
EOF
python scripts/aliyun-run.py "$(cat dist/publish-cmd.sh)" --name publish-<v> --timeout 300
```

**云端登记版本示例**（在服务器内读 .env，token 不出服务器）：

```bash
python scripts/aliyun-run.py '
ADMIN_TOKEN=$(grep "^ADMIN_TOKEN=" /opt/learning-cloud/.env | cut -d= -f2- | tr -d "\"")
curl -sS -X POST http://127.0.0.1:8000/api/version \
  -H "Content-Type: application/json" -H "X-Admin-Token: $ADMIN_TOKEN" \
  -d "{\"version\":\"<v>\",\"release_date\":\"<date>\",\"release_notes\":\"<notes>\",\"download_url\":\"https://www.aixuexihao.top/download/<安装包URL编码>\",\"min_version\":\"0.1.0\"}"
' --name reg-<v>
```

---

## 4. 产物清单与安装（v0.1.3 参考）

| 产物 | 大小 | 安装 |
|------|------|------|
| `dist/学习伙伴 Setup 0.1.3.exe` | 173MB | 双击安装；升级走 electron-updater 差量 |
| `dist-ubuntu/learning-app_0.1.3_amd64.deb` | 140MB | `sudo dpkg -i <deb>` |
| `dist-ubuntu/学习伙伴-0.1.3.AppImage` | 187MB | `chmod +x` 后直接运行 |
| `dist-mac/学习伙伴-0.1.3-x64.dmg` | 171MB | Intel Mac；未签名，首次需右键→打开 或 `sudo xattr -rd com.apple.quarantine` |
| `dist-mac/学习伙伴-0.1.3-arm64.dmg` | 169MB | Apple Silicon；同上 |

服务端打包（独立产物）：
- `server/dist/learning-server`（Linux x64，75MB，`node scripts/pkg.mjs linux`）
- `server/dist/learning-server.exe`（Windows，58MB，`node scripts/pkg.mjs win`）
- cloud-service：源码部署（ECS 上 systemd `learning-cloud.service`，无需打包）

---

## 5. 踩坑清单（已解决）

| # | 现象 | 根因 | 解决 |
|---|------|------|------|
| 1 | 本机 `npm run dist:win` 报 safe-delete 删除 dist/win-unpacked 失败 | WorkBuddy 环境回收站不可用，删除被拦 | 先 `mv dist/win-unpacked legacy/build-tmp/` 再打包；或临时改 output 目录 |
| 2 | `gh run download` / PowerShell 下载 artifact 失败或截断 | Windows 下 gh 静默 exit 1；Invoke-WebRequest 截断（327MB→172MB） | 用 `/c/Windows/System32/curl.exe` + `gh auth token` 下载 zip |
| 3 | 阿里云云助手 RunCommand 报 InvalidInstance.NotFound | SDK `set_InstanceIds` 传了字典数组 | 必须传**字符串数组** `['i-xxx']` |
| 4 | `npm ci` peer 冲突失败 | `typescript@7` 与 `edge-tts` 冲突 | 用 `--legacy-peer-deps` |
| 5 | mac universal dmg 合并报错 | `@earendil-works/pi-tui` 原生 `.node` 双架构冲突 | 改**两个独立单架构 dmg**（x64/arm64 分开构建） |
| 6 | Intel Mac 报"该 Mac 不支持这个应用" | 装了 arm64-only 旧包 | 装 `*-x64.dmg`；CI 双 job 已各自产出 |
| 7 | mac 语音报"找不到 ffmpeg" | ffmpeg-static 二进制架构与 dmg 不匹配 | build-mac.yml matrix 已固化：删旧二进制 + `npm_config_arch=<arch> npm rebuild ffmpeg-static`；asarUnpack 解包 |
| 8 | mac 麦克风从不弹授权窗 | Info.plist 缺 `NSMicrophoneUsageDescription` | `build.mac.extendInfo` 加两条声明 + `systemPreferences.askForMediaAccess("microphone")`（已固化） |
| 9 | deb 构建报缺字段 | 缺 `homepage`/`author`/`linux.maintainer` | package.json 已补齐 |
| 10 | 打包警告 `file source doesn't exist from=templates` | templates/ 已删除（废弃 skill），package.json 残留引用 | 已移除 build.files / extraResources 里的 templates 引用 |

---

## 6. 打包配置要点（package.json build）

- `directories.output = "dist"`（**勿改**，CI 与流程依赖）
- `publish = { provider: "generic", url: "https://www.aixuexihao.top/download/" }`（升级渠道）
- `linux`: `deb` + `AppImage`、`x64`、`executableName: xuexihub`、`maintainer`
- `mac`: `dmg` x64+arm64 双 target、`artifactName: ${productName}-${version}-${arch}.${ext}`、`minimumSystemVersion: 10.15`、extendInfo 麦克风声明；**不写 identity**（ad-hoc 签名）
- `asarUnpack`: `**/node_modules/ffmpeg-static/**`
- `electronDownload.mirror = https://npmmirror.com/mirrors/electron/`

运行环境变量（可选覆盖，默认公网）：
- `CLOUD_API_URL` → 默认 `https://www.aixuexihao.top`（认证/license）
- `UPDATE_FEED_URL` → 默认 `https://www.aixuexihao.top/download/`（自动更新 feed）

用户数据路径（打包态）：`userData/app-data`（Windows `%APPDATA%/学习伙伴/app-data`、Linux `~/.config/learning-app/app-data`）——升级不动 userData，无需迁移。

---

## 7. 远程构建机（Linux 兜底，GitHub Actions 不可用时）

| 项 | 值 |
|----|----|
| IP / 用户 / 密码 | `192.168.1.201` / `shanshan` / `123456`（局域网测试机，勿用于公网） |
| 工作目录 | `/home/shanshan/pi`（git 仓库，跟踪 GitHub master） |
| 工具 | PuTTY `plink` / `pscp`，hostkey `SHA256:u90140y+d4butWm1tF/Jlsx6CvNO9AoPE+bxW2R5nK4` |

```bash
plink -ssh -hostkey "SHA256:u90140y+d4butWm1tF/Jlsx6CvNO9AoPE+bxW2R5nK4" shanshan@192.168.1.201 -pw 123456 \
  "cd /home/shanshan/pi && git fetch origin master && git checkout -f -B master origin/master && npm install --legacy-peer-deps && rm -rf out dist && npm run dist:linux"
```

> 中文文件名经 pscp 传输会乱码，需先 `mv` 为 ASCII 名再传/拉，本地改回。

---

## 8. 发版检查清单

- [ ] `package.json` version 已升；`build.directories.output=dist`；publish.url 正确
- [ ] 本机 Windows 打包 → `dist/` 产物齐全（exe + blockmap + latest.yml）
- [ ] OSS 中转 → 签名 URL → 云助手覆盖服务器 `/download/` → 登记 `/api/version`（顺序执行，签名 900s 过期）
- [ ] `git push github master` + `git tag v<v>` + `git push github v<v>` → 两个 workflow 触发
- [ ] Linux / mac x64 / mac arm64 三个 job 全部 success
- [ ] 产物下载到 `dist-ubuntu/`、`dist-mac/`（curl.exe + token）
- [ ] 公网验证：`latest.yml`、`/api/version`、安装包 206

# 打包发布操作手册（PACKAGING）

> 每次发布客户端新版本按本文档操作。流程经 0.1.4 / 0.1.5 / 0.1.6 实践验证（0.1.6 最完整，含全部踩坑）。
> 目标环境：Windows 本机打包 Windows 安装包；Linux/macOS 包由 GitHub Actions 自动构建。

## 0. 前置

| 项 | 说明 |
|---|---|
| 仓库 remote | `origin` = gitee（nanchang-um-um-network/learning-partner），`github` = GitHub（shawn-feng/learning-app，Actions 在此） |
| 发布源 | 自有服务器 `https://www.aixuexihao.top/download/`（FastAPI StaticFiles + Nginx），electron-updater feed 指向这里 |
| OSS 中转 | bucket `aixuexihao-app`（**公共读**），AK/SK 在仓库根 `aliyun-aksk.txt`（空格分隔：`accessKeyId xxx`） |
| 云服务器 | ECS 实例 `i-bp15zfctbt147ktl39pk`（47.96.154.226），云助手 aliyun CLI（profile learning-deploy） |
| 登记 Token | ECS 上 `/opt/learning-cloud/.env` 的 `ADMIN_TOKEN`（云助手 RunCommand 读取） |

## 1. 版本号 + 打包目录

```bash
# 改 package.json：version → 新版本号；build.directories.output → dist-release-0XX（避开 Defender 锁 dist/）
# 例：0.1.6 → output=dist-release-016
# ⚠️ 打包必须 unset NODE_OPTIONS（沙箱注入 genie-safe-delete shim 会破坏 electron-builder 清 tmp）
rm -rf dist-release-016 && unset NODE_OPTIONS && npx electron-vite build && npx electron-builder --win
# 产物：dist-release-016/latest.yml + 学习伙伴 Setup <ver>.exe + .exe.blockmap（约 5-10 分钟）
```

## 2. 上传 OSS（中转）

```bash
PY=<项目venv python>   # C:\Users\79734\.workbuddy\binaries\python\envs\default\Scripts\python.exe
# venv 需安装 oss2：$PY -m pip install oss2
$PY scripts/publish-update.py --dist dist-release-016
# → https://aixuexihao-app.oss-cn-hangzhou.aliyuncs.com/learning-app/<文件>
# ⚠️ bucket 是公共读（无需签名）；签名 URL 全 403（该 AK 只有上传权限，勿用 sign_url）
```

## 3. ECS 覆盖 /download/

```bash
# 用云助手 RunCommand 让 ECS 从 OSS 公共直链拉文件覆盖 /opt/learning-cloud/download/
# ⚠️ 中文/空格文件名：-o 输出路径必须单引号包裹；URL 必须 percent-encode（curl 对中文 URL 报 malformed）
python3 - << 'PYEOF'
import urllib.parse
names = ["latest.yml", "学习伙伴 Setup <ver>.exe", "学习伙伴 Setup <ver>.exe.blockmap"]
base = "https://aixuexihao-app.oss-cn-hangzhou.aliyuncs.com/learning-app/"
sh = ["#!/bin/bash", "set -e", "mkdir -p /opt/learning-cloud/download"]
for n in names:
    sh.append(f"curl -fsSL -o '/opt/learning-cloud/download/{n}' '{base}{urllib.parse.quote(n)}'")
sh.append("ls -la /opt/learning-cloud/download | tail -4")
open("ecs-copy.sh", "w", encoding="utf-8").write("\n".join(sh))
PYEOF
aliyun ecs RunCommand --Type RunShellScript --CommandContent "$(cat ecs-copy.sh)" \
  --InstanceId.1 i-bp15zfctbt147ktl39pk --Timeout 180 --RegionId cn-hangzhou
# 查结果：DescribeInvocationResults --InvokeId <返回的 InvokeId>（输出 base64，需解码）
```

## 4. 登记版本（/api/version）

```bash
# ADMIN_TOKEN 从 ECS 读取：云助手 RunCommand 执行 grep ADMIN_TOKEN /opt/learning-cloud/.env
$PY scripts/publish-update.py --dist dist-release-016 \
  --register <ver> --release-notes "<更新说明>" \
  --admin-token <token>
# 成功：云端登记 <ver>: 200 {"success":true,...}
```

## 5. 公网验证

```bash
curl -s https://www.aixuexihao.top/download/latest.yml | head -4   # version: <ver>
curl -s https://www.aixuexihao.top/api/version | head -2           # version: <ver>
```

## 6. 收尾：恢复配置 + 提交 + 双远端 push + tag

```bash
# package.json output 改回 dist
git add package.json && git commit -m "release: <ver> 打包发布（output 恢复 dist）"
git push origin master        # gitee
git push github master        # GitHub（触发 Actions 的前提是 push 到 GitHub）
git tag v<ver> && git push origin v<ver> && git push github v<ver>
```

## 7. GitHub Actions（linux/mac 自动构建）

```bash
gh run list --repo shawn-feng/learning-app --limit 3   # 观察 v<ver> 的 Build Linux/macOS
# 成功后下载产物归档：dist-ubuntu-0XX / dist-mac-0XX（Actions artifact）
```

## 8. 已知坑速查

1. **OSS 签名 URL 403**：AK 只写权限 → 用公共读直链（bucket 已公共读，直接 `https://bucket.endpoint/learning-app/<file>`）。
2. **RunCommand 中文/空格文件名**：`-o` 路径单引号 + URL percent-encode；否则 `curl: (3) URL rejected` 或按空格拆命令。
3. **Git Bash `/tmp` 与 Windows python 不通**：临时文件放项目目录（如 `.signed-urls.tmp`），用完删除。
4. **NODE_OPTIONS 沙箱 shim**：打包前 `unset NODE_OPTIONS`；`rm -rf dist-release-0XX` 可能被 safe-delete 拦（244+ 文件阈值）——被拦后本地保留即可（产物已上传，且加 .gitignore 忽略 `dist-release-*/`）。
5. **Defender 锁 dist/win-unpacked**：每次用新目录 `dist-release-0XX`。
6. **登记 token**：ADMIN_TOKEN 每次从 ECS `.env` 现取，不要硬编码。

## 9. 发布后待办

- Actions 完成后下载 linux/mac 产物归档。
- 已装旧版客户端启动即弹升级（electron-updater 走 `/download/latest.yml` 差量）；新装走完整安装包。

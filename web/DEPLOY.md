# 部署指南（网页端 + 后台服务端）

## 推荐形态：单端口同源部署

服务端已内置静态托管：**`web/dist` 存在时自动托管网页**，一个端口（默认 8788）同时服务网页与 API，无需 Nginx，也无跨域问题（服务端无 CORS，同源是硬约束）。

```bash
# 1. 构建网页端（仓库根目录执行）
npm run web:build           # 产出 web/dist/

# 2. 启动服务端（构建产物或开发模式均可）
cd server
npm run build && npm start  # 生产：node dist/server.cjs
# 或
npm run dev                 # 开发调试：tsx src/index.ts

# 3. 访问
#   本机：        http://localhost:8788/
#   局域网设备：  http://<本机内网IP>:8788/   （服务端监听 0.0.0.0，见启动日志）
```

启动日志出现 `web frontend hosting enabled` 即托管生效；`web/dist` 不存在时服务端行为与纯 Electron 后端完全一致（零影响）。

## 常用操作

| 场景 | 操作 |
|---|---|
| 改了前端代码 | `npm run web:build` 后刷新浏览器即可（服务端无需重启，静态文件即时生效） |
| 改了服务端代码 | 重启服务端 |
| 前端改动调试中 | 用开发模式 `npm run web:dev`（5173，`/api` 自动代理到 8788），发布前再 build |

## ⚠️ 语音功能与 HTTPS

浏览器安全策略：**非 `localhost` 页面必须 HTTPS 才能使用麦克风**（语音输入、发音评测、场景课录音）。部署到局域网 IP 供其他设备访问时：

- 网页、文字对话、资料、考核（打字部分）、积分等全部功能正常；
- 语音相关功能会被浏览器禁用。解决方式任选：
  1. 在本机用 `http://localhost:8788` 使用（麦克风豁免）；
  2. 前置一层带证书的反向代理（Caddy 自动 HTTPS 最简单），域名解析到服务器；
  3. 仅管理用设备：Chrome 地址栏 `chrome://flags/#unsafely-treat-insecure-origin-as-secure` 加入 `http://<服务器IP>:8788` 后重启浏览器。

## ✅ 已部署：201 局域网 HTTPS（2026-09-16）

201 上已用 **Caddy** 起了 HTTPS 反代（服务端与 Electron 客户端零改动，继续走 8788 HTTP）：

- **入口：`https://192.168.1.201:8443`**（Caddy `tls internal` 自签 CA 给 IP 签证书，SAN 含 `IP:192.168.1.201`）
- 配置：`/etc/caddy/Caddyfile`（`tls internal` + `reverse_proxy 127.0.0.1:8788`），systemd 服务 `caddy`
- **设备首次使用需导入 CA 根证书**（每设备一次，之后浏览器完全信任无警告）：
  - 证书已备份：`web/deploy/learning-201-root.crt`（`CN=Caddy Local Authority`，有效期至 2036）
  - 也可从 201 下载：`/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt`
  - Windows：双击 crt → 安装证书 → 本地计算机 → 「将所有的证书都放入下列存储」→ 受信任的根证书颁发机构
  - Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书（部分机型需在 Chrome 单独开启「用户证书」信任）
  - iOS：AirDrop/文件分享 crt → 设置 → 已下载的描述文件安装 → 通用 → 关于本机 → 证书信任设置 → 开启完全信任
  - 导入后**重启浏览器**，访问 `https://192.168.1.201:8443`，地址栏无警告、麦克风可用
  - **macOS**：双击 crt → 钥匙串访问选「系统」添加 → 双击该证书 → 信任栏改为「始终信任」；或命令行 `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain <crt路径>`。Firefox 例外：不走系统钥匙串，需在 Firefox 设置 → 证书 → 证书颁发机构里单独导入并勾选信任

## 备选形态：Nginx 反向代理

若已有 Nginx/需要多站点，可改为前端独立托管 + API 反代（同样满足同源）：

```nginx
server {
    listen 80;
    root /path/to/pi/web/dist;
    location /api { proxy_pass http://127.0.0.1:8788; }
}
```

此时移除 `web/dist` 可关掉服务端内置托管（二者互斥使用，避免混淆）。

## 环境要求

- Node ≥ 22（服务端用 `node:sqlite`，与 Electron 版同一约束，见根 `package.json`）
- 服务端数据目录 `server/data/`（与 Electron 客户端共用同一后端，无需迁移）

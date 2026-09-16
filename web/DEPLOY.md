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

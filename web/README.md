# 学习伙伴 · Web 前端

纯浏览器版「学习伙伴」，与 Electron 桌面客户端**共享同一份渲染层代码**（`../src`），通过 `window.api` Web 适配层（shim）对接同一服务端，机制与客户端一致。设计方案见 `../WEB-前端设计方案与实施规划-2026-09-15.md`。**部署见 [DEPLOY.md](DEPLOY.md)**（推荐：服务端单端口同源托管，`npm run web:build` 后直接访问 8788）。

## 启动

前置：服务端已运行（默认 `http://127.0.0.1:8788`，见 `../server`）。

```bash
# 开发（http://localhost:5173，/api 经 vite 代理转发到 8788）
npm --prefix web run dev          # 或仓库根目录 npm run web:dev

# 生产构建（web/dist/）
npm --prefix web run build
```

- **服务端地址**：默认同源（vite 代理）。可在登录页修改（存 `localStorage.web.serverBase`）。
- **生产部署**：与 API 同源放置（反向代理 `/api` → 8788 并托管 `web/dist`），或后续在 server 加静态托管。

## 架构

```
浏览器 ── React 渲染层（复用 ../src，零路由状态机）
          └── window.api（web/src/shim，与 electron/preload.ts 同签名，199 方法）
                ├── HTTP   fetch + Bearer（core/server-fetch.ts）
                ├── SSE    agent/parent-agent 事件流（core/sse.ts，含轮末缓冲）
                └── 浏览器  speechSynthesis / SpeechRecognition / MediaRecorder / WebAudio
服务端 ── Fastify :8788（Phase 0 增补：二进制路由 ?token= + /materials/doc HTML 网关）
```

渲染层共享分支仅 5 处，全部 `window.api.__web` 守卫（Electron 路径零改动）：
`MaterialsPanel`（资料 doc URL + 点读 TTS）、`ChatWindow`（朗读/听写）、`Learn`（提醒播报）、`useAudioRecorder`（并行听写）、`TitleBar`（隐藏窗口按钮）。

## 环境差异（相对 Electron 客户端）

- 离线不可用（业务数据真源在服务端；登录态许可仍本地缓存 + 降级放行）。
- TTS 为系统语音（speechSynthesis），非 edge-tts 音色。
- STT 依赖 Chrome/Edge（Web Speech API）；不支持时语音输入返回明确错误，不影响其他功能。
- 提醒/配置同步轮询仅在页面存活时运行；每日总结、积分结算等服务端 worker 本就是真源，不受影响。

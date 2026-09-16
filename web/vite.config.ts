import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web 版 Vite 配置（设计方案 §4）：
// - 渲染层源码直接复用仓库根的 ../src（App.tsx 及全部组件），本目录只放 Web 入口 + shim。
// - dev 期 /api 经 Vite proxy 转发到本地服务端（服务端无 CORS，必须同源代理）。
export default defineConfig({
  plugins: [react()],
  // 强制 react/react-dom 全局单实例：渲染层复用 ../src（项目根之外），构建时其内部对 react 的
  // 解析会 walk-up 到仓库根 node_modules，与 web/node_modules 形成「两份 React 实例」→
  // 生产包运行时抛 Invalid hook call/useState of null。dev 由 optimizeDeps 统一掩盖，build 必配。
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  // 显式纳入全部依赖做首批评估优化：避免「首访时发现新依赖 → 二次优化分批」
  // 产生两个 hash 批次（lucide-react 旧批次内嵌另一份 react）导致 Invalid hook call。
  optimizeDeps: {
    include: [
      "react",
      "react/jsx-dev-runtime",
      "react/jsx-runtime",
      "react-dom",
      "react-dom/client",
      "lucide-react",
      "react-markdown",
      "remark-gfm",
      "bcryptjs",
    ],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8788",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});

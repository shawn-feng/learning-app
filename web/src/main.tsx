import React from "react";
import ReactDOM from "react-dom/client";
import { installWebApi } from "./shim/install";
// 直接复用 Electron 客户端的渲染层（App 五态状态机 + 全部组件 + styles.css）
import App from "../../src/App";

// 先装 window.api（Web 适配层），再挂载 React —— 渲染层代码零改动
installWebApi();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

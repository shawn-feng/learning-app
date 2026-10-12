import React from "react";
import ReactDOM from "react-dom/client";
import { installWebApi } from "./shim/install";
import { handleDouyinAuthRedirect } from "./shim/domains/auth";
// 直接复用 Electron 客户端的渲染层（App 五态状态机 + 全部组件 + styles.css）
import App from "../../src/App";

// 先装 window.api（Web 适配层），再挂载 React —— 渲染层代码零改动
installWebApi();

// 抖音登录同 tab 回跳（桥页带 #auth-code 回来）：启动时先完成换会话，再挂载界面
handleDouyinAuthRedirect().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
});

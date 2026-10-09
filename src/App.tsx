import { useState, useEffect } from "react";
import "./styles.css";
import TitleBar from "./components/TitleBar";
import ParentLogin from "./pages/ParentLogin";
import TaskGate from "./pages/TaskGate";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Learn from "./pages/Learn";

declare global {
  interface Window {
    api: any;
  }
}

type View = "loading" | "parent-login" | "task-gate" | "home" | "dashboard" | "learn";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [currentChild, setCurrentChild] = useState<any>(null);
  const [parentEmail, setParentEmail] = useState("");
  // 抖音登录后的「任务门禁」：无权益时引导去个人中心完成任务，轮询解锁后进主页
  const [taskGate, setTaskGate] = useState<{ email: string; meUrl: string } | null>(null);

  useEffect(() => {
    window.api.authCheck().then((result: any) => {
      if (result.authenticated) {
        // 凭证有效期内，跳过登录环节，直接进入家庭主页
        setParentEmail(result.license?.email || "");
        setView("home");
      } else {
        setView("parent-login");
      }
    });
  }, []);

  let content: React.ReactNode;
  switch (view) {
    case "loading":
      content = <div className="login-page">正在验证身份…</div>;
      break;
    case "parent-login":
      content = (
        <ParentLogin
          onDouyin={(result) => {
            if (result.needs_task) {
              // 无权益 → 任务门禁：去个人中心完成任务，轮询解锁后自动进主页
              setTaskGate({ email: result.email, meUrl: result.me_url });
              setView("task-gate");
              return;
            }
            setParentEmail(result.email);
            setView("home");
          }}
        />
      );
      break;
    case "task-gate":
      content = (
        <TaskGate
          email={taskGate?.email ?? ""}
          meUrl={taskGate?.meUrl ?? ""}
          onUnlocked={(email) => {
            setParentEmail(email);
            setTaskGate(null);
            setView("home");
          }}
          onBack={() => {
            setTaskGate(null);
            setView("parent-login");
          }}
        />
      );
      break;
    case "home":
      content = (
        <Home
          email={parentEmail}
          onEnterParent={() => setView("dashboard")}
          onEnterChild={(child) => {
            setCurrentChild(child);
            setView("learn");
          }}
          onLogout={() => {
            window.api.authLogout();
            setView("parent-login");
          }}
        />
      );
      break;
    case "dashboard":
      content = (
        <Dashboard
          email={parentEmail}
          onEnterChildMode={() => setView("home")}
          onLogout={() => {
            window.api.authLogout();
            setView("parent-login");
          }}
        />
      );
      break;
    case "learn":
      content = (
        <Learn
          child={currentChild}
          onExit={() => {
            setCurrentChild(null);
            setView("home");
          }}
        />
      );
      break;
    default:
      content = null;
  }

  return (
    <div className="app-root">
      {/* ISSUE-158 续：panelToggles 在家长中心与孩子学习页显示（全屏右侧的左/右栏折叠按钮，事件协议共用） */}
      <TitleBar panelToggles={view === "dashboard" || view === "learn"} />
      <div className="app-content">{content}</div>
    </div>
  );
}

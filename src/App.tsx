import { useState, useEffect } from "react";
import "./styles.css";
import TitleBar from "./components/TitleBar";
import ParentLogin from "./pages/ParentLogin";
import Home from "./pages/Home";
import Dashboard from "./pages/Dashboard";
import Learn from "./pages/Learn";

declare global {
  interface Window {
    api: any;
  }
}

type View = "loading" | "parent-login" | "home" | "dashboard" | "learn";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [currentChild, setCurrentChild] = useState<any>(null);
  const [parentEmail, setParentEmail] = useState("");

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
      content = <div className="login-page">加载中...</div>;
      break;
    case "parent-login":
      content = (
        <ParentLogin
          onLogin={(email) => {
            setParentEmail(email);
            setView("home");
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
          onLogout={() => setView("parent-login")}
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
      <TitleBar />
      <div className="app-content">{content}</div>
    </div>
  );
}

import { useState, useEffect } from "react";
import "./styles.css";
import "./duolingo.css";
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

const ME_FALLBACK_URL = "https://auth.aixuexihao.top/me";

export default function App() {
  const [view, setView] = useState<View>("loading");
  const [currentChild, setCurrentChild] = useState<any>(null);
  const [parentEmail, setParentEmail] = useState("");
  // 抖音登录后的「任务门禁」：无权益时引导去个人中心完成任务，轮询解锁后进主页；
  // ISSUE-188：VIP 到期（不是登录失效）也走这里——保留登录态，完成任务即恢复，不需要重新扫码。
  const [taskGate, setTaskGate] = useState<{
    email: string;
    meUrl: string;
    /** true = 权益已到期（不是新账号待解锁）；仅影响文案 */
    expired?: boolean;
  } | null>(null);

  useEffect(() => {
    window.api.authCheck().then((result: any) => {
      if (result.authenticated) {
        // 凭证有效期内，跳过登录环节，直接进入家庭主页
        setParentEmail(result.license?.email || "");
        setView("home");
        return;
      }
      // ISSUE-188：有本地凭证但权益到期 → 任务门禁（不踢回登录页，不需要重新扫码）
      if (result.license?.is_expired) {
        setTaskGate({
          email: result.license?.email || "",
          meUrl: result.me_url || ME_FALLBACK_URL,
          expired: true,
        });
        setView("task-gate");
        return;
      }
      setView("parent-login");
    });
  }, []);

  // ISSUE-188：app 长开时也要能及时发现权益到期（每 5 分钟，仅在主页/家长中心检测，
  // 不打断正在学习的孩子）。检测同时会刷新 license，并借服务端滑动续签保活会话 JWT。
  useEffect(() => {
    if (view !== "home" && view !== "dashboard") return;
    const timer = window.setInterval(async () => {
      try {
        const r: any = await window.api.authCheck();
        if (r?.authenticated) {
          if (r.license?.email) setParentEmail(r.license.email);
          return;
        }
        if (r?.license?.is_expired) {
          setTaskGate({
            email: r.license?.email || parentEmail,
            meUrl: r.me_url || ME_FALLBACK_URL,
            expired: true,
          });
          setView("task-gate");
        }
      } catch {
        /* 网络抖动下一轮再判 */
      }
    }, 5 * 60_000);
    return () => window.clearInterval(timer);
  }, [view, parentEmail]);

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
              // 无权益/权益到期 → 任务门禁：去个人中心完成任务，轮询解锁后自动进主页
              // ISSUE-188：这里不要求重新登录/扫码，完成任务即恢复
              setTaskGate({
                email: result.email,
                meUrl: result.me_url,
                expired: result.license?.is_expired === true,
              });
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
          expired={taskGate?.expired === true}
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

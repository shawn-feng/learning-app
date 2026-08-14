import { useState } from "react";

interface Props {
  onLogin: (email: string) => void;
}

export default function ParentLogin({ onLogin }: Props) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setError("");
    if (!email || !password) {
      setError("请输入邮箱和密码");
      return;
    }
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }

    setLoading(true);
    try {
      const result =
        mode === "login"
          ? await window.api.authLogin(email, password)
          : await window.api.authRegister(email, password);

      if (result.success) {
        onLogin(email);
      } else {
        setError(result.error || "操作失败");
      }
    } catch (e: any) {
      setError(e.message || "操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>学习伙伴</h1>
        <p className="subtitle">
          {mode === "login" ? "家长登录" : "家长注册"}
        </p>

        {error && <div className="error">{error}</div>}

        <input
          type="email"
          placeholder="邮箱"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {mode === "register" && (
          <input
            type="password"
            placeholder="确认密码"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        )}

        <button onClick={handleSubmit} disabled={loading}>
          {loading ? "处理中..." : mode === "login" ? "登录" : "注册"}
        </button>

        <div
          className="switch"
          onClick={() => {
            setMode(mode === "login" ? "register" : "login");
            setError("");
          }}
        >
          {mode === "login" ? "没有账号？去注册" : "已有账号？去登录"}
        </div>
      </div>
    </div>
  );
}

import { useEffect, useState } from "react";

interface Props {
  /** 抖音扫码登录结果交由 App 处理（needs_task → 任务门禁页） */
  onDouyin: (result: any) => void;
}

/**
 * 家长登录页（2026-09-21 简化）：登录方式只有抖音扫码。
 * 注册已下线——新用户扫码即自动创建账号并登录；
 * 邮箱密码不再用于登录（家长中心密码仅用于进入家长中心验证，可扫码重置）。
 */
export default function ParentLogin({ onDouyin }: Props) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // SPLIT：服务端连接配置（纯服务端模式必需）
  const [serverUrl, setServerUrl] = useState("");
  const [serverDirty, setServerDirty] = useState(false);
  const [serverLoaded, setServerLoaded] = useState(false);

  useEffect(() => {
    window.api.serverGetConfig().then((cfg: { url?: string }) => {
      setServerUrl(cfg?.url ?? "");
      setServerLoaded(true);
    });
  }, []);

  async function handleSaveServer() {
    const result = await window.api.serverSetConfig(serverUrl.trim());
    setServerUrl(result?.url ?? "");
    setServerDirty(false);
    setError("");
  }

  async function handleDouyin() {
    setError("");
    if (!serverUrl.trim()) {
      setError("请先填写服务端地址");
      return;
    }
    if (serverDirty) {
      setError("服务端地址已修改，请先点击「保存服务端地址」");
      return;
    }
    setLoading(true);
    try {
      const result = await window.api.authDouyinLogin();
      if (!result.success) {
        setError(result.error || "抖音登录失败");
        return;
      }
      onDouyin(result);
    } catch (e: any) {
      setError(e.message || "抖音登录失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1>学习伙伴</h1>
        <p className="subtitle">家长登录</p>

        {error && <div className="error">{error}</div>}

        {/* SPLIT：服务端地址配置 */}
        <div className="server-config">
          <label>服务端地址</label>
          <div className="server-row">
            <input
              type="text"
              placeholder="如 http://192.168.1.200:8788"
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value);
                setServerDirty(true);
              }}
            />
            <button onClick={handleSaveServer} disabled={!serverDirty}>
              保存
            </button>
          </div>
          {serverLoaded && !serverUrl.trim() && (
            <div className="hint">未配置服务端地址，登录前请先填写并保存</div>
          )}
        </div>

        <button
          onClick={handleDouyin}
          disabled={loading}
          style={{ background: "#161823", color: "#fff" }}
        >
          {loading ? "等待扫码授权..." : "抖音扫码登录"}
        </button>

        <div className="hint" style={{ marginTop: 12 }}>
          新用户无需注册，扫码后自动创建账号
        </div>
      </div>
    </div>
  );
}

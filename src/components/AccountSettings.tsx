import { useState } from "react";

/**
 * 账号安全设置：修改进入家长中心的密码。
 * 凭证为当前 LAN session（登录态即权限），云端以 cloud token 落账。
 * 忘记旧密码的场景在家长中心入口弹窗走「抖音扫码重置」。
 */
export default function AccountSettings() {
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleChange() {
    setMsg("");
    setOk(false);
    if (!newPassword || newPassword.length < 8) {
      setMsg("密码至少 8 位");
      return;
    }
    if (newPassword !== confirm) {
      setMsg("两次输入的密码不一致");
      return;
    }
    setLoading(true);
    try {
      const r = await window.api.authSetPassword(newPassword);
      if (r.success) {
        setOk(true);
        setMsg("密码已更新");
        setNewPassword("");
        setConfirm("");
      } else {
        setMsg(r.error || "修改失败，请重试");
      }
    } catch (e: any) {
      setMsg(e.message || "修改失败，请重试");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 480 }}>
      <h3 style={{ marginBottom: 6 }}>修改家长密码</h3>
      <p style={{ fontSize: 13, color: "#64748b", marginBottom: 14, lineHeight: 1.6 }}>
        该密码用于进入家长中心时验证身份。忘记旧密码时，可在家长中心入口弹窗点
        「忘记密码？抖音扫码重置」，用抖音扫码确认后直接重置。
      </p>
      {msg && (
        <div style={{ marginBottom: 10, color: ok ? "#15803d" : "#b91c1c", fontSize: 13 }}>{msg}</div>
      )}
      <input
        type="password"
        placeholder="新密码（至少 8 位）"
        value={newPassword}
        onChange={(e) => setNewPassword(e.target.value)}
        style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, marginBottom: 10 }}
      />
      <input
        type="password"
        placeholder="确认新密码"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && handleChange()}
        style={{ width: "100%", padding: "10px 12px", border: "1px solid #ddd", borderRadius: 8, marginBottom: 14 }}
      />
      <button
        onClick={handleChange}
        disabled={loading}
        style={{ padding: "9px 22px", borderRadius: 8, border: "none", background: "#667eea", color: "#fff", cursor: "pointer" }}
      >
        {loading ? "保存中..." : "更新密码"}
      </button>
    </div>
  );
}

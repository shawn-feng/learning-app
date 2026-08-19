import { useState, useEffect } from "react";

interface Props {
  email: string;
  onEnterParent: () => void;
  onEnterChild: (child: any) => void;
}

// ISSUE-017: 退出登录按钮只保留在家长页（Dashboard）；主页是孩子和家长共用入口，
// 移除退出按钮避免低龄用户误操作退出家长账号。主页不再接收 onLogout prop。
export default function Home({ email, onEnterParent, onEnterChild }: Props) {
  const [children, setChildren] = useState<any[]>([]);
  const [selectedChild, setSelectedChild] = useState<any>(null);

  // 家长密码验证
  const [showParentAuth, setShowParentAuth] = useState(false);
  const [parentPassword, setParentPassword] = useState("");
  const [parentError, setParentError] = useState("");
  const [parentLoading, setParentLoading] = useState(false);

  // 孩子密码验证
  const [childPassword, setChildPassword] = useState("");
  const [childError, setChildError] = useState("");

  useEffect(() => {
    window.api.childList().then((list: any[]) => setChildren(list));
  }, []);

  async function handleParentEnter() {
    if (!parentPassword) {
      setParentError("请输入密码");
      return;
    }
    setParentLoading(true);
    setParentError("");
    const result = await window.api.authVerify(email, parentPassword);
    setParentLoading(false);
    if (result.success) {
      setShowParentAuth(false);
      setParentPassword("");
      onEnterParent();
    } else {
      setParentError(result.error || "密码错误，请重试");
    }
  }

  async function handleChildEnter() {
    if (!selectedChild) return;
    setChildError("");
    const result = await window.api.childAuth(selectedChild.childId, childPassword);
    if (result.success) {
      onEnterChild(selectedChild);
    } else {
      setChildError("密码错误，请重试");
    }
  }

  return (
    <div className="child-select home-page">
      <h1>学习伙伴</h1>
      <p style={{ color: "rgba(255,255,255,0.85)", marginTop: -20, marginBottom: 24 }}>
        选择身份进入
      </p>

      {/* 家长入口 */}
      <div className="avatars">
        <div className="avatar-card parent-card" onClick={() => { setParentPassword(""); setParentError(""); setShowParentAuth(true); }}>
          <div className="avatar">👨‍👩‍👧</div>
          <div className="name">家长</div>
          <div style={{ fontSize: 12, color: "#888" }}>家长中心</div>
        </div>

        {/* 孩子列表 */}
        {children.map((child) => (
          <div
            key={child.childId}
            className="avatar-card"
            onClick={() => {
              setSelectedChild(child);
              setChildPassword("");
              setChildError("");
            }}
            style={selectedChild?.childId === child.childId ? { border: "3px solid #ffd700" } : {}}
          >
            <div className="avatar">{child.avatar}</div>
            <div className="name">{child.name}</div>
            <div style={{ fontSize: 12, color: "#888" }}>{child.aiName}</div>
          </div>
        ))}
      </div>

      {/* 孩子密码输入 */}
      {selectedChild && (
        <>
          {childError && <div style={{ color: "#ffd700", marginTop: 12 }}>{childError}</div>}
          <input
            className="password-input"
            type="password"
            placeholder={`输入 ${selectedChild.name} 的密码`}
            value={childPassword}
            onChange={(e) => setChildPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleChildEnter()}
            autoFocus
            style={{ background: "white", color: "#333", outline: "none" }}
          />
          <button className="enter-btn" onClick={handleChildEnter}>
            进入学习
          </button>
        </>
      )}

      {/* 家长密码弹窗 */}
      {showParentAuth && (
        <div className="modal-overlay" onClick={() => setShowParentAuth(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>家长验证</h2>
            {parentError && <div style={{ color: "red", marginBottom: 12 }}>{parentError}</div>}
            <label>家长账号</label>
            <input value={email} disabled style={{ background: "#f5f5f5", color: "#888" }} />
            <label>密码</label>
            <input
              type="password"
              value={parentPassword}
              onChange={(e) => setParentPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleParentEnter()}
              autoFocus
              placeholder="请输入家长密码"
            />
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowParentAuth(false)}>取消</button>
              <button className="confirm" onClick={handleParentEnter} disabled={parentLoading}>
                {parentLoading ? "验证中..." : "进入家长中心"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

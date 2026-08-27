import { useState, useEffect } from "react";
import { Settings } from "lucide-react";

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

  // SPLIT：服务端地址配置（主页兜底入口——用户可能被本地旧凭证直接带进主页，
  // 跳过带配置区的登录页；家长中心验证又依赖服务端，故主页必须能改地址）
  const [showServerCfg, setShowServerCfg] = useState(false);
  const [serverUrl, setServerUrl] = useState("");
  const [serverDirty, setServerDirty] = useState(false);
  const [serverMsg, setServerMsg] = useState("");

  useEffect(() => {
    window.api.childList().then((list: any[]) => setChildren(list));
    window.api.serverGetConfig().then((cfg: { url?: string }) => {
      setServerUrl(cfg?.url ?? "");
    });
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
      {/* SPLIT：服务端地址设置入口（右上角，家长设置用） */}
      <button
        className="home-server-btn"
        title="服务端设置"
        onClick={() => {
          setServerMsg("");
          setShowServerCfg(true);
        }}
      >
        <Settings size={18} />
        <span>服务端设置</span>
      </button>

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
            {parentError && (
              <div style={{ color: "red", marginBottom: 12 }}>
                {parentError}
                {parentError.includes("服务端地址") && (
                  <div style={{ fontSize: 12, marginTop: 6 }}>
                    请先
                    <a
                      style={{ color: "#667eea", cursor: "pointer", textDecoration: "underline" }}
                      onClick={() => {
                        setShowParentAuth(false);
                        setServerMsg("");
                        setShowServerCfg(true);
                      }}
                    >
                      配置服务端地址
                    </a>
                    后再验证。
                  </div>
                )}
              </div>
            )}
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

      {/* SPLIT：服务端地址设置弹窗 */}
      {showServerCfg && (
        <div className="modal-overlay" onClick={() => setShowServerCfg(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>服务端设置</h2>
            <p style={{ fontSize: 13, color: "#888", lineHeight: 1.6, margin: "0 0 12px" }}>
              填写学习伙伴服务端地址（如 http://192.168.1.200:8788 或云上 https://…）。登录、数据读写、学习资料同步均经此服务端。
            </p>
            <label>服务端地址</label>
            <input
              type="text"
              placeholder="如 http://192.168.1.200:8788"
              value={serverUrl}
              onChange={(e) => {
                setServerUrl(e.target.value);
                setServerDirty(true);
                setServerMsg("");
              }}
            />
            {serverMsg && (
              <p style={{ fontSize: 13, color: "#48bb78", margin: "8px 0 0" }}>{serverMsg}</p>
            )}
            {!serverUrl && (
              <p style={{ fontSize: 13, color: "#cc7b00", margin: "8px 0 0" }}>
                尚未配置服务端地址，请填写后保存。
              </p>
            )}
            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowServerCfg(false)}>关闭</button>
              <button
                className="confirm"
                disabled={!serverDirty}
                onClick={() => {
                  window.api.serverSetConfig(serverUrl.trim()).then((r: any) => {
                    setServerUrl(r?.url ?? "");
                    setServerDirty(false);
                    setServerMsg("已保存");
                  });
                }}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

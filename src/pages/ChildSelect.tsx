import { useState, useEffect } from "react";

interface Props {
  onBack: () => void;
  onEnterChild: (child: any) => void;
}

export default function ChildSelect({ onBack, onEnterChild }: Props) {
  const [children, setChildren] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    window.api.childList().then((list: any[]) => {
      setChildren(list);
    });
  }, []);

  async function handleEnter() {
    if (!selected) return;
    setError("");
    const result = await window.api.childAuth(selected.childId, password);
    if (result.success) {
      onEnterChild(selected);
    } else {
      setError("密码错误，请重试");
    }
  }

  return (
    <div className="child-select">
      <h1>选择你的伙伴</h1>

      <div className="avatars">
        {children.map((child) => (
          <div
            key={child.childId}
            className="avatar-card"
            onClick={() => {
              setSelected(child);
              setPassword("");
              setError("");
            }}
            style={selected?.childId === child.childId ? { border: "3px solid #ffd700" } : {}}
          >
            <div className="avatar">{child.avatar}</div>
            <div className="name">{child.name}</div>
            <div style={{ fontSize: 12, color: "#888" }}>{child.aiName}</div>
          </div>
        ))}
      </div>

      {selected && (
        <>
          {error && <div style={{ color: "#ffd700", marginTop: 12 }}>{error}</div>}
          <input
            className="password-input"
            type="password"
            placeholder="请输入密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleEnter()}
            autoFocus
            style={{ background: "white", color: "#333", outline: "none" }}
          />
          <button className="enter-btn" onClick={handleEnter}>
            进入学习
          </button>
        </>
      )}

      <button
        onClick={onBack}
        style={{
          position: "absolute",
          top: 20,
          left: 20,
          padding: "10px 20px",
          background: "rgba(255,255,255,0.2)",
          color: "white",
          border: "none",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        ← 返回
      </button>
    </div>
  );
}

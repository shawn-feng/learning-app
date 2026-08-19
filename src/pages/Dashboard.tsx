import { useState, useEffect } from "react";
import AddChildModal from "../components/AddChildModal";
import ProgressView from "../components/ProgressView";
import TokenStatsPanel from "../components/TokenStatsPanel";
import Settings from "./Settings";

interface Props {
  email: string;
  onEnterChildMode: () => void;
  onLogout: () => void;
}

const AVATARS = ["🦊", "🐰", "🐻", "🦁", "🐼", "🐨", "🐯", "🦉"];

export default function Dashboard({ email, onEnterChildMode, onLogout }: Props) {
  const [children, setChildren] = useState<any[]>([]);
  const [showAddChild, setShowAddChild] = useState(false);
  const [selectedChild, setSelectedChild] = useState<any>(null);
  const [view, setView] = useState<"children" | "progress" | "tokens" | "settings">("children");
  const [error, setError] = useState("");
  const [resetChildId, setResetChildId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");

  // AGENTS.md editor state
  const [agentsEditorChild, setAgentsEditorChild] = useState<any>(null);
  const [agentsContent, setAgentsContent] = useState("");
  const [agentsMsg, setAgentsMsg] = useState("");

  async function openAgentsEditor(child: any) {
    setAgentsEditorChild(child);
    const { content } = await window.api.childGetAgentsMd(child.childId);
    setAgentsContent(content);
    setAgentsMsg("");
  }

  async function saveAgentsMd() {
    if (!agentsEditorChild) return;
    const result = await window.api.childSaveAgentsMd(agentsEditorChild.childId, agentsContent);
    if (result.success) {
      setAgentsMsg("已保存");
      setAgentsEditorChild(null);
    } else {
      setAgentsMsg(result.error || "保存失败");
    }
  }

  async function refresh() {
    const list = await window.api.childList();
    setChildren(list);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleDeleteChild(childId: string, childName: string) {
    // ISSUE-016: 不再用渲染进程 confirm()（Windows 上其原生模态对话框关闭后焦点不归还，
    // 回主页点输入框无光标），改为主进程 dialog.showMessageBox 确认。
    const r = await window.api.confirmDialog({
      title: "删除孩子",
      message: `确定要删除孩子"${childName}"吗？`,
      detail: "此操作不可撤销，孩子的所有学习数据都会被删除。",
      confirmLabel: "删除",
      cancelLabel: "取消",
    });
    if (!r?.confirmed) return;
    await window.api.childDelete(childId);
    refresh();
    if (selectedChild?.childId === childId) setSelectedChild(null);
  }

  async function handleResetPassword() {
    if (!resetChildId || !newPassword) return;
    await window.api.childResetPassword(resetChildId, newPassword);
    setResetChildId(null);
    setNewPassword("");
    setError("");
  }

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>家长中心</h1>
        <div className="actions">
          <button onClick={onEnterChildMode}>← 返回主页</button>
          <button onClick={onLogout}>退出登录</button>
        </div>
      </div>

      <div className="dashboard-body">
        <div className="dashboard-sidebar">
          <div className="section-title">菜单</div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => setView("children")}
          >
            <div className="child-avatar">👨‍👩‍👧</div>
            <div className="child-info">
              <div className="name">孩子管理</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => {
              setView("progress");
              setSelectedChild(null);
            }}
          >
            <div className="child-avatar">📊</div>
            <div className="child-info">
              <div className="name">学习进度</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => setView("tokens")}
          >
            <div className="child-avatar">📈</div>
            <div className="child-info">
              <div className="name">Token 消耗</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => setView("settings")}
          >
            <div className="child-avatar">⚙️</div>
            <div className="child-info">
              <div className="name">设置</div>
            </div>
          </div>

          <div className="section-title" style={{ marginTop: 24 }}>
            孩子列表
          </div>
          {children.map((child) => (
            <div
              key={child.childId}
              className={`child-card ${selectedChild?.childId === child.childId ? "selected" : ""}`}
              onClick={() => setSelectedChild(child)}
            >
              <div className="child-avatar">{child.avatar}</div>
              <div className="child-info">
                <div className="name">{child.name}</div>
                <div className="meta">
                  {child.age}岁 · {child.grade}
                </div>
              </div>
            </div>
          ))}
          <button
            onClick={() => setShowAddChild(true)}
            style={{
              width: "100%",
              padding: 10,
              background: "#667eea",
              color: "white",
              border: "none",
              borderRadius: 8,
              marginTop: 8,
              fontSize: 14,
            }}
          >
            + 添加孩子
          </button>
        </div>

        <div className="dashboard-main">
          {error && <div style={{ color: "red", marginBottom: 12 }}>{error}</div>}

          {view === "children" && (
            <div>
              {children.length === 0 ? (
                <p style={{ color: "#888" }}>还没有孩子，点击左侧"添加孩子"开始。</p>
              ) : (
                <div>
                  <h3 style={{ marginBottom: 16 }}>孩子列表</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                    {children.map((child) => (
                      <div key={child.childId} className="child-card" style={{ border: "1px solid #eee", flexDirection: "column", alignItems: "flex-start" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 12, width: "100%" }}>
                          <div className="child-avatar">{child.avatar}</div>
                          <div className="child-info">
                            <div className="name">{child.name}</div>
                          <div className="meta">
                            AI伙伴：{child.aiEmoji || "🤖"} {child.aiName}
                          </div>
                            <div className="meta">
                              兴趣：{child.interests || "无"}
                            </div>
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 8, marginTop: 12, width: "100%" }}>
                          <button
                            onClick={() => { setResetChildId(child.childId); setNewPassword(""); setError(""); }}
                            style={{ flex: 1, padding: "6px 12px", background: "#f0f4ff", color: "#667eea", border: "none", borderRadius: 6, fontSize: 12 }}
                          >
                            重置密码
                          </button>
                          <button
                            onClick={() => openAgentsEditor(child)}
                            style={{ flex: 1, padding: "6px 12px", background: "#f0fff0", color: "#38a169", border: "none", borderRadius: 6, fontSize: 12 }}
                          >
                            编辑 AGENTS.md
                          </button>
                          <button
                            onClick={() => handleDeleteChild(child.childId, child.name)}
                            style={{ flex: 1, padding: "6px 12px", background: "#fff0f0", color: "#e53e3e", border: "none", borderRadius: 6, fontSize: 12 }}
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "progress" && (
            <ProgressView
              childrenList={children}
              selectedChild={selectedChild}
              onSelectChild={setSelectedChild}
            />
          )}

          {view === "tokens" && <TokenStatsPanel childrenList={children} />}

          {view === "settings" && <Settings />}
        </div>
      </div>

      {showAddChild && (
        <AddChildModal
          avatars={AVATARS}
          onClose={() => setShowAddChild(false)}
          onAdded={() => {
            setShowAddChild(false);
            refresh();
          }}
        />
      )}

      {resetChildId && (
        <div className="modal-overlay" onClick={() => setResetChildId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>重置密码</h2>
            {error && <div style={{ color: "red", marginBottom: 12 }}>{error}</div>}
            <label>新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="输入新密码"
            />
            <div className="modal-actions">
              <button className="cancel" onClick={() => setResetChildId(null)}>取消</button>
              <button className="confirm" onClick={handleResetPassword}>确认</button>
            </div>
          </div>
        </div>
      )}

      {agentsEditorChild && (
        <div className="modal-overlay" onClick={() => setAgentsEditorChild(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
            <h2>编辑 AGENTS.md — {agentsEditorChild.aiName}</h2>
            {agentsMsg && (
              <div style={{ marginBottom: 12, color: agentsMsg.includes("失败") ? "red" : "#48bb78" }}>
                {agentsMsg}
              </div>
            )}
            <textarea
              value={agentsContent}
              onChange={(e) => setAgentsContent(e.target.value)}
              style={{
                width: "100%",
                minHeight: 400,
                padding: 12,
                border: "1px solid #ddd",
                borderRadius: 8,
                fontSize: 14,
                fontFamily: "monospace",
                resize: "vertical",
              }}
            />
            <div className="modal-actions">
              <button className="cancel" onClick={() => setAgentsEditorChild(null)}>取消</button>
              <button className="confirm" onClick={saveAgentsMd}>保存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

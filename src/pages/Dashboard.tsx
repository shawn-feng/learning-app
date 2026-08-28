import { useState, useEffect } from "react";
import { Bot, ArrowLeft, LogOut, UserPlus, KeyRound, ListTree, Pencil, Trash2, MessageSquare } from "lucide-react";
import IconButton from "../components/IconButton";
import AddChildModal from "../components/AddChildModal";
import TokenStatsPanel from "../components/TokenStatsPanel";
import ChildTopicsModal from "../components/ChildTopicsModal";
import CourseManager from "../components/CourseManager";
import ParentChatPanel from "../components/ParentChatPanel";
import Settings from "./Settings";
import AgentPromptEditor from "../components/AgentPromptEditor";
import { useChatPanel } from "../hooks/useChatPanel";

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
  const [view, setView] = useState<"children" | "courses" | "tokens" | "settings">("children");
  const [error, setError] = useState("");
  const [resetChildId, setResetChildId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [topicsChild, setTopicsChild] = useState<any>(null); // 学习主题弹窗目标孩子
  const [agentPrompt, setAgentPrompt] = useState<{ scope: string; ref: string; title: string } | null>(null);
  // 右侧家长聊天面板：可折叠 + 拖拽调宽（宽度/折叠状态持久化）
  const parentChat = useChatPanel("parent", 360);

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
          <IconButton
            icon={Bot}
            title="家长 AI 提示词"
            onClick={() =>
              setAgentPrompt({ scope: "parent", ref: "main", title: "编辑家长 AI 提示词" })
            }
          />
          <IconButton icon={ArrowLeft} title="返回主页" onClick={onEnterChildMode} />
          <IconButton icon={LogOut} title="退出登录" onClick={onLogout} />
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
            onClick={() => setView("courses")}
          >
            <div className="child-avatar">📚</div>
            <div className="child-info">
              <div className="name">课程管理</div>
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
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <UserPlus size={18} /> 添加孩子
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
                        <div style={{ display: "flex", gap: 8, marginTop: 12, width: "100%", flexWrap: "wrap" }}>
                          <IconButton icon={KeyRound} title="重置密码" style={{ flex: 1, minWidth: 44 }} onClick={() => { setResetChildId(child.childId); setNewPassword(""); setError(""); }} />
                          <IconButton icon={ListTree} title="学习主题" style={{ flex: 1, minWidth: 44 }} onClick={() => setTopicsChild(child)} />
                          <IconButton icon={Pencil} title="编辑 AI 提示词" style={{ flex: 1, minWidth: 44 }} onClick={() => setAgentPrompt({ scope: "child", ref: child.childId, title: `编辑 AI 提示词 — ${child.aiName}` })} />
                          <IconButton icon={Trash2} title="删除" danger style={{ flex: 1, minWidth: 44 }} onClick={() => handleDeleteChild(child.childId, child.name)} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {view === "courses" && <CourseManager />}

          {view === "tokens" && <TokenStatsPanel childrenList={children} />}

          {view === "settings" && <Settings />}
        </div>

        {/* 右：家长-Agent 常驻聊天（ISSUE-050），可折叠 + 拖拽调宽 */}
        <div
          className="dashboard-chat"
          style={{
            width: parentChat.collapsed ? 44 : parentChat.width,
            minWidth: parentChat.collapsed ? 44 : undefined,
          }}
        >
          {parentChat.collapsed ? (
            <div
              className="chat-collapsed-bar"
              title="展开聊天"
              onClick={() => parentChat.setCollapsed(false)}
            >
              <MessageSquare size={20} />
            </div>
          ) : (
            <>
              <div className="chat-resize-handle" onMouseDown={parentChat.startDrag} title="拖动调整聊天宽度" />
              <button
                className="chat-collapse-btn"
                title="折叠聊天"
                onClick={() => parentChat.setCollapsed(true)}
              >
                »
              </button>
              <ParentChatPanel />
            </>
          )}
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

      {topicsChild && (
        <ChildTopicsModal
          child={topicsChild}
          onClose={() => setTopicsChild(null)}
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

      {agentPrompt && (
        <AgentPromptEditor
          scope={agentPrompt.scope}
          refKey={agentPrompt.ref}
          title={agentPrompt.title}
          onClose={() => setAgentPrompt(null)}
        />
      )}
      </div>
  );
}

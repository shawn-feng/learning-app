import { useState, useEffect } from "react";
import { Bot, ArrowLeft, LogOut, UserPlus, MessageSquare } from "lucide-react";
import IconButton from "../components/IconButton";
import AddChildModal from "../components/AddChildModal";
import TokenStatsPanel from "../components/TokenStatsPanel";
import CourseManager from "../components/CourseManager";
import ParentChatPanel from "../components/ParentChatPanel";
import Settings from "./Settings";
import ChildDetailPage from "../components/ChildDetailPage";
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
  // ISSUE-007：点击孩子卡片进入详情页（tabs 组织 进度/主题/提示词/账号，替代弹窗）
  const [detailChild, setDetailChild] = useState<any>(null);
  // 右侧家长聊天面板：可折叠 + 拖拽调宽（宽度/折叠状态持久化）
  const parentChat = useChatPanel("parent", 360);

  async function refresh() {
    const list = await window.api.childList();
    setChildren(list);
  }

  useEffect(() => {
    refresh();
  }, []);

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
            onClick={() => {
              setView("children");
              setDetailChild(null);
            }}
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
          {view === "children" && !detailChild && (
            <div>
              {children.length === 0 ? (
                <p style={{ color: "#888" }}>还没有孩子，点击左侧"添加孩子"开始。</p>
              ) : (
                <div>
                  <h3 style={{ marginBottom: 16 }}>孩子列表（点击卡片进入详情）</h3>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
                    {children.map((child) => (
                      // ISSUE-007：卡片整体点击进入详情页（学习进度/学习主题/AI 提示词/账号密码 tabs）
                      <div
                        key={child.childId}
                        className="child-card"
                        style={{
                          border: "1px solid #eee",
                          flexDirection: "column",
                          alignItems: "flex-start",
                          cursor: "pointer",
                          transition: "box-shadow .15s",
                        }}
                        onClick={() => setDetailChild(child)}
                        title="点击查看孩子详情（学习进度 / 学习主题 / AI 提示词 / 账号密码）"
                      >
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
                        <div style={{ fontSize: 12, color: "#667eea", marginTop: 12, display: "flex", alignItems: "center", gap: 4 }}>
                          查看详情 ›
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ISSUE-007：孩子详情页（tabs 组织，替代原弹窗） */}
          {detailChild && (
            <ChildDetailPage
              child={detailChild}
              onBack={() => setDetailChild(null)}
              onDeleted={() => {
                setDetailChild(null);
                refresh();
              }}
            />
          )}

          {view === "courses" && !detailChild && <CourseManager />}

          {view === "tokens" && !detailChild && <TokenStatsPanel childrenList={children} />}

          {view === "settings" && !detailChild && <Settings />}
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
      </div>
  );
}

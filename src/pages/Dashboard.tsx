import { useState, useEffect } from "react";
import { Bot, ArrowLeft, LogOut, UserPlus, MessageSquare } from "lucide-react";
import IconButton from "../components/IconButton";
import { LoadingBlock } from "../components/Loading";
import AddChildModal from "../components/AddChildModal";
import TokenStatsPanel from "../components/TokenStatsPanel";
import SessionSyncPanel from "../components/SessionSyncPanel";
import CourseManager from "../components/CourseManager";
import ParentChatPanel from "../components/ParentChatPanel";
import ExamAdminPanel from "../components/ExamAdminPanel";
import SchedulerTasksPanel from "../components/SchedulerTasksPanel";
import StudyPlanPanel from "../components/StudyPlanPanel";
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
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [showAddChild, setShowAddChild] = useState(false);
  const [view, setView] = useState<"children" | "courses" | "plan" | "exam" | "scheduler" | "tokens" | "sync" | "settings">("children");
  // ISSUE-007：点击孩子卡片进入详情页（tabs 组织 进度/主题/提示词/账号，替代弹窗）
  const [detailChild, setDetailChild] = useState<any>(null);
  // 右侧家长聊天面板：可折叠 + 拖拽调宽（宽度/折叠状态持久化）
  const parentChat = useChatPanel("parent", 360);

  async function refresh() {
    setChildrenLoading(true);
    try {
      const list = await window.api.childList();
      setChildren(list);
    } finally {
      setChildrenLoading(false);
    }
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
            onClick={() => {
              setView("plan");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">🗓</div>
            <div className="child-info">
              <div className="name">学习计划</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => {
              setView("exam");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">🎯</div>
            <div className="child-info">
              <div className="name">学习考核</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => {
              setView("scheduler");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">⏰</div>
            <div className="child-info">
              <div className="name">定时任务</div>
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
            onClick={() => {
              setView("sync");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">📡</div>
            <div className="child-info">
              <div className="name">会话同步</div>
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

        </div>

        <div className="dashboard-main">
          {view === "children" && !detailChild && (
            <div>
              {childrenLoading ? (
                <LoadingBlock text="正在加载孩子列表…" />
              ) : children.length === 0 ? (
                <>
                  <p style={{ color: "#888" }}>还没有孩子，点击下方"添加孩子"开始。</p>
                  <button
                    onClick={() => setShowAddChild(true)}
                    style={{
                      padding: "10px 20px",
                      background: "#667eea",
                      color: "white",
                      border: "none",
                      borderRadius: 8,
                      fontSize: 14,
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      cursor: "pointer",
                    }}
                  >
                    <UserPlus size={18} /> 添加孩子
                  </button>
                </>
              ) : (
                <div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
                    <h3 style={{ margin: 0 }}>孩子列表（点击卡片进入详情）</h3>
                    <button
                      onClick={() => setShowAddChild(true)}
                      style={{
                        padding: "8px 16px",
                        background: "#667eea",
                        color: "white",
                        border: "none",
                        borderRadius: 8,
                        fontSize: 13,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        cursor: "pointer",
                      }}
                    >
                      <UserPlus size={16} /> 添加孩子
                    </button>
                  </div>
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

          {/* ISSUE-033 P4：学习计划只读面板（编辑走右侧家长对话） */}
          {view === "plan" && !detailChild && (
            <StudyPlanPanel
              children={children}
              onAskInChat={() => parentChat.setCollapsed(false)}
            />
          )}

          {view === "exam" && !detailChild && <ExamAdminPanel children={children} />}

          {view === "scheduler" && !detailChild && <SchedulerTasksPanel children={children} />}

          {view === "tokens" && !detailChild && <TokenStatsPanel childrenList={children} />}

          {view === "sync" && !detailChild && <SessionSyncPanel childrenList={children} />}

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
              <div className="chat-resize-handle" onPointerDown={parentChat.startDrag} title="拖动调整聊天宽度" />
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

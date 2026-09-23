import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, LogOut, UserPlus, MessageSquare } from "lucide-react";
import IconButton from "../components/IconButton";
import { LoadingBlock } from "../components/Loading";
import AddChildModal from "../components/AddChildModal";
import TokenStatsPanel from "../components/TokenStatsPanel";
import CourseManager from "../components/CourseManager";
import QuestionBankPanel from "../components/QuestionBankPanel";
import ParentChatPanel from "../components/ParentChatPanel";
import SchedulerTasksPanel from "../components/SchedulerTasksPanel";
import FilesPanel from "../components/FilesPanel";
import Settings from "./Settings";
import ChildDetailPage from "../components/ChildDetailPage";
import { useChatPanel } from "../hooks/useChatPanel";

interface Props {
  email: string;
  onEnterChildMode: () => void;
  onLogout: () => void;
}

const AVATARS = ["🦊", "🐰", "🐻", "🦁", "🐼", "🐨", "🐯", "🦉"];

/** ISSUE-108：家长报表（parent_display_report 推送的 markdown；持久在服务端 settings） */
interface ParentReport {
  title: string;
  content: string;
  ts: number;
}

export default function Dashboard({ email, onEnterChildMode, onLogout }: Props) {
  const [children, setChildren] = useState<any[]>([]);
  const [childrenLoading, setChildrenLoading] = useState(true);
  const [showAddChild, setShowAddChild] = useState(false);
  // ISSUE-130：学习计划/学习考核/积分并入孩子管理→孩子详情，侧边栏只留全局项
  const [view, setView] = useState<
    "children" | "courses" | "scheduler" | "tokens" | "settings" | "bank" | "dataagent" | "report" | "files"
  >("children");
  // ISSUE-108：报表区内容（服务端 SSE display_content 推送 / 挂载时读回最近一次）
  const [report, setReport] = useState<ParentReport | null>(null);
  const [reportUnread, setReportUnread] = useState(false);
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

  // ISSUE-108：报表区——挂载读回最近一次；家长会话推送新报表（display_content, source=report）时更新并自动切到报表页
  useEffect(() => {
    window.api
      .parentReportGet()
      .then((r: any) => {
        if (r?.success && r.data?.report) {
          setReport(r.data.report);
          setReportUnread(true);
        }
      })
      .catch(() => {
        /* 无报表/未登录：报表区保持空态 */
      });
    const onDisplay = window.api.onPiDisplayContent((data) => {
      if (data.childId !== "parent" || data.source !== "report" || !data.content) return;
      setReport({ title: data.title || "学习报表", content: data.content, ts: Date.now() });
      setReportUnread(true);
    });
    return () => {
      window.api.piRemoveListeners();
    };
  }, []);

  // 手动打开/切到报表页 = 清未读角标
  useEffect(() => {
    if (view === "report") setReportUnread(false);
  }, [view]);

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>家长中心</h1>
        <div className="actions">
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
              setView("bank");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">📖</div>
            <div className="child-info">
              <div className="name">题库</div>
            </div>
          </div>
          {/* ISSUE-131 P1：文件区网盘（资料库/上传原始件/各孩子工作区统一管理） */}
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => {
              setView("files");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">🗂️</div>
            <div className="child-info">
              <div className="name">文件</div>
            </div>
          </div>
          {/* ISSUE-130：学习计划/学习考核/积分 已并入 孩子管理→孩子详情 */}
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
            onClick={() => setView("settings")}
          >
            <div className="child-avatar">⚙️</div>
            <div className="child-info">
              <div className="name">设置</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none" }}
            onClick={() => {
              setView("dataagent");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">🗃️</div>
            <div className="child-info">
              <div className="name">数据管理</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none", position: "relative" }}
            onClick={() => {
              setView("report");
              setDetailChild(null);
            }}
          >
            <div className="child-avatar">📊</div>
            <div className="child-info">
              <div className="name">报表</div>
            </div>
            {reportUnread && (
              <span
                style={{
                  position: "absolute",
                  top: 8,
                  right: 10,
                  width: 10,
                  height: 10,
                  borderRadius: "50%",
                  background: "#e74c3c",
                }}
                title="有新报表"
              />
            )}
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
                      // ISSUE-007：卡片整体点击进入详情页（学习进度/学习主题/账号密码 tabs）
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
                        title="点击查看孩子详情（学习进度 / 学习主题 / 账号密码）"
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
          {view === "bank" && !detailChild && <QuestionBankPanel />}

          {/* ISSUE-131 P1：文件区网盘（家长根 = workspaces/<pid> 整棵虚拟树 + materials/uploads） */}
          {view === "files" && !detailChild && (
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1, maxWidth: 980 }}>
              <FilesPanel />
            </div>
          )}

          {/* ISSUE-130：学习计划/学习考核/积分 三个 view 已删除，入口并入孩子详情（ChildDetailPage） */}

          {view === "scheduler" && !detailChild && <SchedulerTasksPanel children={children} />}

          {view === "tokens" && !detailChild && <TokenStatsPanel childrenList={children} />}

          {view === "settings" && !detailChild && <Settings />}

          {/* 独立「数据管理 agent」：统一数据 API 操作家长内容库全部表（parent-data 会话） */}
          {view === "dataagent" && !detailChild && <ParentChatPanel childId="parent-data" />}

          {/* ISSUE-108：报表区——家长 agent 经 parent_display_report 推送的 markdown 汇总 */}
          {view === "report" && !detailChild && (
            <div>
              {report ? (
                <div
                  style={{
                    background: "#fff",
                    borderRadius: 12,
                    border: "1px solid #e6eaf0",
                    padding: "18px 24px",
                    maxWidth: 860,
                    lineHeight: 1.7,
                    fontSize: 14,
                    color: "#2c3e50",
                  }}
                  className="parent-report-md"
                >
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ fontWeight: 800, fontSize: 17 }}>📊 {report.title}</span>
                    <span style={{ fontSize: 12, color: "#98a1b2", marginLeft: 10 }}>
                      {new Date(report.ts).toLocaleString("zh-CN")}
                    </span>
                  </div>
                  <ReactMarkdown>{report.content}</ReactMarkdown>
                </div>
              ) : (
                <div
                  style={{
                    padding: 32,
                    textAlign: "center",
                    color: "#999",
                    fontSize: 13,
                    border: "1px dashed #ddd",
                    borderRadius: 10,
                    maxWidth: 860,
                  }}
                >
                  还没有报表。对右侧家长助手说「帮我汇总一下孩子的学习情况」，生成的报表会显示在这里。
                </div>
              )}
            </div>
          )}
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

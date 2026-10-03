import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import { UserPlus } from "lucide-react";
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
    "children" | "courses" | "scheduler" | "tokens" | "settings" | "bank" | "report" | "files"
  >("children");
  // ISSUE-108：报表区内容（服务端 SSE display_content 推送 / 挂载时读回最近一次）
  const [report, setReport] = useState<ParentReport | null>(null);
  const [reportUnread, setReportUnread] = useState(false);
  // ISSUE-167：服务端连接状态（断连降级横幅——失联时列表静默回退本机数据，必须可见化）
  const [conn, setConn] = useState<any>(null);
  const connDegraded = conn?.connected === false;
  const connRef = useRef(false);
  connRef.current = connDegraded;
  // ISSUE-007：点击孩子卡片进入详情页（tabs 组织 进度/主题/提示词/账号，替代弹窗）
  const [detailChild, setDetailChild] = useState<any>(null);
  // ISSUE-158：侧栏折叠态（折叠后只显示 emoji icon、悬浮 title 显示名称），localStorage 持久化
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem("parent:sidebarCollapsed") === "1"
  );
  function toggleSidebar() {
    setSidebarCollapsed((prev) => {
      localStorage.setItem("parent:sidebarCollapsed", prev ? "0" : "1");
      return !prev;
    });
  }
  // 右侧家长聊天面板：可折叠 + 拖拽调宽（宽度/折叠状态持久化）
  const parentChat = useChatPanel("parent", 360);
  // ISSUE-158 续（用户反馈）：折叠开关移到标题栏（全屏右侧两枚）——这里监听切换请求并上报
  // 当前态供标题栏切图标（窗口 CustomEvent 解耦，TitleBar 与面板状态互不持有）
  const chatCollapsedRef = useRef(parentChat.collapsed);
  useEffect(() => {
    chatCollapsedRef.current = parentChat.collapsed;
  }, [parentChat.collapsed]);
  useEffect(() => {
    const onToggleLeft = () => toggleSidebar();
    const onToggleRight = () => parentChat.setCollapsed(!chatCollapsedRef.current);
    window.addEventListener("ui:toggle-left-sidebar", onToggleLeft);
    window.addEventListener("ui:toggle-right-sidebar", onToggleRight);
    return () => {
      window.removeEventListener("ui:toggle-left-sidebar", onToggleLeft);
      window.removeEventListener("ui:toggle-right-sidebar", onToggleRight);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("ui:left-sidebar-changed", { detail: { collapsed: sidebarCollapsed } }));
  }, [sidebarCollapsed]);
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("ui:right-panel-changed", { detail: { collapsed: parentChat.collapsed } }));
  }, [parentChat.collapsed]);

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

  // ISSUE-167：连接状态——挂载读快照 + 订阅断连恢复推送（Electron）+ 降级期间 30s 轮询兜底
  // （推送监听可能被 piRemoveListeners 清掉；web 端无推送，靠轮询读 shim 状态探活）。
  // 恢复时自动重拉孩子列表并撤横幅——把「退出家长重登」这个手工恢复动作自动化。
  useEffect(() => {
    let mounted = true;
    window.api.serverConnectionState?.().then((s: any) => {
      if (mounted && s) setConn(s);
    }).catch(() => {});
    window.api.onServerConnectionChanged?.((s: any) => {
      if (!mounted || !s) return;
      const recovered = connRef.current && s.connected !== false;
      setConn(s);
      if (recovered) void refresh();
    });
    const poll = setInterval(async () => {
      if (!connRef.current) return;
      try {
        const s = await window.api.serverConnectionState?.();
        if (mounted && s) setConn(s);
      } catch {
        /* ignore */
      }
    }, 30_000);
    return () => {
      mounted = false;
      clearInterval(poll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function retryConnection() {
    try {
      const s = await window.api.serverRetryConnection?.();
      if (s) setConn(s);
      if (s?.connected !== false) await refresh();
    } catch {
      /* ignore */
    }
  }

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
      {/* ISSUE-158：顶部「家长中心」标题条删除——返回主页/退出登录移入左侧栏顶部工具行 */}

      <div className="dashboard-body">
        <div className={`dashboard-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          {/* ISSUE-158 续（用户反馈）：顶部工具行取消——折叠开关移标题栏、退出登录移主页（主页已有）；
              菜单区内部滚动，「返回主页」钉在侧栏最下面 */}
          <div className="sidebar-menu">
          <div
            className="child-card"
            style={{ border: "none" }}
            title="孩子管理"
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
            title="课程管理"
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
            title="题库"
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
            title="文件"
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
            title="定时任务"
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
            title="Token 消耗"
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
            title="设置"
            onClick={() => setView("settings")}
          >
            <div className="child-avatar">⚙️</div>
            <div className="child-info">
              <div className="name">设置</div>
            </div>
          </div>
          <div
            className="child-card"
            style={{ border: "none", position: "relative" }}
            title="报表"
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

          {/* 底部：返回主页（孩子模式）——注销登录在主页已有，不再重复 */}
          <div
            className="child-card sidebar-footer-item"
            style={{ border: "none" }}
            title="返回主页（孩子模式）"
            onClick={onEnterChildMode}
          >
            <div className="child-avatar">🏠</div>
            <div className="child-info">
              <div className="name">返回主页</div>
            </div>
          </div>
        </div>

        <div className="dashboard-main">
          {/* ISSUE-167：断连降级常驻横幅——失联时列表会静默回退本机数据，必须让家长看见环境切换 */}
          {connDegraded && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                flexWrap: "wrap",
                marginBottom: 12,
                padding: "10px 14px",
                border: "1px solid #f0d0a0",
                background: "#fff8ec",
                borderRadius: 10,
              }}
            >
              <span style={{ fontSize: 13, color: "#8a5a00", flex: 1, minWidth: 260, lineHeight: 1.6 }}>
                ⚠ 已断开{conn.url ? `与服务端（${conn.url}）` : "与服务端"}的连接，当前显示的是<strong>本机数据</strong>（仅离线可用）。
                {typeof conn.lastServerChildCount === "number" && (
                  <> 服务器上次同步 {conn.lastServerChildCount} 个孩子，本机当前 {children.length} 个——请勿在本地孩子里产生新记录。</>
                )}{" "}
                断连期间会自动重连，恢复后列表自动刷新。
              </span>
              <button
                onClick={retryConnection}
                style={{
                  padding: "6px 16px",
                  background: "#fff",
                  color: "#8a5a00",
                  border: "1px solid #e0b96a",
                  borderRadius: 8,
                  fontSize: 13,
                  cursor: "pointer",
                  flexShrink: 0,
                }}
              >
                重试连接
              </button>
            </div>
          )}
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

          {/* ISSUE-007：孩子详情页（tabs 组织，替代原弹窗）。
              ISSUE-169：详情是「孩子管理」视图的子页——只在 view==="children" 时渲染；
              侧栏切到其它菜单（或报表推送自动切视图）时立即离开详情，不再被详情盖住。 */}
          {view === "children" && detailChild && (
            <ChildDetailPage
              child={detailChild}
              onBack={() => setDetailChild(null)}
              onDeleted={() => {
                setDetailChild(null);
                refresh();
              }}
            />
          )}

          {view === "courses" && <CourseManager />}
          {view === "bank" && <QuestionBankPanel />}

          {/* ISSUE-131 P1：文件区网盘（家长根 = workspaces/<pid> 整棵虚拟树 + materials/uploads） */}
          {view === "files" && (
            <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1, maxWidth: 980 }}>
              <FilesPanel />
            </div>
          )}

          {/* ISSUE-130：学习计划/学习考核/积分 三个 view 已删除，入口并入孩子详情（ChildDetailPage） */}

          {view === "scheduler" && <SchedulerTasksPanel children={children} />}

          {view === "tokens" && <TokenStatsPanel childrenList={children} />}

          {view === "settings" && <Settings />}

          {/* ISSUE-108：报表区——家长 agent 经 parent_display_report 推送的 markdown 汇总 */}
          {view === "report" && (
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

        {/* 右：家长-Agent 常驻聊天（ISSUE-050），可拖拽调宽。
            ISSUE-158 续（用户反馈）：折叠后的 44px「展开聊天」窄条去掉——折叠态整栏不渲染，
            展开走标题栏右上角的折叠按钮（PanelRightOpen）；» 折叠按钮保留。 */}
        {!parentChat.collapsed && (
          <div className="dashboard-chat" style={{ width: parentChat.width }}>
            <div className="chat-resize-handle" onPointerDown={parentChat.startDrag} title="拖动调整聊天宽度" />
            <button
              className="chat-collapse-btn"
              title="折叠聊天"
              onClick={() => parentChat.setCollapsed(true)}
            >
              »
            </button>
            <ParentChatPanel />
          </div>
        )}
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

import { useState, useEffect, useRef, useCallback } from "react";
import ChatWindow, { type ChatMessage, type ToolCallState } from "../components/ChatWindow";
import MaterialsPanel, { type Material } from "../components/MaterialsPanel";
import LearningDashboard from "../components/LearningDashboard";
import ModelSelector from "../components/ModelSelector";

interface Props {
  child: any;
  onExit: () => void;
}

const AI_EMOJIS = ["🤖", "🦊", "🐱", "🐶", "🦉", "🐲", "🦄", "🌟", "🎓", "📚"];

// 朗读语速档位（对齐 wowenglish 偏好，默认 0.7x 慢速）
const RATE_OPTIONS = [
  { label: "慢", value: "-50%", display: "0.5x" },
  { label: "标准", value: "-30%", display: "0.7x" },
  { label: "正常", value: "+0%", display: "1.0x" },
  { label: "快", value: "+30%", display: "1.3x" },
];

// 左侧展示页配置（可扩展：新增展示页只需在此追加一项 + 对应渲染组件）
type PanelViewKey = "materials" | "progress";
const PANEL_VIEWS: Array<{ key: PanelViewKey; icon: string; label: string; desc: string }> = [
  { key: "materials", icon: "📖", label: "学习资料", desc: "AI 老师展示的课文、卡片、练习" },
  { key: "progress", icon: "📊", label: "学习进度看板", desc: "各学习主题的进度总览" },
];

let msgCounter = 0;
function nextId() {
  return `msg-${Date.now()}-${msgCounter++}`;
}

// 学习资料到达时间标签（MM-DD HH:mm）
function nowLabel() {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function Learn({ child, onExit }: Props) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [materials, setMaterials] = useState<Material[]>([]);
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const childIdRef = useRef(child.childId);
  // 当前正在工作的 AI 消息 id（思考/工具/正式回复都更新到同一气泡）
  const workingIdRef = useRef<string | null>(null);
  // 学习资料保留数量上限（家长可配置），追加材料时按此截断
  const materialsLimitRef = useRef(20);

  // 左侧展示页切换
  const [view, setView] = useState<PanelViewKey>("materials");
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const currentView = PANEL_VIEWS.find((v) => v.key === view) || PANEL_VIEWS[0];

  // Sidebar collapse
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  // TTS 语速
  const [rate, setRate] = useState("-30%");

  // AI Agent settings
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [aiName, setAiName] = useState(child.aiName);
  const [aiEmoji, setAiEmoji] = useState(child.aiEmoji || "🤖");
  const [aiPersonality, setAiPersonality] = useState(child.aiPersonality);
  const [aiSettingsMsg, setAiSettingsMsg] = useState("");

  // Change password
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [changePwdMsg, setChangePwdMsg] = useState("");

  useEffect(() => {
    setAiName(child.aiName);
    setAiEmoji(child.aiEmoji || "🤖");
    setAiPersonality(child.aiPersonality);
  }, [child.aiName, child.aiEmoji, child.aiPersonality]);

  useEffect(() => {
    childIdRef.current = child.childId;
    window.api.piStartChild(child.childId).then((r: any) => {
      if (r?.success) {
        if (Array.isArray(r.history) && r.history.length > 0) {
          setMessages(
            r.history.map((m: any) => ({
              id: nextId(),
              role: m.role === "user" ? "user" : "ai",
              text: m.text,
            }))
          );
        }
        // 恢复学习资料列表（退出再进入不丢失；主进程已按 limit 截断）
        if (Array.isArray(r.materials)) {
          setMaterials(r.materials);
        }
        if (typeof r.materialsLimit === "number" && r.materialsLimit > 0) {
          materialsLimitRef.current = r.materialsLimit;
        }
      } else {
        console.error("Failed to start session:", r?.error);
      }
    });
  }, [child.childId]);

  // 更新当前工作气泡（按 id 定位）
  const patchWorking = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const id = workingIdRef.current;
    if (!id) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  // 思考增量（已由主进程节流）
  const handleThinking = useCallback((data: { childId: string; delta: string }) => {
    if (data.childId !== childIdRef.current) return;
    patchWorking((m) => ({ ...m, thinking: (m.thinking || "") + data.delta }));
  }, [patchWorking]);

  // 工具开始调用
  const handleToolStart = useCallback((data: any) => {
    if (data.childId !== childIdRef.current) return;
    const call: ToolCallState = {
      id: data.toolCallId || `tool-${Date.now()}`,
      name: data.toolName,
      argsPreview: data.argsPreview,
      status: "running",
    };
    patchWorking((m) => ({ ...m, tools: [...(m.tools || []), call] }));
  }, [patchWorking]);

  // 工具结束调用 + 学习资料列表更新
  const handleToolEnd = useCallback((data: any) => {
    if (data.childId !== childIdRef.current) return;
    if (data.toolName === "display_content") {
      const panel = data.result?.details?.panelContent;
      if (panel) {
        const id = nextId();
        setMaterials((prev) => {
          const next = [
            ...prev,
            {
              id,
              format: panel.format,
              content: panel.content,
              title: panel.title,
              time: nowLabel(),
            },
          ];
          const lim = materialsLimitRef.current;
          return lim > 0 ? next.slice(-lim) : next;
        });
        // 新资料到达后自动打开查看
        setSelectedMaterialId(id);
      }
    }
    patchWorking((m) => ({
      ...m,
      tools: (m.tools || []).map((t) =>
        t.id === data.toolCallId
          ? {
              ...t,
              status: data.isError ? "error" : "done",
              resultPreview: data.resultPreview,
            }
          : t
      ),
    }));
  }, [patchWorking]);

  // 正式回复到达 —— 在同一个气泡里替换为正式消息
  const handleReply = useCallback((data: { childId: string; text: string }) => {
    if (data.childId !== childIdRef.current) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id
            ? { ...m, text: data.text, working: false }
            : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: data.text }];
    });
    setBusy(false);
  }, []);

  const handleReplyEnd = useCallback(() => {
    workingIdRef.current = null;
    setBusy(false);
  }, []);

  const handleReplyError = useCallback((data: { childId: string; error: string }) => {
    if (data.childId !== childIdRef.current) return;
    const id = workingIdRef.current;
    workingIdRef.current = null;
    setMessages((prev) => {
      if (id && prev.some((m) => m.id === id)) {
        return prev.map((m) =>
          m.id === id
            ? { ...m, text: `⚠️ ${data.error}`, working: false }
            : m
        );
      }
      return [...prev, { id: nextId(), role: "ai", text: `⚠️ ${data.error}` }];
    });
    setBusy(false);
  }, []);

  useEffect(() => {
    window.api.onPiReply(handleReply);
    window.api.onPiReplyEnd(handleReplyEnd);
    window.api.onPiReplyError(handleReplyError);
    window.api.onPiThinking(handleThinking);
    window.api.onPiToolStart(handleToolStart);
    window.api.onPiToolEnd(handleToolEnd);
    return () => {
      window.api.piRemoveListeners();
    };
  }, [handleReply, handleReplyEnd, handleReplyError, handleThinking, handleToolStart, handleToolEnd]);

  async function handleSend(text: string, audio?: string) {
    const userMsg: ChatMessage = { id: nextId(), role: "user", text, audio };
    const workingMsg: ChatMessage = {
      id: nextId(),
      role: "ai",
      text: "",
      thinking: "",
      tools: [],
      working: true,
    };
    workingIdRef.current = workingMsg.id;
    setMessages((prev) => [...prev, userMsg, workingMsg]);
    setBusy(true);
    try {
      // 语音识别的消息注明来源，让 AI 知道可能存在识别错误，结合上下文推理正确内容
      const promptText = audio
        ? `[语音识别输入，可能存在同音字/断句等识别错误，请结合上下文理解并推理出正确内容] ${text}`
        : text;
      const result = await window.api.piPrompt(child.childId, promptText);
      if (!result.success) {
        // 若 pi:reply_error 已处理则 workingIdRef 已清空，跳过
        const id = workingIdRef.current;
        if (id) {
          workingIdRef.current = null;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === id
                ? { ...m, text: `⚠️ ${result.error || "发送失败"}`, working: false }
                : m
            )
          );
          setBusy(false);
        }
      }
    } catch (e: any) {
      const id = workingIdRef.current;
      if (id) {
        workingIdRef.current = null;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === id
              ? { ...m, text: `⚠️ ${e.message || "网络错误"}`, working: false }
              : m
          )
        );
        setBusy(false);
      }
    }
  }

  function handleExit() {
    window.api.piDispose(child.childId);
    onExit();
  }

  async function handleSaveAiSettings() {
    setAiSettingsMsg("");
    try {
      const result = await window.api.childUpdateProfile(child.childId, {
        aiName,
        aiEmoji,
        aiPersonality,
      });
      if (result.success) {
        child.aiName = aiName;
        child.aiEmoji = aiEmoji;
        child.aiPersonality = aiPersonality;
        setAiSettingsMsg("已保存");
        setShowAiSettings(false);
      } else {
        setAiSettingsMsg(result.error || "保存失败");
      }
    } catch (e: any) {
      setAiSettingsMsg(e.message || "保存失败");
    }
  }

  async function handleChangePassword() {
    setChangePwdMsg("");
    if (!oldPassword || !newPassword) {
      setChangePwdMsg("请填写旧密码和新密码");
      return;
    }
    if (newPassword !== confirmPassword) {
      setChangePwdMsg("两次输入的新密码不一致");
      return;
    }
    const result = await window.api.childChangePassword(child.childId, oldPassword, newPassword);
    if (result.success) {
      setChangePwdMsg("密码已修改");
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setShowChangePassword(false);
    } else {
      setChangePwdMsg(result.error || "修改失败");
    }
  }

  return (
    <div className="learn-page">
      <div className="learn-main">
        <div className={`learn-sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {sidebarCollapsed ? "»" : "«"}
          </button>

          <div className="sidebar-profile">
            <div className="sidebar-avatar" title={child.name}>{child.avatar}</div>
            {!sidebarCollapsed && (
              <>
                <div className="sidebar-name">{child.name}</div>
                <div className="sidebar-ai">
                  {aiEmoji} {aiName}
                </div>
                <div className="sidebar-sub">我的学习伙伴</div>
              </>
            )}
          </div>

          <div
            className="view-switcher"
            onMouseEnter={() => setViewMenuOpen(true)}
            onMouseLeave={() => setViewMenuOpen(false)}
          >
            <button
              className={`sidebar-btn view-switcher-btn ${viewMenuOpen ? "open" : ""}`}
              title="切换展示页"
            >
              <span className="sidebar-btn-icon">{currentView.icon}</span>
              {!sidebarCollapsed && (
                <>
                  <span className="sidebar-btn-text">{currentView.label}</span>
                  <span className="view-switcher-caret">▾</span>
                </>
              )}
            </button>

            {viewMenuOpen && (
              <div className="view-switcher-popover">
                <div className="view-switcher-title">切换展示页</div>
                {PANEL_VIEWS.map((v) => (
                  <button
                    key={v.key}
                    className={`view-option ${view === v.key ? "active" : ""}`}
                    onClick={() => {
                      setView(v.key);
                      setViewMenuOpen(false);
                    }}
                  >
                    <span className="view-option-icon">{v.icon}</span>
                    <span className="view-option-body">
                      <span className="view-option-label">{v.label}</span>
                      <span className="view-option-desc">{v.desc}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="sidebar-model">
            {sidebarCollapsed && (
              <button
                className="sidebar-icon-btn"
                title="模型"
                onClick={() => setSidebarCollapsed(false)}
              >
                🤖
              </button>
            )}
            {/* 保持 ModelSelector 常驻挂载，折叠时仅用 CSS 隐藏，避免卸载后重新挂载时重置为默认模型 */}
            <div
              className="sidebar-model-body"
              style={{ display: sidebarCollapsed ? "none" : "block", width: "100%" }}
            >
              <div className="sidebar-section-label">模型</div>
              <ModelSelector childId={child.childId} />
            </div>
          </div>

          <div className="sidebar-rate">
            {sidebarCollapsed ? (
              <button
                className="sidebar-icon-btn"
                title={`朗读语速 ${RATE_OPTIONS.find((o) => o.value === rate)?.display || "0.7x"}`}
                onClick={() => setSidebarCollapsed(false)}
              >
                🔉
              </button>
            ) : (
              <>
                <div className="sidebar-section-label">朗读语速</div>
                <div className="rate-grid">
                  {RATE_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      className={`rate-btn ${rate === opt.value ? "active" : ""}`}
                      onClick={() => setRate(opt.value)}
                      title={`${opt.label} ${opt.display}`}
                    >
                      {opt.display}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="sidebar-menu">
            <button
              className="sidebar-btn"
              title="AI 伙伴设置"
              onClick={() => {
                setAiSettingsMsg("");
                setShowAiSettings(true);
              }}
            >
              <span className="sidebar-btn-icon">⚙️</span>
              {!sidebarCollapsed && <span className="sidebar-btn-text">AI 伙伴设置</span>}
            </button>
            <button
              className="sidebar-btn"
              title="修改密码"
              onClick={() => {
                setChangePwdMsg("");
                setOldPassword("");
                setNewPassword("");
                setConfirmPassword("");
                setShowChangePassword(true);
              }}
            >
              <span className="sidebar-btn-icon">🔑</span>
              {!sidebarCollapsed && <span className="sidebar-btn-text">修改密码</span>}
            </button>
          </div>

          <div className="sidebar-footer">
            <button className="sidebar-btn danger" title="退出" onClick={handleExit}>
              <span className="sidebar-btn-icon">🚪</span>
              {!sidebarCollapsed && <span className="sidebar-btn-text">退出</span>}
            </button>
          </div>
        </div>

        <div className="learn-body">
          {view === "materials" ? (
            <MaterialsPanel
              materials={materials}
              selectedId={selectedMaterialId}
              onOpen={setSelectedMaterialId}
              onBack={() => setSelectedMaterialId(null)}
            />
          ) : (
            <LearningDashboard childId={child.childId} />
          )}
          <ChatWindow messages={messages} onSend={handleSend} disabled={busy} aiEmoji={aiEmoji} rate={rate} />
        </div>
      </div>

      {showAiSettings && (
        <div className="modal-overlay" onClick={() => setShowAiSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>AI 伙伴设置</h2>
            {aiSettingsMsg && (
              <div style={{ marginBottom: 12, color: aiSettingsMsg.includes("失败") ? "red" : "#48bb78" }}>
                {aiSettingsMsg}
              </div>
            )}

            <label>AI 伙伴名字</label>
            <input
              value={aiName}
              onChange={(e) => setAiName(e.target.value)}
              placeholder="如：知识狐"
            />

            <label>AI 伙伴 Emoji</label>
            <div className="avatar-picker">
              {AI_EMOJIS.map((e) => (
                <div
                  key={e}
                  className={`avatar-option ${aiEmoji === e ? "selected" : ""}`}
                  onClick={() => setAiEmoji(e)}
                >
                  {e}
                </div>
              ))}
            </div>

            <label>AI 伙伴性格</label>
            <textarea
              value={aiPersonality}
              onChange={(e) => setAiPersonality(e.target.value)}
              placeholder="如：温和耐心，喜欢用故事引导"
              style={{
                width: "100%",
                padding: 10,
                border: "1px solid #ddd",
                borderRadius: 8,
                marginBottom: 12,
                minHeight: 60,
              }}
            />

            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowAiSettings(false)}>
                取消
              </button>
              <button className="confirm" onClick={handleSaveAiSettings}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {showChangePassword && (
        <div className="modal-overlay" onClick={() => setShowChangePassword(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>修改密码</h2>
            {changePwdMsg && (
              <div style={{ marginBottom: 12, color: changePwdMsg.includes("已修改") ? "#48bb78" : "red" }}>
                {changePwdMsg}
              </div>
            )}

            <label>旧密码</label>
            <input
              type="password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="输入当前密码"
            />

            <label>新密码</label>
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="输入新密码"
            />

            <label>确认新密码</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="再次输入新密码"
            />

            <div className="modal-actions">
              <button className="cancel" onClick={() => setShowChangePassword(false)}>
                取消
              </button>
              <button className="confirm" onClick={handleChangePassword}>
                确认修改
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

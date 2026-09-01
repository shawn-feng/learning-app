import { useState } from "react";
import { ArrowLeft, KeyRound, Trash2 } from "lucide-react";
import IconButton from "./IconButton";
import LearningDashboard from "./LearningDashboard";
import { ChildTopicsContent } from "./ChildTopicsModal";
import { AgentPromptContent } from "./AgentPromptEditor";
import SessionReview from "./SessionReview";
import ExamRecords from "./ExamRecords";

interface Props {
  child: any;
  onBack: () => void;
  /** 删除孩子成功后的回调（返回列表并刷新） */
  onDeleted: () => void;
}

const TABS = [
  { key: "progress", label: "📊 学习进度" },
  { key: "topics", label: "📚 学习主题" },
  { key: "prompt", label: "🤖 AI 提示词" },
  { key: "exam", label: "🎯 考核记录" },
  { key: "account", label: "🔑 账号密码" },
  { key: "review", label: "💬 对话回顾" },
] as const;

/**
 * 孩子详情页（ISSUE-007）：点击孩子卡片进入，标签页组织
 * 学习进度 / 学习主题 / AI 提示词 / 账号密码，替代原弹窗方案。
 * 各 tab 复用孩子模式同一组件（LearningDashboard / 主题分配 / AgentPromptContent），
 * 保证家长模式与孩子模式界面/操作一致。
 */
export default function ChildDetailPage({ child, onBack, onDeleted }: Props) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("progress");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function handleResetPassword() {
    if (!newPassword.trim()) {
      setError("请输入新密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await window.api.childResetPassword(child.childId, newPassword);
      setNewPassword("");
      setError("✅ 密码已重置");
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleDeleteChild() {
    const r = await window.api.confirmDialog({
      title: "删除孩子",
      message: `确定要删除孩子"${child.name}"吗？`,
      detail: "此操作不可撤销，孩子的所有学习数据都会被删除。",
      confirmLabel: "删除",
      cancelLabel: "取消",
    });
    if (!r?.confirmed) return;
    await window.api.childDelete(child.childId);
    onDeleted();
  }

  return (
    <div>
      {/* 头部：返回 + 孩子信息 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <IconButton icon={ArrowLeft} title="返回孩子列表" onClick={onBack} />
        <div className="child-avatar" style={{ width: 44, height: 44, fontSize: 22 }}>
          {child.avatar}
        </div>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700 }}>{child.name}</div>
          <div className="meta" style={{ fontSize: 12, color: "#888" }}>
            {child.age}岁 · {child.grade} · AI伙伴：{child.aiEmoji || "🤖"} {child.aiName}
          </div>
        </div>
      </div>

      {/* 标签页导航 */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", borderBottom: "1px solid #eee", paddingBottom: 10 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: tab === t.key ? "2px solid #667eea" : "1px solid #ddd",
              background: tab === t.key ? "#eef0ff" : "#fff",
              color: tab === t.key ? "#5a67d8" : "#555",
              fontSize: 13,
              fontWeight: tab === t.key ? 600 : 400,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 标签内容 */}
      {tab === "progress" && (
        <div>
          <LearningDashboard childId={child.childId} />
        </div>
      )}

      {tab === "topics" && (
        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
          <ChildTopicsContent child={child} />
        </div>
      )}

      {tab === "prompt" && (
        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
          <AgentPromptContent
            scope="child"
            refKey={child.childId}
            title={`编辑 AI 提示词 — ${child.aiName || child.name}`}
          />
        </div>
      )}

      {tab === "review" && (
        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>孩子与 AI 的对话回顾</div>
          <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
            读取同步到服务端的完整对话记录（客户端每轮自动同步；需客户端在线并已登录）。
          </p>
          <SessionReview childId={child.childId} />
        </div>
      )}

      {tab === "exam" && (
        <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
          <ExamRecords childId={child.childId} />
        </div>
      )}

      {tab === "account" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 480 }}>
          <div style={{ background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>重置登录密码</div>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
              重置后孩子使用新密码登录（服务端密码校验）。
            </p>
            {error && <div style={{ color: error.startsWith("✅") ? "#38a169" : "#b33", fontSize: 12, marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="输入新密码"
                style={{ flex: 1, padding: "8px 12px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd" }}
              />
              <button
                onClick={handleResetPassword}
                disabled={busy}
                style={{ padding: "8px 16px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer" }}
              >
                {busy ? "重置中…" : "重置密码"}
              </button>
            </div>
          </div>

          <div style={{ background: "#fdf6f6", border: "1px solid #f0d0d0", borderRadius: 10, padding: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8, color: "#b33" }}>危险操作</div>
            <p style={{ margin: "0 0 12px", fontSize: 12, color: "#999" }}>
              删除孩子将移除其所有学习数据（服务端），不可撤销。
            </p>
            <IconButton
              icon={Trash2}
              title="删除孩子"
              danger
              label="删除孩子"
              onClick={handleDeleteChild}
              style={{ padding: "8px 16px", borderRadius: 6, border: "1px solid #e0a0a0", background: "#fff", fontSize: 13, cursor: "pointer" }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

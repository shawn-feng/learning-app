import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { GraduationCap, BookText, FolderOpen, Plus, ClipboardCheck } from "lucide-react";
import IconButton from "./IconButton";
import TopicDetail from "./TopicDetail";
import MaterialManagerModal from "./MaterialManagerModal";

interface ParentTopic {
  name: string;
  topicKey: string;
  method: string;
  /** 每科目考核方法说明（学习考核 assess_method，家长库 topics.assess_method） */
  assessMethod?: string;
  learned: number;
  total: number;
  htmlCount: number;
  rules: Record<string, string>;
}

type Tab = "method" | "course" | "info" | "assess" | "assessMethod";

/**
 * 家长中心「课程管理」页（ISSUE-029）：
 * 主题卡片网格展示每个学习主题，卡片含「教学方法 / 课程详情 / 基本信息」三个按钮，
 * 点击进入该主题的详情页（两列：课程列表 | 标签内容；原中列 AI 对话已移至家长中心
 * 右侧常驻聊天面板，见 ISSUE-050）。
 */
export default function CourseManager() {
  const [topics, setTopics] = useState<ParentTopic[]>([]);
  const [detail, setDetail] = useState<{ topic: ParentTopic; tab: Tab } | null>(null);
  const [newTopic, setNewTopic] = useState({ name: "", topicKey: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [matTopic, setMatTopic] = useState<ParentTopic | null>(null);

  useEffect(() => {
    refreshTopics();
  }, []);

  async function refreshTopics() {
    const r = await window.api.parentListTopics();
    if (r?.success) setTopics(r.data || []);
  }

  async function createTopic() {
    if (!newTopic.name.trim() || !newTopic.topicKey.trim()) {
      setMsg({ ok: false, text: "主题名与目录名都要填" });
      return;
    }
    const r = await window.api.parentUpsertTopic({ name: newTopic.name.trim(), topicKey: newTopic.topicKey.trim(), method: "" });
    if (r?.success) {
      setMsg({ ok: true, text: `已新建主题「${newTopic.name}」` });
      setNewTopic({ name: "", topicKey: "" });
      await refreshTopics();
    } else {
      setMsg({ ok: false, text: r?.error || "新建失败" });
    }
  }

  if (detail) {
    return (
      <TopicDetail
        topic={detail.topic}
        initialTab={detail.tab}
        onBack={() => {
          setDetail(null);
          refreshTopics();
        }}
      />
    );
  }

  return (
    <div>
      <h3 style={{ margin: 0, marginBottom: 4 }}>课程管理</h3>
      <p className="desc" style={{ margin: "0 0 12px" }}>
        每个学习主题一张卡片，进入后维护课程、教学方法与资料，或让 AI 协助创建课程。
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <input
          value={newTopic.name}
          onChange={(e) => setNewTopic((p) => ({ ...p, name: e.target.value }))}
          placeholder="新主题名（如 三字经）"
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, width: 160 }}
        />
        <input
          value={newTopic.topicKey}
          onChange={(e) => setNewTopic((p) => ({ ...p, topicKey: e.target.value }))}
          placeholder="目录名（如 sanzijing）"
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, width: 140 }}
        />
        <button
          onClick={createTopic}
          style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}
        >
          <Plus size={16} /> 新建主题
        </button>
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 8,
            background: msg.ok ? "#e8f7ee" : "#fdecec",
            color: msg.ok ? "#2f8a52" : "#b33",
          }}
        >
          {msg.text}
        </div>
      )}

      {topics.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>家长库暂无主题。可先新建主题，或在「孩子管理 → 学习主题」里迁移存量资料。</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 16 }}>
          {topics.map((t) => (
            <div
              key={t.topicKey}
              style={{
                border: "1px solid #eee",
                borderRadius: 12,
                padding: "14px 16px",
                background: "#fff",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700 }}>
                {t.name}
                <span style={{ color: "#aaa", fontWeight: 400, fontSize: 12 }}>（{t.topicKey}）</span>
              </div>
              <div style={{ fontSize: 12, color: "#888", margin: "6px 0 12px" }}>
                {t.total} 门课程 · html 资料 {t.htmlCount} 份 · 方法{t.method ? "已填写" : "未填写"}
                · 考核{t.assessMethod ? "已填写" : "未填写"}
                {t.rules?.daily ? ` · 每日 ${t.rules.daily} 课` : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <CardBtn icon={GraduationCap} title="教学方法" onClick={() => setDetail({ topic: t, tab: "method" })} />
                <CardBtn icon={ClipboardCheck} title="考核方法" onClick={() => setDetail({ topic: t, tab: "assessMethod" })} />
                <CardBtn icon={BookText} title="课程详情" primary onClick={() => setDetail({ topic: t, tab: "course" })} />
                <CardBtn icon={FolderOpen} title="学习资料管理" onClick={() => setMatTopic(t)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {matTopic && <MaterialManagerModal topicDir={matTopic.topicKey} topicName={matTopic.name} onClose={() => setMatTopic(null)} />}
    </div>
  );
}

function CardBtn({ icon, title, onClick, primary }: { icon: LucideIcon; title: string; onClick: () => void; primary?: boolean }) {
  return (
    <IconButton
      icon={icon}
      title={title}
      className={primary ? "card-primary" : ""}
      style={{ flex: 1 }}
      onClick={onClick}
    />
  );
}

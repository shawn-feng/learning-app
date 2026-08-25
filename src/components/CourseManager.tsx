import { useEffect, useState } from "react";
import TopicDetail from "./TopicDetail";
import MaterialManagerModal from "./MaterialManagerModal";

interface ParentTopic {
  name: string;
  file: string;
  method: string;
  learned: number;
  total: number;
  htmlCount: number;
  rules: Record<string, string>;
}

type Tab = "method" | "course" | "info";

/**
 * 家长中心「课程管理」页（ISSUE-029）：
 * 主题卡片网格展示每个学习主题，卡片含「教学方法 / 课程详情 / 基本信息」三个按钮，
 * 点击进入该主题的详情页（三列：课程列表 | AI 对话 | 标签内容）。
 */
export default function CourseManager() {
  const [topics, setTopics] = useState<ParentTopic[]>([]);
  const [detail, setDetail] = useState<{ topic: ParentTopic; tab: Tab } | null>(null);
  const [newTopic, setNewTopic] = useState({ name: "", file: "" });
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
    if (!newTopic.name.trim() || !newTopic.file.trim()) {
      setMsg({ ok: false, text: "主题名与目录名都要填" });
      return;
    }
    const r = await window.api.parentUpsertTopic({ name: newTopic.name.trim(), file: newTopic.file.trim(), method: "" });
    if (r?.success) {
      setMsg({ ok: true, text: `已新建主题「${newTopic.name}」` });
      setNewTopic({ name: "", file: "" });
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
          value={newTopic.file}
          onChange={(e) => setNewTopic((p) => ({ ...p, file: e.target.value }))}
          placeholder="目录名（如 sanzijing）"
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13, width: 140 }}
        />
        <button
          onClick={createTopic}
          style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 12, cursor: "pointer" }}
        >
          + 新建主题
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
              key={t.file}
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
                <span style={{ color: "#aaa", fontWeight: 400, fontSize: 12 }}>（{t.file}）</span>
              </div>
              <div style={{ fontSize: 12, color: "#888", margin: "6px 0 12px" }}>
                {t.total} 门课程 · html 资料 {t.htmlCount} 份 · 方法{t.method ? "已填写" : "未填写"}
                {t.rules?.daily ? ` · 每日 ${t.rules.daily} 课` : ""}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <CardBtn label="📖 教学方法" onClick={() => setDetail({ topic: t, tab: "method" })} />
                <CardBtn label="📚 课程详情" primary onClick={() => setDetail({ topic: t, tab: "course" })} />
                <CardBtn label="🗂 学习资料管理" onClick={() => setMatTopic(t)} />
              </div>
            </div>
          ))}
        </div>
      )}
      {matTopic && <MaterialManagerModal topicDir={matTopic.file} topicName={matTopic.name} onClose={() => setMatTopic(null)} />}
    </div>
  );
}

function CardBtn({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        padding: "8px 6px",
        borderRadius: 8,
        border: "none",
        fontSize: 12,
        cursor: "pointer",
        background: primary ? "#667eea" : "#f0f4ff",
        color: primary ? "#fff" : "#667eea",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

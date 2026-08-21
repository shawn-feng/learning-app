import { useEffect, useState } from "react";

interface ChildInfo {
  childId: string;
  name: string;
}

interface ParentTopic {
  name: string;
  file: string;
  method: string;
  learned: number;
  total: number;
  htmlCount: number;
}

interface AllocateResult {
  copied: number;
  existing: number;
}

interface MigrateResult {
  topics: number;
  htmlMoved: number;
  htmlSkippedShared: number;
  coursesUpdated: number;
  materialsDirsRemoved: number;
}

interface Props {
  child: ChildInfo;
  onClose: () => void;
}

/**
 * 孩子管理页「学习主题」弹窗（ISSUE-029）：
 * 从家长主题库给孩子「添加学习主题」（快照拷贝，不覆盖孩子进度）。
 */
export default function ChildTopicsModal({ child, onClose }: Props) {
  const [topics, setTopics] = useState<ParentTopic[]>([]);
  const [allocated, setAllocated] = useState<Set<string>>(new Set()); // topicDir 集合
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [child.childId]);

  async function refresh() {
    const [t, a] = await Promise.all([
      window.api.parentListTopics(),
      window.api.parentListChildTopics(child.childId),
    ]);
    setTopics(t?.success ? t.data || [] : []);
    const dirs = (a?.success ? a.data || [] : []).map((x: any) => x.file);
    setAllocated(new Set(dirs));
  }

  async function addTopic(topicDir: string) {
    setBusy(`add-${topicDir}`);
    setMsg(null);
    try {
      const r = await window.api.parentAllocate(child.childId, topicDir);
      if (r?.success) {
        const d: AllocateResult = r.data;
        setMsg({
          ok: true,
          text: `已添加「${topicDir}」：新增 ${d.copied} 课，已存在 ${d.existing} 课（进度保留）`,
        });
        await refresh();
      } else {
        setMsg({ ok: false, text: r?.error || "添加失败" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  async function runMigrate() {
    if (!window.confirm("⚠️ 存量迁移会把孩子目录下的 html/媒体资料移到家长库共享目录并删除孩子侧副本。确定继续？")) return;
    setBusy("migrate");
    setMsg(null);
    try {
      const r = await window.api.parentMigrate();
      if (r?.success) {
        const d: MigrateResult = r.data;
        setMsg({
          ok: true,
          text: `迁移完成：method ${d.topics} 主题、html 移动 ${d.htmlMoved}（共享跳过 ${d.htmlSkippedShared}）、课程 ${d.coursesUpdated}、删除空目录 ${d.materialsDirsRemoved}`,
        });
        await refresh();
      } else {
        setMsg({ ok: false, text: r?.error || "迁移失败" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <h2 style={{ marginBottom: 4 }}>学习主题 — {child.name}</h2>
        <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
          从家长主题库给孩子添加学习主题（添加后孩子即可学习该主题；再次添加不会覆盖孩子进度）
        </p>

        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
          <button
            onClick={runMigrate}
            disabled={busy !== null}
            style={{ padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 12, cursor: "pointer" }}
          >
            {busy === "migrate" ? "迁移中…" : "🔄 迁移存量资料到家长库"}
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
          <p style={{ color: "#888", fontSize: 13 }}>家长库暂无主题。点击上方「迁移存量资料」把现有孩子的主题/资料导入家长库。</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "50vh", overflowY: "auto" }}>
            {topics.map((t) => {
              const has = allocated.has(t.file);
              return (
                <div
                  key={t.file}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 12px",
                    background: "#fff",
                    borderRadius: 8,
                    border: "1px solid #f0f0f0",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {t.name}
                      <span style={{ color: "#aaa", fontWeight: 400 }}>（{t.file}）</span>
                    </div>
                    <div style={{ fontSize: 11, color: "#888", marginTop: 2 }}>
                      {t.total} 课 · html 资料 {t.htmlCount} 份 · method {t.method ? "已入库" : "未导入"}
                    </div>
                  </div>
                  {has ? (
                    <span
                      style={{
                        padding: "5px 12px",
                        borderRadius: 6,
                        fontSize: 12,
                        background: "#eef5ee",
                        color: "#38a169",
                        whiteSpace: "nowrap",
                      }}
                    >
                      ✓ 已添加
                    </span>
                  ) : (
                    <button
                      onClick={() => addTopic(t.file)}
                      disabled={busy !== null}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 6,
                        border: "none",
                        background: "#667eea",
                        color: "#fff",
                        fontSize: 12,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {busy === `add-${t.file}` ? "添加中…" : "+ 添加主题"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="cancel" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

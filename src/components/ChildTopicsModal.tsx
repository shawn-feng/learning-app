import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { Plus, Trash2 } from "lucide-react";

interface ChildInfo {
  childId: string;
  name: string;
}

interface ParentTopic {
  name: string;
  topicKey: string;
  method: string;
  learned: number;
  total: number;
  htmlCount: number;
  rules?: Record<string, string>;
}

interface AllocateResult {
  copied: number;
  existing: number;
}


interface ChildTopicInfo {
  name: string;
  topicKey: string;
  daily: string;
  type: string;
}

interface Props {
  child: ChildInfo;
  onClose: () => void;
}

const DAILY_TYPES = ["必学", "选学", "复习"];

/**
 * 孩子管理页「学习主题」弹窗（ISSUE-029 / ISSUE-031）：
 * 从家长主题库给孩子「添加学习主题」（快照拷贝，不覆盖孩子进度）；
 * 添加时可设置、添加后也可随时修改「每天学习量」（daily + type，存孩子库 topics.rules_json）。
 */
export function ChildTopicsContent({ child }: { child: ChildInfo }) {
  const [topics, setTopics] = useState<ParentTopic[]>([]);
  const [allocated, setAllocated] = useState<Map<string, ChildTopicInfo>>(new Map()); // topicKey → 信息
  const [busy, setBusy] = useState<string | null>(null);
  const [addPanel, setAddPanel] = useState<{ topicKey: string; daily: string; type: string } | null>(null);
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
    const map = new Map<string, ChildTopicInfo>();
    for (const x of a?.success ? a.data || [] : []) {
      map.set(x.topicKey, { name: x.name, topicKey: x.topicKey, daily: x.daily || "", type: x.type || "" });
    }
    setAllocated(map);
  }

  async function addTopic(topicDir: string, daily: string, type: string) {
    setBusy(`add-${topicDir}`);
    setMsg(null);
    try {
      const r = await window.api.parentAllocate(child.childId, topicDir);
      if (r?.success) {
        const d: AllocateResult = r.data;
        // 分配后立刻写入每天学习量（ISSUE-031：默认带父库量，可独立改写）
        if (daily || type) {
          await window.api.parentSetChildTopicDaily(child.childId, topicDir, daily, type);
        }
        setMsg({
          ok: true,
          text: `已添加「${topicDir}」：新增 ${d.copied} 课，已存在 ${d.existing} 课（进度保留）`,
        });
        setAddPanel(null);
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

  async function saveDaily(info: ChildTopicInfo) {
    setBusy(`daily-${info.topicKey}`);
    setMsg(null);
    try {
      const r = await window.api.parentSetChildTopicDaily(
        child.childId,
        info.topicKey,
        info.daily,
        info.type
      );
      if (r?.success) {
        setMsg({ ok: true, text: `已保存「${info.name}」每天学习量：${info.daily || "—"}（${info.type || "未设类型"}）` });
        await refresh();
      } else {
        setMsg({ ok: false, text: r?.error || "保存失败" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  // ISSUE-004：移除孩子的某主题。有学习记录时提示「记录保留」；
  // 只取消分配（孩子端不再学习该主题），进度留在服务端，重新添加可续上。
  async function removeTopic(info: ChildTopicInfo) {
    const c = await window.api.confirmDialog({
      title: "移除学习主题",
      message: `确定移除「${info.name}」吗？`,
      detail: "移除后孩子端不再学习该主题；已有的学习记录会保留（重新添加时可继续）。",
      confirmLabel: "移除",
      cancelLabel: "取消",
    });
    if (!c?.confirmed) return;
    setBusy(`remove-${info.topicKey}`);
    setMsg(null);
    try {
      const r = await window.api.parentDeallocate(child.childId, info.topicKey);
      if (r?.success) {
        setMsg({ ok: true, text: `已移除「${info.name}」（学习记录已保留）` });
        await refresh();
      } else {
        setMsg({ ok: false, text: r?.error || "移除失败" });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>学习主题 — {child.name}</div>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "#888" }}>
        从家长主题库给孩子添加学习主题（添加后孩子即可学习该主题；再次添加不会覆盖孩子进度）
      </p>

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
          <p style={{ color: "#888", fontSize: 13 }}>家长库暂无主题，请在家长端课程管理中添加主题后再给孩子分配。</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "52vh", overflowY: "auto" }}>
            {topics.map((t) => {
              const info = allocated.get(t.topicKey);
              const has = !!info;
              const isAdding = addPanel?.topicKey === t.topicKey;
              return (
                <div
                  key={t.topicKey}
                  style={{
                    padding: "8px 12px",
                    background: "#fff",
                    borderRadius: 8,
                    border: "1px solid #f0f0f0",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {t.name}
                        <span style={{ color: "#aaa", fontWeight: 400 }}>（{t.topicKey}）</span>
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
                    ) : isAdding ? (
                      <span style={{ fontSize: 12, color: "#38a169", whiteSpace: "nowrap" }}>设置中…</span>
                    ) : (
                      <IconButton
                        icon={Plus}
                        title="添加主题"
                        onClick={() =>
                          setAddPanel({
                            topicKey: t.topicKey,
                            daily: (t.rules?.daily as string) || "",
                            type: (t.rules?.type as string) || "必学",
                          })
                        }
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
                      />
                    )}
                  </div>

                  {/* 分配时弹框：设置每天学习量 */}
                  {isAdding && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: "1px dashed #eee",
                      }}
                    >
                      <label style={{ fontSize: 12, color: "#666" }}>每天学习量</label>
                      <input
                        type="text"
                        value={addPanel?.daily || ""}
                        placeholder="如 3 或 1 内容单元"
                        onChange={(e) => setAddPanel({ ...addPanel!, daily: e.target.value })}
                        style={{ width: 120, padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                      <select
                        value={addPanel?.type || "必学"}
                        onChange={(e) => setAddPanel({ ...addPanel!, type: e.target.value })}
                        style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd" }}
                      >
                        {DAILY_TYPES.map((tp) => (
                          <option key={tp} value={tp}>
                            {tp}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => addTopic(addPanel!.topicKey, addPanel!.daily, addPanel!.type)}
                        disabled={busy !== null}
                        style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#38a169", color: "#fff", fontSize: 12, cursor: "pointer" }}
                      >
                        {busy === `add-${addPanel!.topicKey}` ? "添加中…" : "确认添加"}
                      </button>
                      <button
                        onClick={() => setAddPanel(null)}
                        style={{ padding: "5px 12px", borderRadius: 6, border: "1px solid #ddd", background: "#fff", fontSize: 12, cursor: "pointer" }}
                      >
                        取消
                      </button>
                    </div>
                  )}

                  {/* 分配后可编辑：每天学习量 */}
                  {has && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        marginTop: 10,
                        paddingTop: 10,
                        borderTop: "1px dashed #eee",
                      }}
                    >
                      <label style={{ fontSize: 12, color: "#666" }}>每天学习量</label>
                      <input
                        type="text"
                        value={info.daily}
                        placeholder="如 3 或 1 内容单元"
                        onChange={(e) =>
                          setAllocated(
                            new Map(allocated).set(t.topicKey, { ...info, daily: e.target.value })
                          )
                        }
                        style={{ width: 120, padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd" }}
                      />
                      <select
                        value={info.type}
                        onChange={(e) =>
                          setAllocated(
                            new Map(allocated).set(t.topicKey, { ...info, type: e.target.value })
                          )
                        }
                        style={{ padding: "4px 8px", fontSize: 12, borderRadius: 6, border: "1px solid #ddd" }}
                      >
                        {DAILY_TYPES.map((tp) => (
                          <option key={tp} value={tp}>
                            {tp}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => saveDaily(info)}
                        disabled={busy !== null}
                        style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 12, cursor: "pointer" }}
                      >
                        {busy === `daily-${t.topicKey}` ? "保存中…" : "保存"}
                      </button>
                      <IconButton
                        icon={Trash2}
                        title="移除主题（学习记录保留）"
                        danger
                        onClick={() => removeTopic(info)}
                        disabled={busy !== null}
                        style={{ marginLeft: "auto" }}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

    </>
  );
}

/** 弹窗容器（孩子管理页历史入口）；详情页用 ChildTopicsContent 平铺展示。 */
export default function ChildTopicsModal({ child, onClose }: Props) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <ChildTopicsContent child={child} />
        <div className="modal-actions">
          <button className="cancel" onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}

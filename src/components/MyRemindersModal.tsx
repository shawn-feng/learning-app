import { useCallback, useEffect, useState } from "react";
import { Bell, Trash2, X } from "lucide-react";

/**
 * ISSUE-047 方案A（孩子端「我的提醒」，2026-09-04）：
 * 孩子端独立的定时提醒管理弹框——与「今日计划/Todolist」分离（提醒不一定是"要做的事"，
 * 如喝水/休息/吃药等，故不放进计划语义里）。入口为孩子端侧栏 🔔 图标。
 *
 * 数据源：服务端 GET /scheduler/reminders/list（经 scheduler:reminder:list IPC），
 * 仅列该孩子**自建(owner=child)**的提醒，不含家长系统任务；每条可「取消」（复用 task:delete）。
 */
interface ReminderRow {
  id: string;
  name: string;
  text: string;
  time: string;
  frequency: "once" | "daily" | "weekly" | "interval";
  weekday: number | null;
  intervalMinutes: number | null;
  voice: boolean;
  fireAt: string | null;
  owner?: string;
  enabled: boolean;
  expired: boolean;
  createdAt: string;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

function fmtWhen(r: ReminderRow): string {
  if (r.frequency === "once") {
    const d = r.fireAt ? new Date(r.fireAt) : null;
    return d ? `一次性 · ${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : "一次性";
  }
  if (r.frequency === "interval") return `每 ${r.intervalMinutes} 分钟`;
  const time = r.time || "";
  if (r.frequency === "weekly") return `每周${WEEK[r.weekday ?? 0]} ${time}`;
  return `每天 ${time}`;
}

export default function MyRemindersModal({
  childId,
  onClose,
}: {
  childId: string;
  onClose: () => void;
}) {
  const [rows, setRows] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await window.api.reminderList(childId);
      if (res?.success) {
        const list = Array.isArray(res.reminders) ? (res.reminders as ReminderRow[]) : [];
        // 仅展示孩子自建且未过期/启用的，按时间排序（once 优先最近到期的）
        setRows(list);
      } else {
        setErr(res?.error || "加载失败");
      }
    } catch (e: any) {
      setErr(e?.message || "加载失败");
    } finally {
      setLoading(false);
    }
  }, [childId]);

  useEffect(() => {
    load();
  }, [load]);

  const cancel = async (r: ReminderRow) => {
    if (busyId) return;
    setBusyId(r.id);
    setErr("");
    try {
      const res = await window.api.reminderCancel(r.id);
      if (!res?.success) {
        setErr(res?.error || "取消失败");
      } else {
        setRows((prev) => prev.filter((x) => x.id !== r.id));
      }
    } catch (e: any) {
      setErr(e?.message || "取消失败");
    } finally {
      setBusyId(null);
    }
  };

  // 排序：进行中的（enabled 且未过期）在前，已停用/已过期在后；内部按下一次触发临近排序
  const active = rows.filter((r) => r.enabled && !r.expired);
  const inactive = rows.filter((r) => !r.enabled || r.expired);
  const sorted = [
    ...active.sort((a, b) => {
      if (a.frequency === "once" && b.frequency !== "once") return -1;
      if (a.frequency !== "once" && b.frequency === "once") return 1;
      return (a.time || "").localeCompare(b.time || "");
    }),
    ...inactive,
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: "92vw" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 8,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 8 }}>
            <Bell size={18} style={{ color: "#eab308" }} /> 我的提醒
          </h2>
          <button
            onClick={onClose}
            title="关闭"
            style={{ border: "none", background: "transparent", cursor: "pointer", color: "#888", padding: 4 }}
          >
            <X size={20} />
          </button>
        </div>
        <div style={{ fontSize: 12, color: "#999", marginBottom: 12, lineHeight: 1.6 }}>
          你让 AI 伙伴帮你设的定时提醒。到点会<strong>语音播报</strong>并弹横幅（点横幅关闭）。
          <br />
          想新增提醒，直接对 AI 伙伴说，例如"每天 9 点提醒我读英语"。
        </div>

        {err && (
          <div style={{ fontSize: 12, color: "#c0392b", background: "#fdf0ef", padding: "8px 10px", borderRadius: 6, marginBottom: 8 }}>
            {err}
          </div>
        )}

        {loading ? (
          <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
        ) : sorted.length === 0 ? (
          <div style={{ textAlign: "center", color: "#999", fontSize: 13, padding: "28px 0", lineHeight: 1.8 }}>
            还没有提醒。
            <br />
            可以对 AI 伙伴说："半小时后提醒我喝水""每天 9 点提醒我读英语"
          </div>
        ) : (
          <div style={{ maxHeight: 420, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
            {sorted.map((r) => {
              const off = !r.enabled || r.expired;
              return (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    border: "1px solid #eee",
                    borderRadius: 10,
                    padding: "10px 12px",
                    background: "#fff",
                    opacity: off ? 0.55 : 1,
                  }}
                >
                  <span style={{ fontSize: 18 }}>{r.voice ? "🔊" : "🔔"}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name || "提醒"}
                      </span>
                      {off && (
                        <span style={{ fontSize: 10, background: "#eee", color: "#888", borderRadius: 6, padding: "0 5px", flexShrink: 0 }}>
                          {r.expired ? "已过期" : "已停用"}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", lineHeight: 1.5 }}>
                      {r.text}
                    </div>
                    <div style={{ fontSize: 11, color: "#999", marginTop: 2 }}>
                      {fmtWhen(r)}
                      {r.voice ? "" : " · 仅响铃"}
                    </div>
                  </div>
                  <button
                    title="取消这个提醒"
                    onClick={() => cancel(r)}
                    disabled={busyId === r.id}
                    style={{
                      border: "1px solid #f0caca",
                      background: "#fdf3f3",
                      color: "#c0392b",
                      borderRadius: 8,
                      padding: "6px 10px",
                      fontSize: 12,
                      cursor: "pointer",
                      flexShrink: 0,
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                    }}
                  >
                    {busyId === r.id ? "…" : <><Trash2 size={13} /> 取消</>}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

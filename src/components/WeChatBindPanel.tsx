/**
 * 微信绑定面板（设置 → 微信绑定，2026-09-17）。
 * 展示待确认的绑定请求（未绑定微信号发来消息时 server 自动落一条），家长确认身份后即完成绑定；
 * 同时管理已绑定列表（解绑）。轮询 15s：新微信消息落地后无需刷新页面即可看到。
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface BindRequest {
  id: string;
  wechat_id: string;
  channel?: string;
  sample_text: string;
  first_seen: string;
  last_seen: string;
}
interface Binding {
  wechat_id: string;
  channel?: string;
  role: "parent" | "child";
  child_id: string;
  label: string;
  created_at: string;
}

const CHANNEL_LABEL: Record<string, string> = { wechat: "微信", feishu: "飞书" };
const channelBadge = (ch?: string): React.CSSProperties => {
  const feishu = ch === "feishu";
  return {
    marginLeft: 8,
    fontSize: 11,
    borderRadius: 999,
    padding: "1px 8px",
    background: feishu ? "#e8f4fd" : "#eef2ff",
    color: feishu ? "#1a7ac4" : "#3b4cca",
  };
};

const card: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e6eaf0",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 12,
};
const btn: React.CSSProperties = {
  border: "none",
  borderRadius: 8,
  padding: "7px 16px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

export default function WeChatBindPanel() {
  const [requests, setRequests] = useState<BindRequest[]>([]);
  const [bindings, setBindings] = useState<Binding[]>([]);
  const [childrenList, setChildrenList] = useState<Array<{ id: string; name: string }>>([]);
  const [childChoice, setChildChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const [rq, bd] = await Promise.all([window.api.wechatBindRequests(), window.api.wechatBindings()]);
    if (rq?.success) setRequests(rq.data?.requests || []);
    if (bd?.success) setBindings(bd.data?.bindings || []);
  }, []);

  useEffect(() => {
    window.api.childList().then((r: any) => {
      if (r?.success) setChildrenList(r.data || []);
    });
    load();
    timer.current = window.setInterval(load, 15000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  const decide = async (req: BindRequest, action: "confirm" | "reject", role?: "parent" | "child") => {
    setBusy(true);
    setNotice("");
    try {
      const childId = role === "child" ? childChoice[req.id] || "" : undefined;
      if (role === "child" && !childId) {
        setNotice("请先选择要绑定的孩子");
        return;
      }
      const label = role === "child" ? childrenList.find((c) => c.id === childId)?.name || "" : "家长";
      const r = await window.api.wechatBindDecide({ id: req.id, action, role, childId, label });
      if (r?.success && (r.data as any)?.ok) {
        setNotice(action === "confirm" ? "已绑定 ✅ 对方再发一条微信即可对话" : "已忽略");
        await load();
      } else {
        setNotice(`操作失败：${r?.error || (r?.data as any)?.error || "未知错误"}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const unbind = async (wechatId: string) => {
    setBusy(true);
    try {
      await window.api.wechatBindingRemove(wechatId);
      setNotice("已解绑");
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>📱 微信绑定</div>
      <p style={{ color: "#6b7686", fontSize: 13, margin: "0 0 14px" }}>
        家人用微信（发给 ClawBot）或飞书（发给学习伙伴机器人）发消息即可接入学习伙伴：未绑定的账号会出现在下方
        「待确认」里，点确认并选择身份（家长/孩子）后，对方就能在对应渠道里直接和 agent 对话。
        孩子身份只能使用受控功能（考核与积分只读）。
      </p>

      {notice && (
        <div style={{ ...card, borderColor: "#bfe3cd", background: "#f2fbf5", color: "#27754a", fontSize: 13 }}>
          {notice}
        </div>
      )}

      <div style={{ fontSize: 14, fontWeight: 700, margin: "6px 0 8px" }}>待确认请求（{requests.length}）</div>
      {requests.length === 0 ? (
        <div style={{ ...card, color: "#98a2b0", fontSize: 13 }}>暂无。让家人用微信给 ClawBot 发一条消息，请求会自动出现在这里。</div>
      ) : (
        requests.map((r) => (
          <div key={r.id} style={{ ...card, borderColor: "#c9d8ff" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
              <span style={{ fontWeight: 700, fontSize: 13, wordBreak: "break-all" }}>{r.wechat_id}</span>
              <span style={channelBadge(r.channel)}>{CHANNEL_LABEL[r.channel || "wechat"] || r.channel}</span>
              <span style={{ color: "#98a2b0", fontSize: 12 }}>最近活跃 {r.last_seen}</span>
            </div>
            {r.sample_text && (
              <div style={{ color: "#555", fontSize: 13, margin: "4px 0 8px" }}>
                消息样本：「{r.sample_text}」
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button disabled={busy} style={{ ...btn, background: "#3b6ef5", color: "#fff" }} onClick={() => decide(r, "confirm", "parent")}>
                绑定为家长
              </button>
              <select
                value={childChoice[r.id] || ""}
                onChange={(e) => setChildChoice((p) => ({ ...p, [r.id]: e.target.value }))}
                style={{ border: "1px solid #ddd", borderRadius: 8, padding: "6px 8px", fontSize: 13 }}
              >
                <option value="">选择孩子…</option>
                {childrenList.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button disabled={busy} style={{ ...btn, background: "#27ae60", color: "#fff" }} onClick={() => decide(r, "confirm", "child")}>
                绑定为孩子
              </button>
              <button disabled={busy} style={{ ...btn, background: "#f0f2f5", color: "#666" }} onClick={() => decide(r, "reject")}>
                忽略
              </button>
            </div>
          </div>
        ))
      )}

      <div style={{ fontSize: 14, fontWeight: 700, margin: "16px 0 8px" }}>已绑定（{bindings.length}）</div>
      {bindings.length === 0 ? (
        <div style={{ ...card, color: "#98a2b0", fontSize: 13 }}>还没有绑定任何微信号。</div>
      ) : (
        bindings.map((b) => (
          <div key={b.wechat_id} style={{ ...card, display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 13 }}>
                {b.label || (b.role === "parent" ? "家长" : "孩子")}
                <span style={channelBadge(b.channel)}>{CHANNEL_LABEL[b.channel || "wechat"] || b.channel}</span>
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 11,
                    borderRadius: 999,
                    padding: "1px 8px",
                    background: b.role === "parent" ? "#eef2ff" : "#e8f7ee",
                    color: b.role === "parent" ? "#3b4cca" : "#27754a",
                  }}
                >
                  {b.role === "parent" ? "家长" : "孩子"}
                </span>
              </div>
              <div style={{ color: "#98a2b0", fontSize: 12, wordBreak: "break-all" }}>{b.wechat_id}</div>
            </div>
            <button disabled={busy} style={{ ...btn, background: "#fdecea", color: "#c0392b" }} onClick={() => unbind(b.wechat_id)}>
              解绑
            </button>
          </div>
        ))
      )}
    </div>
  );
}

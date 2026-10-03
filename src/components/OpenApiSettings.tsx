/**
 * 开放 API 面板（设置 → 开放接口；2026-09-28）。
 * 一账号一有效 Key：生成（一次性展示完整 Key）→ 查看（只显示 prefix + 用量）→ 吊销 / 重新生成。
 * 绑定默认孩子：Key 的对话对象（第三方请求可用 child_id 覆盖）。
 * 服务端：server/src/routes/apikeys.ts（管理）+ open-api.ts（第三方调用）。
 */
import { useCallback, useEffect, useState } from "react";

interface KeyInfo {
  id: string;
  prefix: string;
  child_id: string;
  label: string;
  last_used_at: string | null;
  request_count: number;
  created_at: string;
}

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

function fmtTime(iso: string | null): string {
  if (!iso) return "从未使用";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function OpenApiSettings() {
  const [keyInfo, setKeyInfo] = useState<KeyInfo | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [children, setChildren] = useState<Array<{ id: string; name: string }>>([]);
  const [childId, setChildId] = useState("");
  const [label, setLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // 一次性展示完整 Key（关掉弹窗后不再可见）
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [showExample, setShowExample] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await window.api.openApiKeyGet();
    if (r?.success) {
      setKeyInfo((r.data as any)?.key ?? null);
    } else {
      setErr(r?.error || "读取失败");
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
    // childList 返回 ChildProfile[]：孩子 id 字段是 childId（不是 id）——
    // 取错字段会让 <option> 退化成"用选项文字当 value"，提交出 "珊珊" 这种非法 child_id
    window.api.childList().then((r: any) => {
      const list = Array.isArray(r) ? r : r?.children || [];
      setChildren(
        list
          .map((c: any) => ({ id: String(c?.childId ?? c?.id ?? ""), name: String(c?.name ?? "") }))
          .filter((c: { id: string }) => c.id)
      );
    }).catch(() => {});
  }, [load]);

  async function handleCreate() {
    setErr("");
    setBusy(true);
    try {
      const r = await window.api.openApiKeyCreate({ child_id: childId || undefined, label: label.trim() || undefined });
      if (!r?.success) {
        setErr(r?.error || "生成失败");
        return;
      }
      const d = r.data as any;
      setSecret(String(d?.secret ?? ""));
      setCopied(false);
      setLabel("");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    setErr("");
    const c = await window.api.confirmDialog({
      title: "吊销 API Key",
      message: "确认吊销当前 API Key？",
      detail: "吊销后所有正在使用这个 Key 的第三方设备立即失去访问权限（401）。吊销后可以再生成新 Key。",
      confirmLabel: "吊销",
    });
    if (!c) return;
    setBusy(true);
    try {
      const r = await window.api.openApiKeyRevoke();
      if (!r?.success) {
        setErr(r?.error || "吊销失败");
        return;
      }
      setNotice("已吊销。第三方设备下次请求将收到 401。");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function handleRegenerate() {
    setErr("");
    const c = await window.api.confirmDialog({
      title: "重新生成 API Key",
      message: "确认重新生成 API Key？",
      detail: "旧 Key 立即失效（第三方设备需更新为新 Key），新 Key 只展示一次。",
      confirmLabel: "重新生成",
    });
    if (!c) return;
    setBusy(true);
    try {
      await window.api.openApiKeyRevoke();
      // 重新生成沿用原绑定与备注
      const r = await window.api.openApiKeyCreate(
        keyInfo ? { child_id: keyInfo.child_id || undefined, label: keyInfo.label || undefined } : {}
      );
      if (!r?.success) {
        setErr(r?.error || "重新生成失败");
        await load();
        return;
      }
      setSecret(String((r.data as any)?.secret ?? ""));
      setCopied(false);
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const childName = (id: string) => children.find((c) => c.id === id)?.name || id || "（未绑定）";

  return (
    <div className="settings-section">
      <h3>开放接口</h3>
      <p className="desc">
        生成 API Key 后，第三方系统（如 ESP32 硬件、自动化脚本）可以通过开放 API 与服务端 agent 对话，
        能力与 app 内聊天框一致（文字 / 图片 / 文件 / 音频附件、思考过程、工具调用）。
        每个账号同时只有一个有效 Key。
      </p>

      {err && <p style={{ color: "#c0392b", fontSize: 13 }}>{err}</p>}
      {notice && <p style={{ color: "#27ae60", fontSize: 13 }}>{notice}</p>}

      {!loaded ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
      ) : keyInfo ? (
        <div style={card}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <strong style={{ fontSize: 14 }}>当前 API Key</strong>
            <span style={{ fontSize: 12, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 10px" }}>
              {keyInfo.prefix}…
            </span>
          </div>
          <div style={{ fontSize: 13, color: "#444", lineHeight: 1.9 }}>
            <div>默认对话对象：{childName(keyInfo.child_id)}</div>
            {keyInfo.label && <div>备注：{keyInfo.label}</div>}
            <div>创建时间：{fmtTime(keyInfo.created_at)}</div>
            <div>最近使用：{fmtTime(keyInfo.last_used_at)}（累计 {keyInfo.request_count} 次请求）</div>
          </div>
          <p style={{ fontSize: 12, color: "#98a2b0", margin: "8px 0 12px" }}>
            完整 Key 仅在生成时展示一次，此处只显示前缀。遗失请重新生成。
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleRegenerate} disabled={busy} style={{ ...btn, background: "#667eea", color: "#fff" }}>
              重新生成
            </button>
            <button onClick={handleRevoke} disabled={busy} style={{ ...btn, background: "#fff", color: "#c0392b", border: "1px solid #e6b3ac" }}>
              吊销
            </button>
          </div>
        </div>
      ) : (
        <div style={card}>
          <div style={{ fontSize: 14, marginBottom: 10 }}>还没有 API Key —— 生成一个：</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <select
              value={childId}
              onChange={(e) => setChildId(e.target.value)}
              style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, minWidth: 180 }}
            >
              <option value="">（不绑定，请求须带 child_id）</option>
              {children.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <input
              placeholder="备注（可选，如：客厅的硬件）"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              style={{ flex: 1, minWidth: 200, padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8 }}
            />
            <button onClick={handleCreate} disabled={busy} style={{ ...btn, background: "#667eea", color: "#fff" }}>
              生成 API Key
            </button>
          </div>
          <p style={{ fontSize: 12, color: "#98a2b0", margin: "8px 0 0" }}>
            建议绑定默认孩子：硬件端无需关心 childId，直接对话即可。
          </p>
        </div>
      )}

      {/* 完整 Key 一次性展示 */}
      {secret && (
        <div style={{ ...card, border: "2px solid #667eea" }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>API Key 已生成（仅此一次展示）</div>
          <p style={{ fontSize: 12, color: "#c0392b", margin: "0 0 10px" }}>
            请立即复制并保存到第三方设备。关闭本弹窗后无法再次查看，只能重新生成。
          </p>
          <code
            style={{
              display: "block",
              background: "#f6f8fa",
              border: "1px solid #e6eaf0",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 13,
              wordBreak: "break-all",
              userSelect: "text",
            }}
          >
            {secret}
          </code>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button onClick={copySecret} style={{ ...btn, background: "#27ae60", color: "#fff" }}>
              {copied ? "已复制 ✓" : "复制 Key"}
            </button>
            <button onClick={() => setSecret("")} style={{ ...btn, background: "#fff", border: "1px solid #ddd" }}>
              我已保存，关闭
            </button>
          </div>
        </div>
      )}

      {/* 最小接入示例 */}
      <div style={card}>
        <div
          onClick={() => setShowExample((v) => !v)}
          style={{ cursor: "pointer", fontSize: 13, color: "#3b4cca", userSelect: "none" }}
        >
          {showExample ? "▾" : "▸"} 第三方接入示例（curl）
        </div>
        {showExample && (
          <pre
            style={{
              background: "#f6f8fa",
              border: "1px solid #e6eaf0",
              borderRadius: 8,
              padding: "10px 12px",
              fontSize: 12,
              overflowX: "auto",
              whiteSpace: "pre",
            }}
          >
{`# 1) 同步对话（响应为 NDJSON 快照流，最后一行是最终答案）
curl -X POST http://<服务端地址>:8788/api/v1/open/agent/chat \\
  -H "Authorization: Bearer <你的APIKey>" \\
  -H "Content-Type: application/json" \\
  -d '{"text":"这道题怎么算？"}'

# 2) 上传附件（裸流），拿 ref 再随 chat 发送
curl -X POST "http://<服务端地址>:8788/api/v1/open/files/raw?filename=math.jpg&kind=image" \\
  -H "X-API-Key: <你的APIKey>" \\
  -H "Content-Type: image/jpeg" --data-binary @math.jpg

# 3) 查询会话忙闲 / 中止当前一轮
curl -H "Authorization: Bearer <你的APIKey>" http://<服务端地址>:8788/api/v1/open/agent/status
curl -X POST -H "Authorization: Bearer <你的APIKey>" http://<服务端地址>:8788/api/v1/open/agent/abort`}
          </pre>
        )}
      </div>
    </div>
  );
}

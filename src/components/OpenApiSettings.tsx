/**
 * 开放 API 面板（设置 → 开放接口；2026-09-28，2026-10-04 改多键制）。
 * 一账号可并存多把 Key（一台设备一把，独立吊销）：列表（只显示 prefix + 用量）→ 生成（一次性展示完整 Key）→ 按 Key 吊销。
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

const MAX_KEYS = 10;

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
  const [keys, setKeys] = useState<KeyInfo[]>([]);
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
  const [copyFailed, setCopyFailed] = useState(false);
  const [showExample, setShowExample] = useState(false);

  const load = useCallback(async () => {
    setErr("");
    const r = await window.api.openApiKeyGet();
    if (r?.success) {
      const list = (r.data as any)?.keys;
      setKeys(Array.isArray(list) ? list : []);
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

  async function handleRevoke(k: KeyInfo) {
    setErr("");
    const c = await window.api.confirmDialog({
      title: "吊销 API Key",
      message: `确认吊销 ${k.prefix}…${k.label ? `（${k.label}）` : ""}？`,
      detail: "吊销后正在使用这把 Key 的第三方设备立即失去访问权限（401），其它 Key 不受影响。",
      confirmLabel: "吊销",
    });
    if (!c) return;
    setBusy(true);
    try {
      const r = await window.api.openApiKeyRevoke(k.id);
      if (!r?.success) {
        setErr(r?.error || "吊销失败");
        return;
      }
      setNotice(`已吊销 ${k.prefix}…。使用它的第三方设备下次请求将收到 401。`);
      await load();
    } finally {
      setBusy(false);
    }
  }

  /**
   * 复制到剪贴板，返回是否成功。
   * ⚠️ 网页端跑在局域网 HTTP（http://<内网IP>:8788）时不是安全上下文，navigator.clipboard
   * 会被浏览器整体禁用——降级走 execCommand（需用户手势，点击回调内调用即满足）。
   */
  async function copySecret() {
    let ok = false;
    try {
      if (window.isSecureContext && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(secret);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // 降级：临时 textarea 选中 → execCommand('copy')
      try {
        const ta = document.createElement("textarea");
        ta.value = secret;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setCopied(ok);
    setCopyFailed(!ok);
    if (!ok) {
      // 仍失败（极少数浏览器策略）：把 Key 全文选中，让用户 Ctrl+C 手动复制
      try {
        const el = document.getElementById("openapi-secret-text");
        if (el) {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      } catch {
        /* 选中失败不阻断提示 */
      }
    }
  }

  const childName = (id: string) => children.find((c) => c.id === id)?.name || id || "（未绑定）";
  const atCap = keys.length >= MAX_KEYS;

  return (
    <div className="settings-section">
      <h3>开放接口</h3>
      <p className="desc">
        生成 API Key 后，第三方系统（如 ESP32 硬件、自动化脚本）可以通过开放 API 与服务端 agent 对话，
        能力与 app 内聊天框一致（文字 / 图片 / 文件 / 音频附件、思考过程、工具调用）。
        每个账号可创建多把 Key（上限 {MAX_KEYS} 把）——建议一台设备一把，可独立吊销互不影响。
      </p>

      {err && <p style={{ color: "#c0392b", fontSize: 13 }}>{err}</p>}
      {notice && <p style={{ color: "#27ae60", fontSize: 13 }}>{notice}</p>}

      {/* Key 列表 */}
      {!loaded ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>
      ) : keys.length === 0 ? (
        <div style={card}>
          <div style={{ fontSize: 14 }}>还没有 API Key，用下方表单生成第一把。</div>
        </div>
      ) : (
        keys.map((k) => (
          <div key={k.id} style={card}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
              <strong style={{ fontSize: 14 }}>{k.label || "API Key"}</strong>
              <span style={{ fontSize: 12, background: "#eef2ff", color: "#3b4cca", borderRadius: 999, padding: "1px 10px" }}>
                {k.prefix}…
              </span>
            </div>
            <div style={{ fontSize: 13, color: "#444", lineHeight: 1.9 }}>
              <div>默认对话对象：{childName(k.child_id)}</div>
              <div>
                创建时间：{fmtTime(k.created_at)}　·　最近使用：{fmtTime(k.last_used_at)}（累计 {k.request_count} 次请求）
              </div>
            </div>
            <p style={{ fontSize: 12, color: "#98a2b0", margin: "8px 0 12px" }}>
              完整 Key 仅在生成时展示一次，此处只显示前缀。遗失请吊销这把后重新生成。
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => handleRevoke(k)} disabled={busy} style={{ ...btn, background: "#fff", color: "#c0392b", border: "1px solid #e6b3ac" }}>
                吊销这把
              </button>
            </div>
          </div>
        ))
      )}

      {/* 生成表单（达上限时隐藏） */}
      <div style={card}>
        <div style={{ fontSize: 14, marginBottom: 10 }}>
          {atCap ? `已达上限（${MAX_KEYS} 把）——先吊销不用的 Key 再生成。` : "生成新 Key："}
        </div>
        {!atCap && (
          <>
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
                placeholder="备注（可选，如：客厅的硬件 / ESP32）"
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
          </>
        )}
      </div>

      {/* 完整 Key 一次性展示 */}
      {secret && (
        <div style={{ ...card, border: "2px solid #667eea" }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>API Key 已生成（仅此一次展示）</div>
          <p style={{ fontSize: 12, color: "#c0392b", margin: "0 0 10px" }}>
            请立即复制并保存到第三方设备。关闭本弹窗后无法再次查看，只能吊销后重新生成。
          </p>
          <code
            id="openapi-secret-text"
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
          {copyFailed && (
            <p style={{ fontSize: 12, color: "#c0392b", margin: "8px 0 0" }}>
              ⚠️ 自动复制被浏览器拦截（局域网 HTTP 页面的安全限制）。已为你选中上方 Key 全文——请按 Ctrl+C（Mac ⌘C）手动复制。
            </p>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              onClick={copySecret}
              style={{ ...btn, background: copied ? "#27ae60" : "#667eea", color: "#fff" }}
            >
              {copied ? "已复制 ✓" : copyFailed ? "再试一次复制" : "复制 Key"}
            </button>
            <button
              onClick={() => {
                setSecret("");
                setCopied(false);
                setCopyFailed(false);
              }}
              style={{ ...btn, background: "#fff", border: "1px solid #ddd" }}
            >
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

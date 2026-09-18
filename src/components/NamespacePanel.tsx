/**
 * 自定义数据场景面板（设置 → 自定义数据，F15b，2026-09-19）。
 * 数据管理 agent 提交的 Tier 2 场景草案在这里由家长确认/拒绝；已生效场景可停用/启用。
 * 轮询 15s：agent 提交草案后无需刷新即可看到。
 */
import { useCallback, useEffect, useRef, useState } from "react";

interface NsField {
  name: string;
  kind: "string" | "number" | "enum";
  desc: string;
  required: boolean;
  filterable: boolean;
  enumValues: string[];
  ref: string | null;
}
interface NamespaceInfo {
  ns: string;
  scope: "parent" | "child";
  label: string;
  version: number;
  status: "active" | "pending" | "disabled";
  fields: NsField[];
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
const badge = (text: string, bg: string, color: string): React.CSSProperties => ({
  marginLeft: 8,
  fontSize: 11,
  borderRadius: 999,
  padding: "1px 8px",
  background: bg,
  color,
});
const kindLabel: Record<string, string> = { string: "文本", number: "数字", enum: "单选" };

function FieldTable({ fields }: { fields: NsField[] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, marginTop: 8 }}>
      <thead>
        <tr style={{ color: "#8a94a6", textAlign: "left" }}>
          <th style={{ padding: "4px 8px", fontWeight: 500 }}>字段</th>
          <th style={{ padding: "4px 8px", fontWeight: 500 }}>类型</th>
          <th style={{ padding: "4px 8px", fontWeight: 500 }}>说明</th>
          <th style={{ padding: "4px 8px", fontWeight: 500 }}>标记</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((f) => (
          <tr key={f.name} style={{ borderTop: "1px solid #f0f2f7" }}>
            <td style={{ padding: "4px 8px", fontFamily: "monospace" }}>{f.name}</td>
            <td style={{ padding: "4px 8px" }}>
              {kindLabel[f.kind] ?? f.kind}
              {f.kind === "enum" && f.enumValues.length ? `（${f.enumValues.join("/")}）` : ""}
            </td>
            <td style={{ padding: "4px 8px", color: "#4a5265" }}>
              {f.desc}
              {f.ref ? <span style={{ color: "#3b4cca" }}>（关联 {f.ref}）</span> : null}
            </td>
            <td style={{ padding: "4px 8px", color: "#8a94a6" }}>
              {[
                f.required ? "必填" : "",
                f.filterable ? "可筛选" : "",
              ].filter(Boolean).join(" · ") || "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function NamespacePanel() {
  const [namespaces, setNamespaces] = useState<NamespaceInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const r = await window.api.namespacesList();
    if (r?.success) setNamespaces(r.data?.namespaces || []);
  }, []);

  useEffect(() => {
    void load();
    timer.current = window.setInterval(() => void load(), 15000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [load]);

  const act = async (key: string, fn: () => Promise<{ success?: boolean; data?: { ok?: boolean; error?: string; text?: string } }>) => {
    setBusy(key);
    setNotice(null);
    try {
      const r = await fn();
      const d = r?.data as { ok?: boolean; error?: string; text?: string } | undefined;
      if (r?.success && d?.ok) {
        setNotice({ ok: true, text: d.text || "操作成功" });
        await load();
      } else {
        setNotice({ ok: false, text: d?.error || r?.error || "操作失败" });
      }
    } catch (e: any) {
      setNotice({ ok: false, text: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const pending = namespaces.filter((n) => n.status === "pending");
  const active = namespaces.filter((n) => n.status === "active");
  const disabled = namespaces.filter((n) => n.status === "disabled");
  const scopeLabel = (s: string) => (s === "parent" ? "全家共享" : "每孩子各记");

  return (
    <div>
      <p style={{ fontSize: 13, color: "#5a6478", lineHeight: 1.7, marginTop: 0 }}>
        在「数据管理」助手里描述想要记录的场景（如"我想记录孩子每天练琴"），
        助手会设计好字段并提交草案；草案在下面<strong>确认后立即生效</strong>，
        之后就可以在对话里直接记录和查询。生效前任何助手都看不到这个场景。
      </p>

      {notice && (
        <div
          style={{
            marginBottom: 12,
            padding: "8px 12px",
            borderRadius: 8,
            fontSize: 13,
            background: notice.ok ? "#eefaf0" : "#fdf0f0",
            color: notice.ok ? "#1d7a3d" : "#b03030",
          }}
        >
          {notice.text}
        </div>
      )}

      {pending.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 8px" }}>待确认草案（{pending.length}）</h4>
          {pending.map((n) => (
            <div key={n.ns} style={{ ...card, borderColor: "#f0c36d", background: "#fffdf5" }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <strong>{n.label || n.ns}</strong>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#8a94a6" }}>ns:{n.ns}</span>
                <span style={badge(scopeLabel(n.scope), "#eef2ff", "#3b4cca")}>{scopeLabel(n.scope)}</span>
                <span style={{ fontSize: 12, color: "#8a94a6" }}>由数据管理助手提交</span>
                <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
                  <button
                    style={{ ...btn, background: "#2f7d4f", color: "#fff" }}
                    disabled={busy === n.ns}
                    onClick={() => act(`confirm-${n.ns}`, () => window.api.namespaceDecide({ ns: n.ns, action: "confirm" }))}
                  >
                    确认生效
                  </button>
                  <button
                    style={{ ...btn, background: "#f0f2f7", color: "#5a6478" }}
                    disabled={busy === n.ns}
                    onClick={() => act(`reject-${n.ns}`, () => window.api.namespaceDecide({ ns: n.ns, action: "reject" }))}
                  >
                    拒绝
                  </button>
                </div>
              </div>
              <FieldTable fields={n.fields} />
            </div>
          ))}
        </>
      )}

      <h4 style={{ margin: "16px 0 8px" }}>已生效（{active.length}）</h4>
      {active.length === 0 && <p style={{ fontSize: 13, color: "#8a94a6" }}>还没有生效的自定义场景。</p>}
      {active.map((n) => (
        <div key={n.ns} style={card}>
          <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <strong>{n.label || n.ns}</strong>
            <span style={{ fontFamily: "monospace", fontSize: 12, color: "#8a94a6" }}>ns:{n.ns}</span>
            <span style={badge(scopeLabel(n.scope), "#eef2ff", "#3b4cca")}>{scopeLabel(n.scope)}</span>
            <span style={badge(`v${n.version}`, "#eefaf0", "#1d7a3d")}>v{n.version}</span>
            <div style={{ marginLeft: "auto" }}>
              <button
                style={{ ...btn, background: "#f0f2f7", color: "#5a6478" }}
                disabled={busy === n.ns}
                onClick={() => act(n.ns, () => window.api.namespaceStatus({ ns: n.ns, action: "disable" }))}
              >
                停用
              </button>
            </div>
          </div>
          <FieldTable fields={n.fields} />
        </div>
      ))}

      {disabled.length > 0 && (
        <>
          <h4 style={{ margin: "16px 0 8px", color: "#8a94a6" }}>已停用（{disabled.length}）</h4>
          {disabled.map((n) => (
            <div key={n.ns} style={{ ...card, opacity: 0.7 }}>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <strong>{n.label || n.ns}</strong>
                <span style={{ fontFamily: "monospace", fontSize: 12, color: "#8a94a6" }}>ns:{n.ns}</span>
                <span style={badge("已停用", "#f0f2f7", "#8a94a6")}>已停用</span>
                <div style={{ marginLeft: "auto" }}>
                  <button
                    style={{ ...btn, background: "#eefaf0", color: "#1d7a3d" }}
                    disabled={busy === n.ns}
                    onClick={() => act(n.ns, () => window.api.namespaceStatus({ ns: n.ns, action: "enable" }))}
                  >
                    重新启用
                  </button>
                </div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

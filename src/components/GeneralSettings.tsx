import { useState, useEffect } from "react";

export default function GeneralSettings() {
  const [limit, setLimit] = useState(20);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    window.api.materialsLimitGet().then((r: any) => {
      if (r?.success && typeof r.limit === "number") setLimit(r.limit);
    });
  }, []);

  async function save() {
    const n = parseInt(String(limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg("请输入正整数");
      return;
    }
    const r = await window.api.materialsLimitSet(n);
    if (r?.success) {
      setLimit(r.limit);
      setMsg("已保存");
    } else {
      setMsg(r.error || "保存失败");
    }
  }

  return (
    <div className="settings-section">
      <h3>通用设置</h3>
      <p className="desc">调整学习伙伴的通用行为。</p>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          学习资料保留数量
        </label>
        <p style={{ fontSize: 13, color: "#888", margin: "0 0 8px", lineHeight: 1.6 }}>
          孩子模式左侧「学习资料」列表最多保留多少份资料；超出后只保留最近的一份。退出再进入时资料也会保留（除非会话被重置）。默认 20。
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10) || 1)}
            style={{ width: 120, padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
          />
          <button
            onClick={save}
            style={{ padding: "10px 20px", background: "#667eea", color: "white", border: "none", borderRadius: 8 }}
          >
            保存
          </button>
        </div>
        {msg && (
          <p style={{ fontSize: 13, color: msg === "已保存" ? "#48bb78" : "red", marginTop: 8 }}>
            {msg}
          </p>
        )}
      </div>
    </div>
  );
}

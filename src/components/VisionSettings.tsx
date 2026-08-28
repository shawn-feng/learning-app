import { useEffect, useState } from "react";

// 视觉配置：默认视觉模型选择（孩子发图片时会话自动切换到的多模态模型）。
// 可用的多模态模型来自「模型配置」注册的 provider（input 含 image：qwen3-vl-flash/plus、mimo-v2.5 等），
// 使用对应 provider 前需先在「模型配置」里保存过 API Key。
export default function VisionSettings() {
  const [availableModels, setAvailableModels] = useState<any[]>([]);
  const [visionModel, setVisionModel] = useState("");
  const [visionModelDraft, setVisionModelDraft] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    window.api.piGetModels().then((models: any) => {
      if (Array.isArray(models)) setAvailableModels(models);
    }).catch(() => {});
    window.api.piGetVisionModel().then((r: any) => {
      if (r?.success) {
        const k = r.key || "";
        setVisionModel(k);
        setVisionModelDraft(k);
      }
    }).catch(() => {});
  }, []);

  const visionModels = availableModels.filter(
    (m: any) => Array.isArray(m.input) && m.input.includes("image")
  );

  async function save() {
    setStatus("");
    const r = await window.api.piSetVisionModel(visionModelDraft);
    if (r?.success) {
      setVisionModel(visionModelDraft);
      setStatus(`默认视觉模型已保存：${visionModelDraft || "自动（qwen/qwen3-vl-flash）"}`);
    } else {
      setStatus(`保存失败: ${r?.error || ""}`);
    }
  }

  return (
    <div className="settings-section">
      <h3>视觉配置</h3>
      <p className="desc">
        孩子在对话中发送图片时，会话会自动切换到这里设置的「默认视觉模型」来识别图片内容。
        可用的视觉模型来自「模型配置」注册的多模态 provider（千问 Qwen3-VL、小米 MiMo 全模态等），
        使用前需先在「模型配置」里保存对应 provider 的 API Key。
      </p>

      <div style={{ marginBottom: 12, fontSize: 13, color: "#888" }}>默认视觉模型：</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <select
          value={visionModelDraft}
          onChange={(e) => setVisionModelDraft(e.target.value)}
          style={{ padding: "8px 12px", border: "1px solid #ddd", borderRadius: 8, minWidth: 300 }}
        >
          <option value="">自动（qwen/qwen3-vl-flash）</option>
          {visionModels.map((m: any) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.name}（{m.provider}/{m.id}）
            </option>
          ))}
        </select>
        <button
          onClick={save}
          disabled={visionModelDraft === visionModel}
          style={{
            padding: "8px 16px",
            background: visionModelDraft === visionModel ? "#ddd" : "#667eea",
            color: visionModelDraft === visionModel ? "#666" : "white",
            border: "none",
            borderRadius: 8,
            fontSize: 13,
            cursor: visionModelDraft === visionModel ? "default" : "pointer",
          }}
        >
          {visionModelDraft === visionModel ? "已保存" : "保存视觉模型"}
        </button>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4 style={{ fontSize: 15 }}>可用视觉模型（{visionModels.length}）</h4>
        <button
          onClick={() => window.api.piGetModels().then((models: any) => {
            if (Array.isArray(models)) setAvailableModels(models);
            setStatus("模型列表已刷新");
          })}
          style={{
            padding: "6px 12px",
            background: "#f0f4ff",
            color: "#667eea",
            border: "none",
            borderRadius: 8,
            fontSize: 12,
            cursor: "pointer",
          }}
        >
          刷新
        </button>
      </div>

      {visionModels.length === 0 ? (
        <p style={{ color: "#c0392b", fontSize: 13 }}>
          暂无可用视觉模型：请先在「模型配置」保存千问或小米 MiMo 的 API Key，再回来刷新。
        </p>
      ) : (
        visionModels.map((m: any) => {
          const modelKey = `${m.provider}/${m.id}`;
          const isDefault = visionModel === modelKey;
          return (
            <div key={modelKey} className="model-item">
              <div>
                <div className="model-name">{m.name}</div>
                <div style={{ fontSize: 12, color: "#999" }}>{modelKey}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {isDefault && (
                  <span style={{ fontSize: 12, color: "#667eea", background: "#f0f4ff", padding: "4px 8px", borderRadius: 4 }}>
                    默认
                  </span>
                )}
                <button
                  onClick={() => {
                    setVisionModelDraft(modelKey);
                    save();
                  }}
                  disabled={isDefault}
                  style={{
                    padding: "6px 12px",
                    background: isDefault ? "#edf2f7" : "#f0f4ff",
                    color: isDefault ? "#718096" : "#667eea",
                    border: "none",
                    borderRadius: 8,
                    fontSize: 12,
                    cursor: isDefault ? "default" : "pointer",
                  }}
                >
                  {isDefault ? "✓ 已默认" : "设为默认"}
                </button>
              </div>
            </div>
          );
        })
      )}

      {status && (
        <p style={{ fontSize: 13, color: /失败/.test(status) ? "#e53e3e" : "#667eea", marginTop: 16 }}>{status}</p>
      )}
    </div>
  );
}

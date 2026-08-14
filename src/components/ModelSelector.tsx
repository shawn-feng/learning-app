import { useState, useEffect, useRef } from "react";

interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

interface Props {
  childId: string;
}

export default function ModelSelector({ childId }: Props) {
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("");
  const switched = useRef(false);

  useEffect(() => {
    switched.current = false;
    setStatus("加载模型中...");
    window.api.piGetModels().then((result: any) => {
      if (Array.isArray(result) && result.length > 0) {
        setModels(result);
        setStatus("");
        // Auto-select first model — with retry for session not ready
        const first = result[0];
        setSelected(`${first.provider}/${first.id}`);
        trySwitchModel(first.provider, first.id, 0);
      } else {
        setModels([]);
        setStatus("未检测到可用模型，请先在设置中添加 API key");
      }
    }).catch(() => {
      setStatus("加载模型失败");
    });
  }, []);

  async function trySwitchModel(provider: string, modelId: string, retry: number) {
    if (switched.current) return;
    try {
      const result = await window.api.piSwitchModel(childId, provider, modelId);
      if (!result.success && retry < 5) {
        // Session might not be ready yet, retry after delay
        setTimeout(() => trySwitchModel(provider, modelId, retry + 1), 500);
        return;
      }
      if (result.success) {
        switched.current = true;
        setStatus("");
      } else {
        setStatus(result.error || "模型切换失败");
      }
    } catch {
      if (retry < 5) {
        setTimeout(() => trySwitchModel(provider, modelId, retry + 1), 500);
      }
    }
  }

  async function handleChange(value: string) {
    setSelected(value);
    const [provider, ...rest] = value.split("/");
    const modelId = rest.join("/");
    const result = await window.api.piSwitchModel(childId, provider, modelId);
    if (!result.success) {
      setStatus(result.error || "切换失败");
    } else {
      setStatus("");
    }
  }

  return (
    <div className="model-selector">
      {models.length > 0 ? (
        <select value={selected} onChange={(e) => handleChange(e.target.value)}>
          {models.map((m) => (
            <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
              {m.name}
            </option>
          ))}
        </select>
      ) : (
        <span style={{ fontSize: 13, color: "#999" }}>{status || "未配置模型"}</span>
      )}
      {status && models.length > 0 && (
        <span style={{ fontSize: 12, color: "#e53e3e", marginLeft: 8 }}>{status}</span>
      )}
    </div>
  );
}

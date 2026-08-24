import { useState, useEffect, useRef, useMemo } from "react";

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
  // 当前选中的 provider：点击 provider chip 后只显示该 provider 的模型
  const [activeProvider, setActiveProvider] = useState("");
  // 已成功切到当前 session 的模型 key（用于去重，避免重复切换）
  const appliedKey = useRef("");
  // 期望切到的模型 key（用于丢弃已过期的重试）
  const desiredKey = useRef("");

  // 按 provider 分组，供 chip 栏展示
  const providers = useMemo(() => {
    const set = new Map<string, string>();
    for (const m of models) {
      if (!set.has(m.provider)) set.set(m.provider, m.provider);
    }
    return Array.from(set.keys());
  }, [models]);

  // 当前 provider 下的模型
  const visibleModels = useMemo(() => {
    if (!activeProvider) return models;
    return models.filter((m) => m.provider === activeProvider);
  }, [models, activeProvider]);

  useEffect(() => {
    let mounted = true;
    setStatus("加载模型中...");
    // 同时取可用模型列表与「用户设置的默认模型」，优先预选默认模型
    Promise.all([
      window.api.piGetModels(),
      window.api.piGetDefaultModel().catch(() => null),
    ]).then(([modelsResult, defResult]: any[]) => {
      if (!mounted) return;
      if (!Array.isArray(modelsResult) || modelsResult.length === 0) {
        setModels([]);
        setStatus("未检测到可用模型，请先在设置中添加 API key");
        return;
      }
      setModels(modelsResult);
      setStatus("");
      const defaultKey = defResult?.success ? defResult.key : "";
      // 若默认模型在可用列表里，预选它；否则回退到列表第一项
      const initial =
        defaultKey && modelsResult.some((m: any) => `${m.provider}/${m.id}` === defaultKey)
          ? defaultKey
          : `${modelsResult[0].provider}/${modelsResult[0].id}`;
      setSelected(initial);
      // 默认模型所属 provider 作为初始激活的 provider
      const defProvider = initial.split("/")[0];
      setActiveProvider(defProvider);
      switchTo(initial, 0);
    }).catch(() => {
      if (mounted) setStatus("加载模型失败");
    });
    return () => {
      mounted = false;
    };
  }, []);

  // 切换 provider chip：仅展示该 provider 模型，并切到其第一个模型
  function handleProviderClick(provider: string) {
    if (provider === activeProvider) return;
    setActiveProvider(provider);
    const first = models.find((m) => m.provider === provider);
    if (first) {
      const key = `${first.provider}/${first.id}`;
      setSelected(key);
      switchTo(key, 0);
    }
  }

  // 设置页改了默认模型 → 若当前会话还没切到它，自动切过去（仅当该模型可用）
  useEffect(() => {
    if (models.length === 0) return;
    const off = window.api.onPiDefaultModelChanged((key: string) => {
      const target = models.some((m) => `${m.provider}/${m.id}` === key)
        ? key
        : `${models[0].provider}/${models[0].id}`;
      if (target && target !== appliedKey.current) {
        setSelected(target);
        setActiveProvider(target.split("/")[0]);
        switchTo(target, 0);
      }
    });
    return off;
  }, [models]);

  async function switchTo(value: string, retry: number) {
    desiredKey.current = value;
    if (appliedKey.current === value) return;
    const [provider, ...rest] = value.split("/");
    const modelId = rest.join("/");
    try {
      const result = await window.api.piSwitchModel(childId, provider, modelId);
      if (desiredKey.current !== value) return; // 已被新的切换请求取代，丢弃
      if (result.success) {
        appliedKey.current = value;
        setStatus("");
      } else if (retry < 5) {
        // Session 可能还没就绪，延迟重试
        setTimeout(() => switchTo(value, retry + 1), 500);
      } else {
        setStatus(result.error || "模型切换失败");
      }
    } catch {
      if (desiredKey.current === value && retry < 5) {
        setTimeout(() => switchTo(value, retry + 1), 500);
      }
    }
  }

  async function handleChange(value: string) {
    setSelected(value);
    switchTo(value, 0);
  }

  return (
    <div className="model-selector">
      {models.length > 0 && providers.length > 1 && (
        <div className="provider-list" style={{ marginBottom: 8 }}>
          {providers.map((p) => (
            <div
              key={p}
              className={`provider-chip ${activeProvider === p ? "active" : ""}`}
              onClick={() => handleProviderClick(p)}
            >
              {p}
            </div>
          ))}
        </div>
      )}
      {visibleModels.length > 0 ? (
        <select value={selected} onChange={(e) => handleChange(e.target.value)}>
          {visibleModels.map((m) => (
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

/**
 * 设备能力（caps）登记表（P3）：SSE 建连时客户端上报自己有什么能力，服务端据此装配工具。
 *
 * 为什么要协商：agent 上移服务端后，它看不到「对面是什么设备」——同一份会话可能被桌面端、
 * 手机浏览器同时打开。资料面板/麦克风/Electron 专有能力在不同端上存在与否不同，
 * 若一律注册全部工具，模型会调用根本执行不了的工具（例如手机端没有 Electron 浏览器面板）。
 * 因此：能力缺失时**不注册**对应工具，让模型从工具表就看出「这台设备做不到」，而不是调用后报错。
 */
export type CapId = "material-panel" | "mic" | "electron";

export interface DeviceCaps {
  materialPanel: boolean;
  mic: boolean;
  electron: boolean;
  /** 上报的原始串（调试/日志用） */
  raw: string;
  updatedAt: number;
}

const registry = new Map<string, DeviceCaps>();

const VALID: CapId[] = ["material-panel", "mic", "electron"];

export function parseCaps(raw: unknown): DeviceCaps {
  const s = String(raw ?? "").trim();
  const set = new Set(
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x): x is CapId => (VALID as string[]).includes(x))
  );
  return {
    materialPanel: set.has("material-panel"),
    mic: set.has("mic"),
    electron: set.has("electron"),
    raw: s,
    updatedAt: Date.now(),
  };
}

export function registerCaps(key: string, caps: DeviceCaps): void {
  registry.set(key, caps);
}

/** 取某会话的能力；从未上报时按「最小能力」处理（不注册设备相关工具）。 */
export function getCaps(key: string): DeviceCaps {
  return registry.get(key) ?? parseCaps("");
}

export function clearCaps(key: string): void {
  registry.delete(key);
}

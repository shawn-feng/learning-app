import fs from "fs";
import { getAppSettingsPath } from "./config";

interface AppSettings {
  materialsLimit: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  materialsLimit: 20,
};

function loadSettings(): AppSettings {
  const p = getAppSettingsPath();
  if (!fs.existsSync(p)) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(p, "utf-8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings: AppSettings): void {
  fs.writeFileSync(getAppSettingsPath(), JSON.stringify(settings, null, 2), "utf-8");
}

// 学习资料保留数量（孩子模式左侧「学习资料」列表的上限），默认 20
export function getMaterialsLimit(): number {
  const n = loadSettings().materialsLimit;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SETTINGS.materialsLimit;
}

export function setMaterialsLimit(n: number): number {
  const settings = loadSettings();
  const valid = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_SETTINGS.materialsLimit;
  settings.materialsLimit = valid;
  saveSettings(settings);
  return valid;
}

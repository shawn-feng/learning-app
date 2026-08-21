import fs from "fs";
import { getAppSettingsPath } from "./config";

interface AppSettings {
  materialsLimit: number;
  // 用户设置的「默认模型」，格式 "provider/modelId"，如 "qwen/qwen-flash"。
  // 这是主进程可读的唯一种源：getDefaultModel()、scheduler 定时任务、渲染侧 ModelSelector
  // 都从这里取，避免出现「设置里改了默认模型、孩子模式仍显示 deepseek flash」的脱钩问题。
  defaultModel?: string;
  // 「编程 agent」模型（ISSUE-020），格式同 defaultModel："provider/modelId"。
  // 空/未设置 = 未启用编程 agent：create_html_lesson 工具会报错并提示家长先到设置页配置。
  programmingModel?: string;
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

// 默认模型（"provider/modelId"）。空字符串/未设置表示「未指定，由调用方自行回退」。
export function getDefaultModelKey(): string {
  return loadSettings().defaultModel || "";
}

export function setDefaultModelKey(key: string): void {
  const settings = loadSettings();
  if (key) {
    settings.defaultModel = key;
  } else {
    delete settings.defaultModel;
  }
  saveSettings(settings);
}

// 编程 agent 模型（"provider/modelId"）。空字符串/未设置表示「未启用」。
export function getProgrammingModelKey(): string {
  return loadSettings().programmingModel || "";
}

export function setProgrammingModelKey(key: string): void {
  const settings = loadSettings();
  if (key) {
    settings.programmingModel = key;
  } else {
    delete settings.programmingModel;
  }
  saveSettings(settings);
}

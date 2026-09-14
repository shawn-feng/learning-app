/**
 * 本地 app-settings.json：只承载「设备本地回退」用的轻量设置（目前仅 materialsLimit）。
 *
 * ⚠️ ISSUE-097：模型配置（defaultModel / programmingModel / visionModel）与其它家长设置
 * 已全部收口服务端 `<parentId>:app_settings`——设置页走 /models/app_settings 直接读写服务端，
 * 服务端 agent（readParentSettings）读同一行，显示与生效天然一致。
 *
 * 历史 bug（本 issue 根因）：旧实现把模型字段也存在本地文件，保存时 `pushConfig("app_settings",
 * 整个本地文件)` 推服务端——而服务端 /config/set 是**整键替换**，本地文件里过期/缺失的模型字段
 * 会把服务端真源整体覆盖（表现即「设置页显示已配置、agent 报未配置」的本地/服务端存储分裂）。
 * 因此：
 * 1. 本地文件**只存 materialsLimit**，不再存任何模型字段；
 * 2. 保存时不再整键推送，改走 /models/app_settings **合并端点**（只更新传入字段，绝不碰模型配置）。
 */
import fs from "fs";
import { getAppSettingsPath } from "./config";
import { setAppSettings } from "./server-agent-client";

const DEFAULT_MATERIALS_LIMIT = 20;

function loadMaterialsLimit(): number {
  try {
    const v = JSON.parse(fs.readFileSync(getAppSettingsPath(), "utf-8"));
    const n = Number(v?.materialsLimit);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MATERIALS_LIMIT;
  } catch {
    return DEFAULT_MATERIALS_LIMIT;
  }
}

/** 学习资料保留数量（孩子模式左侧「学习资料」列表的上限），默认 20。本地文件仅作离线回退。 */
export function getMaterialsLimit(): number {
  return loadMaterialsLimit();
}

export function setMaterialsLimit(n: number): number {
  const valid = Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MATERIALS_LIMIT;
  try {
    // 本地文件顺带清掉历史遗留的模型字段（只写 materialsLimit，见文件头说明）
    fs.writeFileSync(getAppSettingsPath(), JSON.stringify({ materialsLimit: valid }, null, 2), "utf-8");
  } catch {
    /* 本地写失败不阻塞——服务端是真源 */
  }
  // 服务端同步：走合并端点，只传 materialsLimit，绝不整键覆盖模型配置（ISSUE-097）
  void setAppSettings({ materialsLimit: valid }).catch(() => {});
  return valid;
}

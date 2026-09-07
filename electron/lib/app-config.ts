import fs from "fs";
import path from "path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { getAppSettingsPath, getParentConfigDir, getCurrentParentId, getDataDir } from "./config";
import {
  getMaterialsLimit,
  setMaterialsLimit,
  getDefaultModelKey,
  setDefaultModelKey,
  getProgrammingModelKey,
  setProgrammingModelKey,
  getVisionModelKey,
  setVisionModelKey,
} from "./app-settings";
import { getChildSchedulerConfig } from "./scheduler";
import { getProfile } from "./child-auth";
import { getAgentPrompt } from "./agent-prompts";
import { logActivity } from "./parent-library";

/* =========================================================================
 * 配置域 schema 注册表 + app_config 工具（PARENT-AGENT 块 1 / §7）
 * -----------------------------------------------------------------------
 * 安全边界（重要）：本工具只做「声明式、可校验、可回退、留痕」的配置读写。
 *   - app-settings 标量(materialsLimit/defaultModel/programmingModel/visionModel)：
 *     **可 get/set**，set 走现有类型化 setter(自动 pushConfig 同步服务端) + .bak 备份 +
 *     activity-log 留痕 + 高影响项强制「家长确认」两段式。
 *   - scheduler / child profile / AGENTS 提示词：**只读(get)**——结构复杂且与 UI/编辑器
 *     绑定，agent 手工 set 风险高，写一律引导家长到设置页 / AgentPromptEditor。
 *   - auth/license/server-connection/账户密码：永不触碰，直接报错。
 * ========================================================================= */

export interface ConfigEntry {
  file: "app-settings" | "scheduler" | "profile" | "agents";
  scope: "global" | "child";
  type: "number" | "string" | "boolean" | "struct";
  enum?: string[];
  min?: number;
  max?: number;
  desc: string;
  highImpact?: boolean;
  settable?: boolean; // true 才允许 set；缺省 false=只读
}

export const APP_CONFIG_REGISTRY: Record<string, ConfigEntry> = {
  materialsLimit: {
    file: "app-settings", scope: "global", type: "number", min: 1, max: 100,
    desc: "孩子端「学习资料」列表展示上限（1-100）。改低只会让孩子端资料列表变短，不删任何资料文件。", highImpact: true, settable: true,
  },
  defaultModel: {
    file: "app-settings", scope: "global", type: "string",
    desc: "孩子/家长默认对话模型（provider/modelId，如 qwen/qwen-flash）。改后新会话生效，影响回复质量与费用。", highImpact: true, settable: true,
  },
  programmingModel: {
    file: "app-settings", scope: "global", type: "string",
    desc: "编程 agent（资料生成 create_html_lesson）所用模型（provider/modelId）。未设置=编程 agent 未启用，建资料会报错。", highImpact: true, settable: true,
  },
  visionModel: {
    file: "app-settings", scope: "global", type: "string",
    desc: "默认视觉模型（图片上传自动切换的多模态模型，provider/modelId）。空=回退 qwen/qwen3-vl-flash。", highImpact: true, settable: true,
  },

  "scheduler.dailySummary": {
    file: "scheduler", scope: "global", type: "struct",
    desc: "各孩子「每日记录总结」定时（recording 开关/时间点）。读看当前配置；改请在设置→定时任务。",
  },
  "scheduler.autoNewSession": {
    file: "scheduler", scope: "global", type: "struct",
    desc: "孩子自动新会话开关与间隔。读看当前配置；改请在设置→定时任务。",
  },
  "scheduler.classTimes": {
    file: "scheduler", scope: "global", type: "struct",
    desc: "孩子课程时间段（上课/下课提醒，classTimes）。读看当前配置；改请在设置→定时任务。",
  },

  "profile.name": {
    file: "profile", scope: "child", type: "string",
    desc: "孩子名字（多处作身份标识 key，改需谨慎）。读看；改请在「孩子管理」页。",
  },
  "profile.age": {
    file: "profile", scope: "child", type: "number",
    desc: "孩子年龄。读看；改请在「孩子管理」页。",
  },
  "profile.interests": {
    file: "profile", scope: "child", type: "string",
    desc: "孩子兴趣（用于教学个性化）。读看；改请在「孩子管理」页。",
  },
  "profile.ai": {
    file: "profile", scope: "child", type: "struct",
    desc: "孩子 AI 伙伴（名字/emoji/性格）。读看；改请在「孩子管理」页。",
  },

  "agents.parent": {
    file: "agents", scope: "global", type: "struct",
    desc: "家长提示词补充片段（agents.sqlite，追加在系统默认之后；默认不可改）。读看；编辑/清除请在家长中心「AI 提示词补充」。",
  },
};

/** 是否永不触碰（报错而非处理）。 */
export function isForbiddenKey(key: string): boolean {
  const k = key.toLowerCase();
  return (
    k.includes("auth") ||
    k.includes("license") ||
    k.includes("password") ||
    k.includes("account") ||
    k.includes("server-connection") ||
    k.includes("token")
  );
}

/** 当前家长 id（读 agents 版本用）。 */
function currentParentId(): string {
  return getCurrentParentId();
}

/** 读当前家长是否有「用户版」家长提示词（agents.sqlite）。 */
function parentPromptHasUserVersion(): string {
  try {
    const pid = currentParentId();
    if (!pid) return "（未登录）";
    const v = getAgentPrompt("parent", pid);
    return v && v.trim() ? "存在家长补充片段（追加在默认提示词之后生效）" : "（无补充，使用代码默认提示词）";
  } catch {
    return "（读取失败）";
  }
}

/** 读所有本地孩子的精简列表（供 scheduler/profile 聚合展示）。 */
function localChildren(): Array<{ childId: string; name: string }> {
  try {
    const dir = path.join(getDataDir(), "children");
    const out: Array<{ childId: string; name: string }> = [];
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir)) {
      const p = path.join(dir, entry, "profile.json");
      if (fs.existsSync(p)) {
        try {
          const prof = JSON.parse(fs.readFileSync(p, "utf-8")) as { childId?: string; name?: string };
          out.push({ childId: prof.childId || entry, name: prof.name || entry });
        } catch {
          // skip malformed
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** 取某 key 当前值文本。child 作用域 key 需 childId；读不到返回 null。 */
export function readConfigValue(key: string, childId?: string): string | null {
  const e = APP_CONFIG_REGISTRY[key];
  if (!e) return null;
  try {
    switch (key) {
      case "materialsLimit": return String(getMaterialsLimit());
      case "defaultModel": return getDefaultModelKey() || "（未设置，走系统默认）";
      case "programmingModel": return getProgrammingModelKey() || "（未设置 = 编程 agent 未启用）";
      case "visionModel": return getVisionModelKey() || "（未设置，回退 qwen/qwen3-vl-flash）";
      case "scheduler.dailySummary": {
        const kids = localChildren();
        if (!kids.length) return "（无孩子配置）";
        return kids.map((k) => {
          const c = getChildSchedulerConfig(k.childId);
          const times = (c.recording?.times ?? []).map((t) => `${t.start}-${t.end}`).join(",") || "默认";
          return `- ${k.name}：记录总结 ${c.recording?.enabled ? "开" : "关"}（${times}）`;
        }).join("\n");
      }
      case "scheduler.autoNewSession": {
        const kids = localChildren();
        if (!kids.length) return "（无孩子配置）";
        return kids.map((k) => {
          const c = getChildSchedulerConfig(k.childId);
          return `- ${k.name}：自动新会话 ${c.autoNewSession?.enabled ? `开（${c.autoNewSession.intervalHours ?? "?"} 小时）` : "关"}`;
        }).join("\n");
      }
      case "scheduler.classTimes": {
        const kids = localChildren();
        if (!kids.length) return "（无孩子配置）";
        const weekNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
        return kids
          .map((k) => {
            const c = getChildSchedulerConfig(k.childId);
            const tplById = new Map((c.classTemplates || []).map((t) => [t.id, t]));
            const line = [1, 2, 3, 4, 5, 6, 0]
              .map((d) => {
                const tplId = c.classWeek?.[d] ?? null;
                const tpl = tplId ? tplById.get(tplId) : null;
                const times = tpl
                  ? (tpl.times || [])
                      .map((x) => `${x.start}-${x.end}${x.label ? `(${x.label})` : ""}`)
                      .join("、")
                  : "";
                const desc = tpl ? `${tpl.name}${times ? `（${times}）` : "（未排课）"}` : "不提醒";
                return `  ${weekNames[d]}：${desc}`;
              })
              .join("\n");
            return `- ${k.name}\n${line}`;
          })
          .join("\n");
      }
      case "profile.name":
      case "profile.age":
      case "profile.interests":
      case "profile.ai": {
        if (!childId) return null;
        const p = getProfile(childId);
        if (!p) return null;
        if (key === "profile.name") return p.name;
        if (key === "profile.age") return String(p.age ?? "");
        if (key === "profile.interests") return p.interests || "（未填写）";
        return `AI 伙伴：${p.aiName || ""}${p.aiEmoji ? ` ${p.aiEmoji}` : ""}｜性格：${p.aiPersonality || "（未填）"}`;
      }
      case "agents.parent": return parentPromptHasUserVersion();
      default: return null;
    }
  } catch {
    return null;
  }
}

/** 写某 key（仅 settable）。调用方须已通过「家长确认」阶段。返回成功文本或抛错。 */
export function writeConfigValue(key: string, value: string | number | boolean, childId?: string): void {
  const e = APP_CONFIG_REGISTRY[key];
  if (!e || !e.settable) {
    throw new Error(
      `配置项 ${key} 不允许 agent 直接修改（${e ? "该配置请在设置页/对应编辑器操作" : "未注册的配置 key"}）。`
    );
  }
  // 数值范围校验
  if (e.type === "number") {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`${key} 需要数值`);
    if (e.min !== undefined && n < e.min) throw new Error(`${key} 不能小于 ${e.min}`);
    if (e.max !== undefined && n > e.max) throw new Error(`${key} 不能大于 ${e.max}`);
  }
  // app-settings 标量统一在写前备份 .bak + 走类型化 setter
  switch (key) {
    case "materialsLimit": {
      const bak = backupAppSettings();
      const v = setMaterialsLimit(Number(value));
      logActivity(`app_config 修改 materialsLimit → ${v}${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
      return;
    }
    case "defaultModel": {
      const bak = backupAppSettings();
      setDefaultModelKey(String(value));
      logActivity(`app_config 修改 defaultModel → ${String(value) || "（清空=默认）"}${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
      return;
    }
    case "programmingModel": {
      const bak = backupAppSettings();
      setProgrammingModelKey(String(value));
      logActivity(`app_config 修改 programmingModel → ${String(value) || "（清空=未启用）"}${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
      return;
    }
    case "visionModel": {
      const bak = backupAppSettings();
      setVisionModelKey(String(value));
      logActivity(`app_config 修改 visionModel → ${String(value) || "（清空=回退默认）"}${bak ? `（备份 ${path.basename(bak)}）` : ""}`);
      return;
    }
    default:
      throw new Error(`${key} 暂不支持 agent set（请在对应页面修改）`);
  }
}

/** app-settings 文件 .bak 快照（set 前留存，可回退）。 */
export function backupAppSettings(): string | null {
  const p = getAppSettingsPath();
  if (!fs.existsSync(p)) return null;
  const bak = path.join(getParentConfigDir(), `app-settings.bak-${Date.now()}.json`);
  try {
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(p, bak);
    return bak;
  } catch {
    return null;
  }
}

/* =========================================================================
 * app_config 工具
 * ========================================================================= */
export const appConfigTool = defineTool({
  name: "app_config",
  label: "查看/修改应用配置（模型、资料上限；读 scheduler/profile/提示词）",
  description:
    "家长配置管理工具（可读可改，**只覆盖 app 设置，绝不碰认证/账户/密码**）。\n\n" +
    "**type=`get`**：查配置当前值。`key` 传单项 key（见下清单）；`key` 缺省 = 列出全部可读配置。`scope` 传 `{childId}` 可读取某孩子档案/profile。\n\n" +
    "**type=`set`**：修改配置。**仅以下 app-settings 标量可 set**：`materialsLimit`(1-100) / `defaultModel` / `programmingModel` / `visionModel`（均 provider/modelId 字符串）。\n" +
    "set 纪律：① 先 `get` 看当前值；② 把「拟改为 X、影响是什么」用大白话告诉家长，**拿到家长明确同意后**再调用本工具的 set 并带 `confirmed:true`；③ 改完向家长汇报结果。set 会自动 .bak 备份原 app-settings + 记入 activity-log，可回退。\n" +
    "**只读项（不能 set，改引导对应页面/编辑器）**：`scheduler.dailySummary`/`scheduler.autoNewSession`/`scheduler.classTimes`（设置→定时任务）、`profile.name`/`profile.age`/`profile.interests`/`profile.ai`（孩子管理页）、`agents.parent`（提示词 AgentPromptEditor）。\n" +
    "key 清单（未列出的均不支持）：materialsLimit, defaultModel, programmingModel, visionModel, scheduler.dailySummary, scheduler.autoNewSession, scheduler.classTimes, profile.name, profile.age, profile.interests, profile.ai, agents.parent。",
  parameters: Type.Object({
    type: Type.Union([Type.Literal("get"), Type.Literal("set")], { description: "get=查看配置 | set=修改配置" }),
    key: Type.String({ description: "配置 key，见工具说明清单；type=get 缺省=列出全部" }),
    value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()], { description: "set 专用：目标值（materialsLimit 数值；模型为 provider/modelId 字符串）" })),
    scope: Type.Optional(Type.Object({ childId: Type.Optional(Type.String({ description: "孩子 childId（读 profile.* 时用）" })) }, { description: "作用域：child 项需带 childId" })),
    confirmed: Type.Optional(Type.Boolean({ description: "set 专用：家长已确认后置 true（高影响项必须）" })),
  }),
  execute: async (_toolCallId, params) => {
    // 永不触碰范围
    if (isForbiddenKey(params.key)) {
      throw new Error(`app_config 不支持 ${params.key}：认证/账户/密码/license/连接等属安全项，禁止读取或修改。`);
    }
    const childId = params.scope?.childId || undefined;
    const entry = APP_CONFIG_REGISTRY[params.key];

    if (params.type === "get") {
      if (!entry) {
        return { content: [{ type: "text" as const, text: `未知配置 key：${params.key}。可用 key：${Object.keys(APP_CONFIG_REGISTRY).join(", ")}` }] };
      }
      const v = readConfigValue(params.key, childId);
      const scopeNote = entry.scope === "child" && childId
        ? `（child ${childId}）`
        : entry.scope === "child" ? "（需 scope.childId）" : "";
      const writable = entry.settable ? "可改" : "只读（改请在对应页面/编辑器）";
      return {
        content: [{ type: "text" as const, text: `### ${params.key}${scopeNote}\n当前值：${v ?? "（读取失败/无数据）"}\n类型：${entry.type}｜${writable}\n影响：${entry.desc}` }],
      };
    }

    // type = set
    if (!entry) throw new Error(`未知配置 key：${params.key}`);
    if (entry.scope === "child" && !childId) throw new Error(`配置 ${params.key} 需要 scope.childId`);
    if (!entry.settable) {
      throw new Error(`配置 ${params.key} 只读，不允许 agent set（请在对应页面/编辑器修改）：${entry.desc}`);
    }
    if (params.value === undefined || params.value === null || params.value === "") {
      throw new Error(`set ${params.key} 需要非空 value`);
    }
    // 高影响项必须家长确认
    if (entry.highImpact && !params.confirmed) {
      return {
        content: [{
          type: "text" as const,
          text: `⚠️ 修改「${params.key}」影响面较大（${entry.desc}）。请把「拟将 ${params.key} 改为：${params.value}」和上述影响告诉家长并**征得明确同意**；家长确认后，再用相同参数调用本工具且带 confirmed:true 执行。`,
        }],
      };
    }
    const oldText = readConfigValue(params.key, childId);
    writeConfigValue(params.key, params.value, childId);
    return {
      content: [{
        type: "text" as const,
        text: `已修改 ${params.key}：\n- 原值：${oldText ?? "（无）"}\n- 新值：${String(params.value)}\n已自动备份原 app-settings（.bak）并记录到 activity-log。新配置跨设备约 2 分钟内同步生效；部分项（默认模型）对新会话生效。`,
      }],
    };
  },
});

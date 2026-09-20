/**
 * ISSUE-116 自定义定时任务的会话工具（服务端无头 ephemeral 会话专用白名单子集）。
 *
 * - weather_query：天气查询。默认 Open-Meteo（免费免 key，7 天预报 + 城市中文地理编码，零配置可用）；
 *   默认城市取家长设置 `<parentId>:weather` JSON {location}（缺省「北京」）。
 * - create_reminders：给指定孩子批量创建提醒任务（type=reminder，复用 ISSUE-047 链路到点语音播报）。
 *   防重策略（待拍板④采「source 标记」）：创建时以 extra_json.source_task=<custom 任务id> 打源标记，
 *   replace=true（默认）先停用该源旧提醒（滚动窗口，防「每天再建 7 条」无限累积）；
 *   另做 (text+time+frequency) 精确去重，防同批/跨次重复。
 *
 * 白名单原则（待拍板①）：custom 会话只见 get_date/kb_query/kb_insert/kb_update（复用 worker kb 工具）
 * + 本文件两工具——不含积分/考核/计划写等高危能力。
 */
import type { DatabaseSync } from "node:sqlite";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createReminderTask } from "../db/task-runs.js";

/** custom 会话工具白名单（createWorkerKbTools 产出的名字 + 本模块两工具）。 */
export const CUSTOM_TASK_TOOL_NAMES = ["get_date", "kb_query", "kb_insert", "kb_update", "weather_query", "create_reminders"];

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

// ==================== weather_query ====================

const WMO_TEXT: Record<number, string> = {
  0: "晴",
  1: "基本晴",
  2: "局部多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "轻毛毛雨",
  53: "毛毛雨",
  55: "浓毛毛雨",
  56: "冻毛毛雨",
  57: "浓冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "雪粒",
  80: "小阵雨",
  81: "阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "大阵雪",
  95: "雷阵雨",
  96: "雷阵雨伴冰雹",
  99: "强雷阵雨伴冰雹",
};

function wmoText(code: unknown): string {
  const n = Number(code);
  return WMO_TEXT[n] ?? "未知";
}

/** 家长设置里的天气配置（settings `<parentId>:weather`，JSON {location}）。 */
function defaultCity(db: DatabaseSync, parentId: string): string {
  try {
    const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${parentId}:weather`) as
      | { value_json?: string }
      | undefined;
    if (row?.value_json) {
      const cfg = JSON.parse(row.value_json) as { location?: unknown };
      const loc = String(cfg.location ?? "").trim();
      if (loc) return loc;
    }
  } catch {
    /* 忽略坏配置 */
  }
  return "北京";
}

interface GeoHit {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

async function geocodeCity(city: string): Promise<GeoHit | null> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`城市解析失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { results?: GeoHit[] };
  return data.results?.[0] ?? null;
}

interface DailyForecast {
  time: string[];
  weather_code: Array<number | null>;
  temperature_2m_max: Array<number | null>;
  temperature_2m_min: Array<number | null>;
  precipitation_probability_max?: Array<number | null>;
}

async function fetchForecast(lat: number, lon: number, days: number): Promise<DailyForecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=${days}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`天气查询失败（HTTP ${res.status}）`);
  const data = (await res.json()) as { daily?: DailyForecast };
  if (!data.daily?.time?.length) throw new Error("天气查询失败：未返回预报数据");
  return data.daily;
}

export const WEEKDAY_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 创建天气查询工具（city 缺省取家长设置；days 1-7，默认今天）。 */
export function createWeatherTool(db: DatabaseSync, parentId: string) {
  return defineTool({
    name: "weather_query",
    label: "查询天气预报",
    description:
      "查询某城市未来 N 天（1-7）的天气预报（天气现象/最高最低温/降水概率）。" +
      "city 缺省用家长配置的默认城市；返回按日期排列的中文预报文本，可直接用于生成提醒内容。",
    parameters: Type.Object({
      city: Type.Optional(Type.String({ description: "城市名（中文，如「北京」「上海」）；缺省用家长配置的默认城市" })),
      days: Type.Optional(Type.Number({ description: "预报天数 1-7，缺省 1（只查今天）" })),
    }),
    execute: async (_id: string, params: { city?: string; days?: number }) => {
      const city = String(params.city ?? "").trim() || defaultCity(db, parentId);
      const days = Math.max(1, Math.min(7, Math.round(Number(params.days) || 1)));
      try {
        const geo = await geocodeCity(city);
        if (!geo) return ok(`找不到城市「${city}」，请换一个写法（如「北京」「上海市」）。`);
        const daily = await fetchForecast(geo.latitude, geo.longitude, days);
        const lines = daily.time.map((d, i) => {
          const date = new Date(`${d}T12:00:00`);
          const wd = Number.isNaN(date.getTime()) ? "" : WEEKDAY_ZH[date.getDay()] ?? "";
          const pop = daily.precipitation_probability_max?.[i];
          return (
            `${d}（${wd}）：${wmoText(daily.weather_code[i])}，` +
            `${Math.round(Number(daily.temperature_2m_min[i] ?? 0))}~${Math.round(Number(daily.temperature_2m_max[i] ?? 0))}℃` +
            `${Number.isFinite(Number(pop)) ? `，降水概率 ${Number(pop)}%` : ""}`
          );
        });
        const where = geo.admin1 ? `${geo.admin1}·${geo.name}` : geo.name;
        return ok(`【${where}】未来 ${days} 天预报：\n${lines.join("\n")}`);
      } catch (e) {
        const msg = (e as Error).message || String(e);
        return ok(`天气查询失败：${msg}`);
      }
    },
  });
}

// ==================== create_reminders ====================

interface ReminderSpecIn {
  text?: unknown;
  time?: unknown;
  frequency?: unknown;
  weekday?: unknown;
  intervalMinutes?: unknown;
  fireAt?: unknown;
  name?: unknown;
}

const REMINDER_FREQS = ["once", "daily", "weekly", "interval"] as const;
type Freq = (typeof REMINDER_FREQS)[number];

function hhmmValid(t: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

/**
 * 创建批量提醒工具（绑定：家长 + 孩子 + 来源 custom 任务）。
 * replace=true（默认）：先停用本源（source_task）未过期的旧提醒（滚动窗口）；
 * 另按 (text+time+frequency) 对「该孩子未过期提醒」精确去重，重复项跳过。
 */
export function createRemindersTool(db: DatabaseSync, parentId: string, childId: string, sourceTaskId: string) {
  return defineTool({
    name: "create_reminders",
    label: "创建定时提醒",
    description:
      "为该孩子批量创建定时提醒（到点语音播报）。**频率选型**：每天固定播 → daily（time=每日时刻）；「未来 N 天各播一次」→ 一次性创建 N 条 once（每条 fireAt=对应日期的播报时刻，text 带各自内容）；每周 → weekly；每隔 N 分钟 → interval。" +
      "同任务重复运行会自动替换上一次创建的未播报提醒（replace 默认 true）；内容与时间完全相同的重复提醒自动跳过。",
    parameters: Type.Object({
      reminders: Type.Array(
        Type.Object({
          text: Type.String({ description: "提醒内容（播报原文，必填）" }),
          time: Type.String({ description: "每天播报时刻 HH:mm（必填）" }),
          name: Type.Optional(Type.String({ description: "提醒名称（缺省取内容前 12 字）" })),
          frequency: Type.Optional(Type.String({ description: "once | daily（默认）| weekly | interval" })),
          weekday: Type.Optional(Type.Number({ description: "weekly：0=周日..6=周六" })),
          intervalMinutes: Type.Optional(Type.Number({ description: "interval：每隔 N 分钟" })),
          fireAt: Type.Optional(Type.String({ description: "once：目标时间 ISO（缺省=明天该时刻）" })),
        }),
        { description: "要创建的提醒列表" }
      ),
      replace: Type.Optional(
        Type.Boolean({ description: "是否先停用本任务上次创建的未播报提醒（默认 true，滚动更新防堆积）" })
      ),
    }),
    execute: async (_id: string, params: { reminders: ReminderSpecIn[]; replace?: boolean }) => {
      const list = Array.isArray(params.reminders) ? params.reminders : [];
      if (!list.length) return ok("未提供任何提醒（reminders 为空）。");
      if (list.length > 31) return ok("一次最多创建 31 条提醒，请分批或缩减范围。");

      const sourceLike = `%"source_task":"${sourceTaskId}"%`;
      let disabled = 0;
      if (params.replace !== false) {
        // 停用本源未过期（expired=0）旧提醒：滚动窗口——新一批接管后续播报，已播过的留档
        const r = db
          .prepare(
            `UPDATE scheduler_tasks SET enabled = 0, updated_at = ?
             WHERE parent_id = ? AND type = 'reminder' AND enabled = 1 AND expired = 0
               AND extra_json LIKE ?`
          )
          .run(new Date().toISOString(), parentId, sourceLike);
        disabled = Number(r.changes);
      }

      const nowIso = new Date().toISOString();
      const created: string[] = [];
      const skipped: string[] = [];
      for (const raw of list) {
        const text = String(raw.text ?? "").trim();
        const time = String(raw.time ?? "").trim();
        if (!text || !hhmmValid(time)) {
          skipped.push(`「${text.slice(0, 16) || "（空）"}」缺少内容或 time 非法`);
          continue;
        }
        const frequency = (REMINDER_FREQS as readonly string[]).includes(String(raw.frequency))
          ? (String(raw.frequency) as Freq)
          : "daily";
        if (frequency === "weekly" && !(Number(raw.weekday) >= 0 && Number(raw.weekday) <= 6)) {
          skipped.push(`「${text.slice(0, 16)}」weekly 缺 weekday`);
          continue;
        }
        if (frequency === "interval" && !(Number(raw.intervalMinutes) > 0)) {
          skipped.push(`「${text.slice(0, 16)}」interval 缺 intervalMinutes`);
          continue;
        }
        let fireAt: string | null = raw.fireAt == null ? null : String(raw.fireAt);
        if (frequency === "once" && !fireAt) {
          const d = new Date();
          d.setDate(d.getDate() + 1);
          const [h, m] = time.split(":");
          d.setHours(Number(h), Number(m), 0, 0);
          fireAt = d.toISOString();
        }
        // 精确去重：该孩子同 text+time+frequency 且未过期的提醒已存在 → 跳过
        const dup = db
          .prepare(
            `SELECT t.id FROM scheduler_tasks t
             JOIN scheduler_task_assignments a ON a.task_id = t.id AND a.child_id = ? AND a.enabled = 1
             WHERE t.parent_id = ? AND t.type = 'reminder' AND t.enabled = 1 AND t.expired = 0
               AND t.reminder_text = ? AND t.time = ? AND t.frequency = ?
             LIMIT 1`
          )
          .get(childId, parentId, text, time, frequency);
        if (dup) {
          skipped.push(`「${text.slice(0, 16)} ${time}」已存在`);
          continue;
        }
        const rid = createReminderTask(db, {
          parentId,
          childId,
          name: String(raw.name ?? "").trim() || text.slice(0, 12),
          text,
          time,
          frequency,
          weekday: frequency === "weekly" ? Number(raw.weekday) : null,
          intervalMinutes: frequency === "interval" ? Number(raw.intervalMinutes) : null,
          voice: true,
          fireAt,
          owner: "parent",
        });
        // 打源标记（source_task → extra_json）：滚动替换与防重都靠它
        db.prepare("UPDATE scheduler_tasks SET extra_json = ?, updated_at = ? WHERE id = ?").run(
          JSON.stringify({ source_task: sourceTaskId, source: "custom_task" }),
          nowIso,
          rid
        );
        created.push(`「${text.slice(0, 24)}」${time}${frequency === "daily" ? "" : `（${frequency}）`}`);
      }
      const parts = [`新建 ${created.length} 条`];
      if (disabled) parts.push(`替换本源旧提醒 ${disabled} 条`);
      if (skipped.length) parts.push(`跳过 ${skipped.length} 条（${skipped.slice(0, 3).join("；")}${skipped.length > 3 ? "…" : ""}）`);
      const body = created.length ? `\n${created.map((c) => `- ${c}`).join("\n")}` : "";
      return ok(`${parts.join("，")}。${body}`);
    },
  });
}

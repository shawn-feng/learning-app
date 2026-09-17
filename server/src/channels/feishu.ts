/**
 * 飞书渠道（2026-09-17）：官方 SDK WebSocket 长连接收消息（无需公网回调），
 * 进程内直调家长/孩子会话（复用 runTurn 聚合回复），im/v1/messages 发回飞书。
 *
 * 配置来源（applyFeishuChannel 按此优先级）：
 * 1. 主库 settings 表 key=channel_feishu：{appId, appSecret, enabled}——家长在设置页保存，保存即生效；
 * 2. 回退环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（settings 未配置时）。
 *
 * 事件：im.message.receive_v1（只处理单聊 text 消息；群聊/媒体后续分期）。
 * 幂等：飞书可能重推事件，按 message_id 去重（10 分钟内存窗）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as lark from "@larksuiteoapi/node-sdk";
import { submitParentPrompt } from "../agent/parent-registry.js";
import { submitChildPrompt } from "../agent/session-registry.js";
import { runTurn } from "../routes/wechat.js";

export const FEISHU_SETTINGS_KEY = "channel_feishu";

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  enabled: boolean;
}

interface ActiveChannel {
  ws: lark.WSClient;
  appId: string;
}

let active: ActiveChannel | null = null;
let lastStatus = "未启用";

export function feishuStatus(): { running: boolean; appId: string; status: string } {
  return { running: !!active, appId: active?.appId ?? "", status: lastStatus };
}

export function readFeishuConfig(db: DatabaseSync): FeishuChannelConfig | null {
  const row = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(FEISHU_SETTINGS_KEY) as
    | { value_json: string }
    | undefined;
  if (!row) return null;
  try {
    const o = JSON.parse(row.value_json) as Partial<FeishuChannelConfig>;
    if (!o.appId || !o.appSecret) return null;
    return { appId: String(o.appId), appSecret: String(o.appSecret), enabled: o.enabled !== false };
  } catch {
    return null;
  }
}

export function saveFeishuConfig(db: DatabaseSync, cfg: FeishuChannelConfig): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value_json, updated) VALUES (?, ?, ?)").run(
    FEISHU_SETTINGS_KEY,
    JSON.stringify({ appId: cfg.appId, appSecret: cfg.appSecret, enabled: cfg.enabled }),
    new Date().toISOString()
  );
}

/** 停掉当前连接（配置变更/停用时调用） */
function stopActive(): void {
  if (!active) return;
  try {
    active.ws.close();
  } catch {
    /* 已断开则忽略 */
  }
  active = null;
  lastStatus = "已停用";
}

/** 应用配置：设置有值用设置，否则回退环境变量；同 appId 已在跑则不动。 */
export function applyFeishuChannel(deps: { db: DatabaseSync; dataDir: string }): {
  started: boolean;
  appId: string;
  status: string;
} {
  const cfg = readFeishuConfig(deps.db);
  const appId = cfg?.appId || process.env.FEISHU_APP_ID || "";
  const appSecret = cfg?.appSecret || process.env.FEISHU_APP_SECRET || "";
  const enabled = cfg ? cfg.enabled : Boolean(appId && appSecret);

  if (!enabled || !appId || !appSecret) {
    stopActive();
    lastStatus = "未启用（缺少配置或未开启）";
    return { started: false, appId, status: lastStatus };
  }
  if (active && active.appId === appId) {
    return { started: true, appId, status: lastStatus };
  }
  stopActive();

  const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu });
  const sendText = async (openId: string, text: string): Promise<void> => {
    await (client.im as any).v1.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  };

  const upsertBindRequest = (openId: string, sample: string): "pending" | "rejected" => {
    const now = nowStr();
    deps.db
      .prepare(
        `INSERT INTO wechat_bind_requests (id, wechat_id, channel, sample_text, first_seen, last_seen, status)
         VALUES (?,?, 'feishu', ?,?,?,'pending')
         ON CONFLICT(channel, wechat_id) DO UPDATE SET
           sample_text=excluded.sample_text, last_seen=excluded.last_seen,
           status=CASE WHEN wechat_bind_requests.status='pending' THEN 'pending' ELSE wechat_bind_requests.status END`
      )
      .run(randomUUID(), openId, sample.slice(0, 120), now, now);
    const rejected = deps.db
      .prepare("SELECT 1 FROM wechat_bind_requests WHERE channel = 'feishu' AND wechat_id = ? AND status = 'rejected'")
      .get(openId);
    return rejected ? "rejected" : "pending";
  };

  const eventDispatcher = new lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: any) => {
      try {
        const msg = data?.message ?? {};
        const messageId = String(msg.message_id ?? "");
        const chatType = String(msg.chat_type ?? "");
        const openId = String(data?.sender?.sender_id?.open_id ?? "");
        if (!messageId || isDuplicate(messageId)) return;
        if (chatType !== "p2p") return; // 一期只做单聊
        if (!openId) return;
        const text = extractText(msg.content);
        if (!text) {
          await sendText(openId, "暂时只能看懂文字消息，语音/图片还没学会～").catch(() => undefined);
          return;
        }

        const b = deps.db
          .prepare("SELECT role, parent_id, child_id FROM wechat_bindings WHERE channel = 'feishu' AND wechat_id = ?")
          .get(openId) as { role: "parent" | "child"; parent_id: string; child_id: string } | undefined;
        if (!b) {
          const st = upsertBindRequest(openId, text);
          await sendText(
            openId,
            st === "rejected"
              ? "这个飞书账号还没有绑定学习伙伴。"
              : "这个飞书账号还没有绑定。家长会在 App「设置 → 微信绑定」里看到确认请求，确认后请再发一次。"
          );
          return;
        }

        const channelText =
          `（这条消息来自飞书。回复要求：纯文本短句、口语化、控制在一两百字内；` +
          `不要用 markdown 表格、标题、加粗，多行用换行即可。）\n\n${text}`;
        const sessionDeps = { db: deps.db, dataDir: deps.dataDir };
        const turn =
          b.role === "parent"
            ? runTurn(() => submitParentPrompt(sessionDeps, b.parent_id, "parent", channelText), `${b.parent_id}:parent`)
            : runTurn(
                () => submitChildPrompt(sessionDeps, b.parent_id, b.child_id, channelText),
                `${b.parent_id}:${b.child_id}`
              );
        const r = await turn;
        await sendText(
          openId,
          r.ok ? r.reply : r.error?.startsWith("busy") ? "上一条还在想，稍等一下再发～" : `学习服务端暂时没能回答：${r.error ?? ""}`
        );
      } catch (err) {
        console.error("[feishu] 处理消息失败:", (err as Error)?.message || err);
      }
    },
  });

  const ws = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
  void ws.start({ eventDispatcher });
  active = { ws, appId };
  lastStatus = "运行中";
  console.log(`[feishu] 渠道已启动（长连接，appId=${appId.slice(0, 8)}…）`);
  return { started: true, appId, status: lastStatus };
}

// ---------- 纯逻辑（导出供测试） ----------

/** 飞书 text 消息 content 是 JSON 字符串（{"text":"..."}），@提及为 @_user_1 占位 */
export function extractText(contentJson: string | undefined): string {
  try {
    const o = JSON.parse(String(contentJson ?? "{}")) as { text?: string };
    return String(o.text ?? "")
      .replace(/@_user_\d+/g, "")
      .trim();
  } catch {
    return "";
  }
}

export function feishuBindingLookup(db: DatabaseSync, openId: string) {
  return db
    .prepare("SELECT role, parent_id, child_id FROM wechat_bindings WHERE channel = 'feishu' AND wechat_id = ?")
    .get(openId) as { role: "parent" | "child"; parent_id: string; child_id: string } | undefined;
}

export const __test = { extractText };

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  // 收缩过期窗口（10 分钟）
  for (const [id, ts] of recentMessageIds) {
    if (now - ts > 600_000) recentMessageIds.delete(id);
  }
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.set(messageId, now);
  return false;
}
const recentMessageIds = new Map<string, number>();

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

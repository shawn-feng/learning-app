/**
 * 飞书渠道（2026-09-17）：官方 SDK WebSocket 长连接收消息（无需公网回调），
 * 进程内直调家长/孩子会话（复用 runTurn 聚合回复），im/v1/messages 发回飞书。
 *
 * 配置（环境变量，二者都有才启动；缺省不启用，对现有部署零影响）：
 * - FEISHU_APP_ID / FEISHU_APP_SECRET  飞书开放平台企业自建应用凭据
 *
 * 事件：im.message.receive_v1（只处理单聊 text 消息；群聊/媒体后续分期）。
 * 幂等：飞书可能重推事件，按 message_id 去重（10 分钟内存窗）。
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import * as lark from "@larksuiteoapi/node-sdk";
import { agentStreamHub } from "../agent/stream-hub.js";
import { submitParentPrompt } from "../agent/parent-registry.js";
import { submitChildPrompt } from "../agent/session-registry.js";
import { runTurn } from "../routes/wechat.js";

interface FeishuDeps {
  db: DatabaseSync;
  dataDir: string;
  appId: string;
  appSecret: string;
}

const recentMessageIds = new Set<string>();
const recentMessageIdsAt: number[] = [];

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  while (recentMessageIdsAt.length && now - recentMessageIdsAt[0]! > 600_000) {
    recentMessageIdsAt.shift();
  }
  // 数组与 Set 同步收缩：简单起见 Set 不清理，量级（家庭使用）极小
  if (recentMessageIds.has(messageId)) return true;
  recentMessageIds.add(messageId);
  recentMessageIdsAt.push(now);
  return false;
}

/** 飞书 text 消息 content 是 JSON 字符串（{"text":"..."}），@提及为 @_user_1 占位 */
function extractText(contentJson: string | undefined): string {
  try {
    const o = JSON.parse(String(contentJson ?? "{}")) as { text?: string };
    return String(o.text ?? "")
      .replace(/@_user_\d+/g, "")
      .trim();
  } catch {
    return "";
  }
}

function nowStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function startFeishuChannel(deps: FeishuDeps): { started: boolean; reason?: string } {
  const { db, dataDir, appId, appSecret } = deps;
  if (!appId || !appSecret) return { started: false, reason: "未配置 FEISHU_APP_ID/FEISHU_APP_SECRET" };

  const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu });

  const sendText = async (openId: string, text: string): Promise<void> => {
    await (client.im as any).v1.message.create({
      params: { receive_id_type: "open_id" },
      data: { receive_id: openId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  };

  const upsertBindRequest = (openId: string, sample: string): "pending" | "rejected" => {
    const now = nowStr();
    db.prepare(
      `INSERT INTO wechat_bind_requests (id, wechat_id, channel, sample_text, first_seen, last_seen, status)
       VALUES (?,?, 'feishu', ?,?,?,'pending')
       ON CONFLICT(channel, wechat_id) DO UPDATE SET
         sample_text=excluded.sample_text, last_seen=excluded.last_seen,
         status=CASE WHEN wechat_bind_requests.status='pending' THEN 'pending' ELSE wechat_bind_requests.status END`
    ).run(randomUUID(), openId, sample.slice(0, 120), now, now);
    const rejected = db
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

        const b = db
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
        const sessionDeps = { db, dataDir };
        if (b.role === "parent") {
          const r = await runTurn(
            () => submitParentPrompt(sessionDeps, b.parent_id, "parent", channelText),
            `${b.parent_id}:parent`
          );
          await sendText(openId, r.ok ? r.reply : r.error?.startsWith("busy") ? "上一条还在想，稍等一下再发～" : `学习服务端暂时没能回答：${r.error ?? ""}`);
          return;
        }
        const r = await runTurn(
          () => submitChildPrompt(sessionDeps, b.parent_id, b.child_id, channelText),
          `${b.parent_id}:${b.child_id}`
        );
        await sendText(openId, r.ok ? r.reply : r.error?.startsWith("busy") ? "上一条还在想，稍等一下再发～" : `学习服务端暂时没能回答：${r.error ?? ""}`);
      } catch (err) {
        console.error("[feishu] 处理消息失败:", (err as Error)?.message || err);
      }
    },
  });

  const ws = new lark.WSClient({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.warn });
  void ws.start({ eventDispatcher });
  console.log(`[feishu] 渠道已启动（长连接，appId=${appId.slice(0, 8)}…）`);
  return { started: true };
}

/** 供测试：绑定查找 + 文本提取的纯逻辑导出 */
export function feishuBindingLookup(db: DatabaseSync, openId: string) {
  return db
    .prepare("SELECT role, parent_id, child_id FROM wechat_bindings WHERE channel = 'feishu' AND wechat_id = ?")
    .get(openId) as { role: "parent" | "child"; parent_id: string; child_id: string } | undefined;
}

export const __test = { extractText, randomUUID };

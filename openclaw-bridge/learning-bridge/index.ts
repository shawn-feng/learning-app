/**
 * Learning Bridge（学习伙伴 × OpenClaw 微信桥，2026-09-17）。
 *
 * 职责：在 OpenClaw 的 before_agent_reply 钩子里拦截微信私信，转发给 learning-server
 * 的 /api/v1/wechat/turn（server 侧用 wechat_bindings 把微信号映射到家长/孩子 agent 会话，
 * 聚合一轮的最终文本返回）。handled=true 直接返回回复，OpenClaw 自己的 LLM 不参与。
 *
 * 配置（环境变量，gateway 进程读取）：
 * - LEARNING_SERVER_URL   学习服务端地址，默认 http://127.0.0.1:8788
 * - LEARNING_WECHAT_TOKEN 连接令牌；server 未设令牌时只允许回环来源（同机部署默认即可）
 * - LEARNING_BRIDGE_DEBUG "1" 时把收到的 first event 原样打进 stderr（排查字段名用）
 *
 * 兜底：字段名按 OpenClaw 版本可能有差异——发件人优先取 bodyForAgent/from/senderId，
 * 文本优先取 bodyForAgent/cleanedBody；都取不到时放行给 agent（不拦截），并打 stderr 日志。
 */
interface BridgeEvent {
  cleanedBody?: string;
  bodyForAgent?: unknown;
  from?: unknown;
  senderId?: unknown;
  peerId?: unknown;
  channel?: unknown;
  content?: unknown;
}

const SERVER_URL = process.env.LEARNING_SERVER_URL || "http://127.0.0.1:8788";
const TOKEN = process.env.LEARNING_WECHAT_TOKEN || "";
const DEBUG = process.env.LEARNING_BRIDGE_DEBUG === "1";

let loggedSample = false;

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
    if (typeof o.body === "string") return o.body;
  }
  return "";
}

function senderOf(ev: BridgeEvent, ctx: any): string {
  for (const v of [ev.from, ev.senderId, ev.peerId, ev.bodyForAgent && (ev.bodyForAgent as any)?.from]) {
    const s = typeof v === "string" ? v : asText(v);
    if (s) return s;
  }
  // 实测（2026-09-17）：openclaw-weixin 事件里没有独立发件人字段，
  // 发件人 id 是 sessionKey 末段（如 agent:main:openclaw-weixin:direct:<peer>），且被小写化
  const sk = String(ctx?.sessionKey ?? "");
  if (sk) {
    const segs = sk.split(":").filter(Boolean);
    if (segs.length >= 2) return segs[segs.length - 1];
    return sk;
  }
  return "";
}

function channelOf(ev: BridgeEvent, ctx: any): string {
  for (const v of [ev.channel, ctx?.channel, String(ctx?.sessionKey ?? "")]) {
    const s = typeof v === "string" ? v : "";
    if (s) return s;
  }
  return "";
}

async function callServer(senderId: string, text: string): Promise<{ ok: boolean; reply: string; code?: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300_000);
  try {
    const res = await fetch(`${SERVER_URL}/api/v1/wechat/turn`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(TOKEN ? { "x-wechat-token": TOKEN } : {}),
      },
      body: JSON.stringify({ senderId, text }),
      signal: ctrl.signal,
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.status === 409 || data.code === "busy") {
      return { ok: true, reply: "上一条还在想，稍等一下再发～" };
    }
    if (data.code === "unbound") {
      return { ok: true, reply: data.reply || "这个微信号还没有绑定学习伙伴，请家长在 App 设置里完成绑定。" };
    }
    if (!res.ok || !data.ok) {
      return { ok: true, reply: `学习服务端暂时没能回答（${data.error || res.status}），稍后再试试。` };
    }
    return { ok: true, reply: data.reply || "（这轮没有内容）" };
  } catch (err) {
    return { ok: true, reply: `联系学习服务端失败：${(err as Error)?.message || err}（它开着吗？）` };
  } finally {
    clearTimeout(timer);
  }
}

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "learning-bridge",
  name: "Learning Bridge",
  register(api: any) {
    api.on(
      "before_agent_reply",
      async (event: BridgeEvent, ctx: any) => {
        if (DEBUG && !loggedSample) {
          loggedSample = true;
          console.error("[learning-bridge] sample event:", JSON.stringify({ event, ctx: ctx && { agentId: ctx.agentId, sessionKey: ctx.sessionKey, channel: ctx.channel } }).slice(0, 2000));
        }
        const ch = channelOf(event, ctx);
        // 只接管微信渠道（渠道字段缺失时按 sessionKey 前缀兜底判断）
        const isWeixin = ch.includes("weixin") || ch.includes("wechat") || ch === "";
        if (!isWeixin) return undefined;

        const text = (asText(event.bodyForAgent) || asText(event.cleanedBody) || asText(event.content)).trim();
        const senderId = senderOf(event, ctx);
        if (!text || !senderId) {
          console.error(`[learning-bridge] 无法解析消息（text=${!!text} sender=${senderId || "无"}），放行给 agent`);
          return undefined;
        }
        const r = await callServer(senderId, text);
        return { handled: true, reply: { text: r.reply } };
      },
      { eligibleTriggers: ["user"] },
    );
  },
});

/**
 * 大模型配额面板（ISSUE-174：TokenHub 统一模型接入）。
 *
 * 两个口径并列展示：
 *  - 官方口径（remote）：腾讯网关统计的当日用量/配额，权威但**有分钟级以上到账延迟**；
 *  - 本地口径（local）：服务端 token_usage 按日累计，准实时。
 * 硬限额由腾讯网关强制，展示延迟不影响扣减；额度不足引导「联系管理员充值」。
 */
import { useEffect, useState } from "react";

interface QuotaData {
  remote: {
    keyMasked: string;
    quota: { cycleUnit: string; cycleCredits: number; cycleUsed: number; quotaStatus: string; keyStatus: string };
    defaultDailyCredits: number;
  } | null;
  remoteError: string;
  local: {
    today: number;
    days: Array<{ date: string; tokens: number; cost: number }>;
    /** 四类拆分（本地口径按模型名归类，准实时）：text=文本（含编程） vision=视觉识别 asr=语音识别 tts=语音合成 */
    categories?: {
      today: { text: number; vision: number; asr: number; tts: number };
      byDay: Array<{ date: string; text: number; vision: number; asr: number; tts: number }>;
    };
  };
  /** 官方按模型占比折算到实时已用的四类（总和 === CycleUsed）；不可得时为 null */
  officialCategories?: { text: number; vision: number; asr: number; tts: number } | null;
  officialCategoriesNote?: string;
  modelInfo: { provider: string; textModel: string; visionModel: string };
}

const fmt = (n: number) => (n || 0).toLocaleString("zh-CN");
const fmtWan = (n: number) => (n >= 10000 ? `${(n / 10000).toFixed(n % 10000 === 0 ? 0 : 1)} 万` : fmt(n));

export default function TokenHubQuotaPanel() {
  const [data, setData] = useState<QuotaData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      const r = await window.api.tokenhubQuotaGet();
      if (r?.success === false) {
        setError(r.error || "加载失败");
      } else if (r) {
        setData(r);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const remote = data?.remote ?? null;
  const quota = remote?.quota;
  const used = quota?.cycleUsed ?? 0;
  const credits = quota?.cycleCredits ?? remote?.defaultDailyCredits ?? 0;
  const remaining = Math.max(0, credits - used);
  const pct = credits ? Math.min(100, Math.round((used / credits) * 100)) : 0;
  const exhausted = quota?.quotaStatus === "inactive" || (credits > 0 && remaining <= 0);
  const low = !exhausted && credits > 0 && remaining / credits < 0.1;
  // 展示口径：官方 CycleUsed 有延迟，剩余量 = max(配额 - max(官方已用, 本地今日), 0) 取保守值
  const localToday = data?.local.today ?? 0;
  const displayRemaining = credits ? Math.max(0, credits - Math.max(used, localToday)) : null;
  const cats = data?.local.categories;
  const officialCategories = data?.officialCategories ?? null;
  const officialNote = data?.officialCategoriesNote || "";

  return (
    <div style={{ margin: "8px 0 4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h4 style={{ fontSize: 15, margin: 0 }}>配额使用情况</h4>
        <button
          onClick={load}
          disabled={loading}
          style={{ padding: "6px 14px", background: "#e9f9dc", color: "#58a700", border: "none", borderRadius: 8, cursor: "pointer" }}
        >
          {loading ? "刷新中…" : "刷新"}
        </button>
      </div>

      {error && <p style={{ fontSize: 13, color: "#ff4b4b" }}>{error}</p>}
      {loading && !data && <p style={{ color: "#777777", fontSize: 13 }}>加载中…</p>}

      {exhausted && (
        <div style={{
          padding: "12px 16px", background: "#fee2e2", borderRadius: 10,
          color: "#b91c1c", fontSize: 14, fontWeight: 600, marginBottom: 14,
        }}>
          ⛔ 今日大模型额度已用完，AI 伙伴暂时无法使用。请联系管理员充值，充值后立即恢复。
        </div>
      )}
      {!exhausted && low && (
        <div style={{
          padding: "12px 16px", background: "#fef9c3", borderRadius: 10,
          color: "#a16207", fontSize: 14, fontWeight: 600, marginBottom: 14,
        }}>
          ⚠️ 今日额度剩余不足 10%，用完后请联系管理员充值。
        </div>
      )}

      {/* 当日配额卡 */}
      <div style={{ background: "#f8fafc", borderRadius: 12, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>今日额度</span>
          <span style={{ fontSize: 13, color: "#667" }}>
            {quota ? `官方统计 · 剩余 ${fmtWan(displayRemaining ?? remaining)} tokens` : "官方统计暂不可用"}
          </span>
        </div>
        <div style={{ background: "#e5e5e5", borderRadius: 8, height: 14, overflow: "hidden" }}>
          <div style={{
            width: `${pct}%`, height: "100%", borderRadius: 8,
            background: exhausted ? "#ff4b4b" : low ? "#f59e0b" : "#58cc02",
            transition: "width .3s",
          }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 6, fontSize: 12, color: "#889" }}>
          <span>已用 {fmtWan(used)}（{pct}%）</span>
          <span>配额 {credits ? `${fmtWan(credits)} tokens/天` : "未知"}</span>
        </div>
        <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 8 }}>
          本地已记录（含缓存重复计与未落盘调用的口径差，仅供参考，扣减以官方为准）：
          今日本地已记录 {fmtWan(localToday)} tokens。
          {remote?.keyMasked ? ` · Key ${remote.keyMasked}` : ""}
        </div>
      </div>

      {/* 今日四类拆分：优先官方口径（与「今日已用」同源）；官方不可得时回落本地记录 */}
      {officialCategories ? (
        <div style={{ background: "#f8fafc", borderRadius: 12, padding: "12px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>今日分类消耗</div>
            <div style={{ fontSize: 11, color: "#a0aec0" }}>
              {officialNote || "官方统计"}
            </div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {(
              [
                ["📝 文本（含编程）", officialCategories.text, ""],
                ["👁️ 视觉识别", officialCategories.vision, ""],
                ["🎙️ 语音识别", officialCategories.asr, ""],
                ["🔊 语音合成", officialCategories.tts, "免费，不计配额"],
              ] as Array<[string, number, string]>
            ).map(([label, tokens, note]) => (
              <div key={label} style={{
                flex: "1 1 150px", background: "white", border: "1px solid #e5e5e5",
                borderRadius: 10, padding: "8px 12px",
              }}>
                <div style={{ fontSize: 12, color: "#667" }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{fmtWan(tokens)} tokens</div>
                {note && <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 1 }}>{note}</div>}
              </div>
            ))}
          </div>
        </div>
      ) : cats && (
        <div style={{ background: "#f8fafc", borderRadius: 12, padding: "12px 16px", marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>今日分类消耗（本地已记录）</div>
            <div style={{ fontSize: 11, color: "#a0aec0" }}>与官方已用口径不同，仅供参考</div>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
            {(
              [
                ["📝 文本（含编程）", cats.today.text, ""],
                ["👁️ 视觉识别", cats.today.vision, ""],
                ["🎙️ 语音识别", cats.today.asr, ""],
                ["🔊 语音合成", cats.today.tts, "免费，不计配额"],
              ] as Array<[string, number, string]>
            ).map(([label, tokens, note]) => (
              <div key={label} style={{
                flex: "1 1 150px", background: "white", border: "1px solid #e5e5e5",
                borderRadius: 10, padding: "8px 12px",
              }}>
                <div style={{ fontSize: 12, color: "#667" }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 600, marginTop: 2 }}>{fmtWan(tokens)} tokens</div>
                {note && <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 1 }}>{note}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {data?.remoteError ? (
        <p style={{ fontSize: 12, color: "#a0aec0", marginTop: 0 }}>{`官方配额获取失败：${data.remoteError}（本地统计不受影响）`}</p>
      ) : null}

      {/* 近 7 天本地记录（仅内置模型，含四类拆分列；口径与官方有差，详见上方说明） */}
      <h4 style={{ fontSize: 15, margin: "18px 0 8px" }}>近 7 天内置模型消耗（本地已记录）</h4>
      {data && (data.local.days.length > 0 || (cats && cats.byDay.length > 0)) ? (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ color: "#889", textAlign: "left" }}>
              <th style={{ padding: "6px 8px", fontWeight: 500 }}>日期</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>文本</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>视觉识别</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>语音识别</th>
              <th style={{ padding: "6px 8px", fontWeight: 500, textAlign: "right" }}>合计</th>
            </tr>
          </thead>
          <tbody>
            {(cats?.byDay.length
              ? cats.byDay.map((c) => ({
                  date: c.date,
                  text: c.text,
                  vision: c.vision,
                  asr: c.asr,
                  tokens: c.text + c.vision + c.asr + c.tts,
                }))
              : data.local.days.map((d) => ({ date: d.date, text: 0, vision: 0, asr: 0, tokens: d.tokens }))
            )
              .slice()
              .reverse()
              .map((d) => (
                <tr key={d.date} style={{ borderTop: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "6px 8px" }}>{d.date}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(d.text)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(d.vision)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right" }}>{fmt(d.asr)}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontWeight: 600 }}>{fmt(d.tokens)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      ) : (
        <p style={{ color: "#777777", fontSize: 13 }}>暂无用量记录</p>
      )}

      <p style={{ fontSize: 12, color: "#a0aec0", marginTop: 16 }}>额度不足时请联系管理员充值（即时生效）。</p>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles, Save, RefreshCw, ShieldCheck, Gift, AlertTriangle } from "lucide-react";

/**
 * 家长端「积分」页（2026-09-10 计划域 + 积分域重构）。
 *
 * 三块内容：
 *  1. **积分概览**：余额、累计获得/扣除/兑换、当日结算（按 来源×制定人 四象限）、**未解锁提示**（策略 A）。
 *  2. **积分奖罚设置**：按比例自由分档（默认 4 档：不合格/合格/良好/优秀，**100% 是独立档**），
 *     可增删档/改名/改区间/改分值；门控按**阈值**配置（待办默认 100%、考核默认 90%）。
 *  3. **审计与修正**：当日/近期计划行（必须完成项 / 加分项），家长可「取消计划」「撤销判定」「代判完成」——
 *     这是「LLM 判定 + 不兜底」方案能站得住的前提（孩子不勾选、家长有纠错权）。
 */
interface Tier {
  min: number;
  max: number;
  label: string;
  points: number;
}

interface RewardConfig {
  todoTiers: Tier[];
  examTiers: Tier[];
  todoGateMinRate: number;
  examGateMinScore: number;
  childNoDeduct: boolean;
  optionalPoints: number;
}

interface PlanRow {
  planId: string;
  kind: "study" | "life" | "exam";
  title: string;
  owner: string;
  status: string;
  startAt: string;
  dueAt: string;
  carry: boolean;
  points?: number;
}

const KIND_LABEL: Record<string, string> = { study: "学习", life: "生活", exam: "考核" };
const STATUS_LABEL: Record<string, string> = {
  pending: "待完成",
  done: "已完成",
  missed: "未完成",
  cancelled: "已取消",
};
const STATUS_COLOR: Record<string, string> = {
  pending: "#64748b",
  done: "#16a34a",
  missed: "#dc2626",
  cancelled: "#94a3b8",
};

/** "0.8" ⇄ 0.8；显示用百分比字符串。 */
function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

export default function RewardPanel({ children }: { children: Array<{ id?: string; childId?: string; name: string }> }) {
  const childList = useMemo(
    () => children.map((c) => ({ id: c.childId || c.id || "", name: c.name })),
    [children]
  );
  const [childId, setChildId] = useState("");
  const [date, setDate] = useState(() => new Date().toLocaleDateString("sv-SE"));
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [reward, setReward] = useState<any>(null);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [cfg, setCfg] = useState<RewardConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedTip, setSavedTip] = useState("");

  useEffect(() => {
    if (!childId && childList.length) setChildId(childList[0]!.id);
  }, [childList, childId]);

  const load = useCallback(async () => {
    if (!childId) return;
    setLoading(true);
    setErr("");
    try {
      const [r, p, c] = await Promise.all([
        window.api.rewardGet(childId, { date, days: 30, limit: 60 }),
        window.api.todoGet(childId, date),
        window.api.rewardConfigGet(childId),
      ]);
      if (r?.success) setReward(r);
      else setErr((r as any)?.error || "积分数据读取失败");
      if (p?.success) setPlans((((p as any).items as PlanRow[]) || []).filter((i) => i.status !== "cancelled"));
      if (c?.success) setCfg((c as any).config as RewardConfig);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [childId, date]);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = async (row: PlanRow, action: "cancel" | "reopen" | "done") => {
    const res = await window.api.planSetStatus({ childId, planId: row.planId, kind: row.kind, action });
    if (!res?.success) setErr((res as any)?.error || "操作失败");
    await load();
  };

  const saveCfg = async () => {
    if (!cfg || !childId) return;
    setSaving(true);
    setSavedTip("");
    try {
      const res = await window.api.rewardConfigSet(childId, cfg as unknown as Record<string, unknown>);
      if (res?.success) setSavedTip("已保存 ✓");
      else setErr((res as any)?.error || "保存失败（请检查分档是否从 0 连续覆盖到 100% 且不重叠）");
    } finally {
      setSaving(false);
    }
  };

  const patchTier = (which: "todoTiers" | "examTiers", idx: number, patch: Partial<Tier>) => {
    if (!cfg) return;
    const arr = cfg[which].map((t, i) => (i === idx ? { ...t, ...patch } : t));
    setCfg({ ...cfg, [which]: arr });
  };
  /** 加一档：把**最宽**的档从中间劈开（避免产生退化区间）。 */
  const addTier = (which: "todoTiers" | "examTiers") => {
    if (!cfg) return;
    const arr = cfg[which].map((t) => ({ ...t }));
    let wi = -1;
    let wspan = 0;
    for (let i = 0; i < arr.length; i++) {
      const span = arr[i]!.max - arr[i]!.min;
      if (span > wspan) {
        wspan = span;
        wi = i;
      }
    }
    if (wi < 0 || wspan <= 0.02) return; // 没有可劈的档
    const t = arr[wi]!;
    const mid = Math.round(((t.min + t.max) / 2) * 100) / 100;
    if (!(mid > t.min && mid < t.max)) return;
    arr.splice(wi, 1, { ...t, max: mid }, { min: mid, max: t.max, label: "新档", points: 0 });
    setCfg({ ...cfg, [which]: arr });
  };
  /** 删一档：把缺口并给后一档（保证从 0 连续覆盖到 100%、不重叠）。 */
  const removeTier = (which: "todoTiers" | "examTiers", idx: number) => {
    if (!cfg) return;
    if (cfg[which].length <= 1) return;
    const arr = cfg[which].filter((_, i) => i !== idx).map((t) => ({ ...t }));
    arr.sort((a, b) => a.min - b.min);
    arr[0]!.min = 0;
    arr[arr.length - 1]!.max = 1;
    for (let i = 1; i < arr.length; i++) arr[i]!.min = arr[i - 1]!.max;
    setCfg({ ...cfg, [which]: arr });
  };

  const renderTiers = (which: "todoTiers" | "examTiers", title: string) => (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "#444" }}>{title}</div>
        <button
          onClick={() => addTier(which)}
          style={{ border: "1px solid #cbd5e1", background: "white", borderRadius: 6, fontSize: 12, padding: "2px 8px", cursor: "pointer" }}
        >
          + 加一档
        </button>
      </div>
      {cfg?.[which].map((t, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, fontSize: 12 }}>
          <span style={{ color: "#666", width: 24, textAlign: "right" }}>{pct(t.min)}</span>
          <span style={{ color: "#cbd5e1" }}>~</span>
          <span style={{ color: "#666", width: 34 }}>{pct(t.max)}</span>
          <input
            value={t.label}
            onChange={(e) => patchTier(which, i, { label: e.target.value })}
            style={{ width: 76, padding: "3px 6px", border: "1px solid #e2e8f0", borderRadius: 6 }}
          />
          <input
            type="number"
            value={t.points}
            onChange={(e) => patchTier(which, i, { points: Math.round(Number(e.target.value) || 0) })}
            style={{ width: 72, padding: "3px 6px", border: "1px solid #e2e8f0", borderRadius: 6 }}
          />
          <span style={{ color: "#94a3b8" }}>分</span>
          <button
            onClick={() => removeTier(which, i)}
            title="删除该档"
            style={{ border: "none", background: "transparent", color: "#cbd5e1", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
      ))}
      <div style={{ fontSize: 11, color: "#94a3b8" }}>
        区间须从 0 连续覆盖到 100% 且互不重叠；<b>100% 单独一档</b>（写 100%~100%）。负分档只对「必须完成项」生效。
      </div>
    </div>
  );

  const quadrants = (reward?.stats ?? []) as Array<any>;

  return (
    <div className="dashboard-content" style={{ padding: 16, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <h2 style={{ margin: 0, fontSize: 18, display: "flex", alignItems: "center", gap: 6 }}>
          <Sparkles size={18} /> 积分
        </h2>
        <select
          value={childId}
          onChange={(e) => setChildId(e.target.value)}
          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
        >
          {childList.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid #cbd5e1" }}
        />
        <button
          onClick={() => void load()}
          style={{ display: "flex", alignItems: "center", gap: 4, border: "1px solid #cbd5e1", background: "white", borderRadius: 6, padding: "4px 10px", cursor: "pointer" }}
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </div>

      {err && (
        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", borderRadius: 8, padding: "8px 10px", fontSize: 12, marginBottom: 12 }}>
          {err}
        </div>
      )}
      {loading && <p style={{ color: "#888", fontSize: 13 }}>加载中…</p>}

      {/* 概览 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {[
          [`${reward?.balance ?? 0}`, "当前余额", "#667eea"],
          [`+${reward?.totals?.earned ?? 0}`, "累计获得", "#16a34a"],
          [`-${reward?.totals?.deducted ?? 0}`, "累计扣除", "#dc2626"],
          [`-${reward?.totals?.redeemed ?? 0}`, "已兑换", "#7c3aed"],
        ].map(([v, label, color], i) => (
          <div
            key={i}
            style={{ flex: "1 1 120px", background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: "10px 14px" }}
          >
            <div style={{ fontSize: 20, fontWeight: 700, color: color as string }}>{v}</div>
            <div style={{ fontSize: 12, color: "#888", marginTop: 2 }}>{label}</div>
          </div>
        ))}
      </div>

      {/* 未解锁提示（策略 A：家长端） */}
      {reward?.gateBlocked?.length ? (
        <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 10, padding: "10px 12px", marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600, color: "#92400e", marginBottom: 4 }}>
            <AlertTriangle size={15} /> 孩子达标了，但本次未加分
          </div>
          {reward.gateBlocked.map((g: any, i: number) => (
            <div key={i} style={{ fontSize: 12, color: "#92400e", lineHeight: 1.7 }}>
              {g.source === "exam" ? "考核" : "计划"}：孩子完成率 {pct(g.rate)}
              {g.tier ? `（${g.tier}）` : ""}，但**必须完成项**未达门槛，本次孩子未加分。
            </div>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* 左侧：当日结算 + 流水 */}
        <div style={{ flex: "1 1 380px", minWidth: 320 }}>
          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 8 }}>当日结算（{date}）</div>
            {!quadrants.length ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>当天还没有结算记录（无计划或未到结算时点）。</div>
            ) : (
              quadrants.map((s, i) => (
                <div
                  key={i}
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#555", padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}
                >
                  <span>
                    {s.source === "exam" ? "考核" : "计划"} · {s.owner === "parent" ? "必须完成项" : "加分项"}
                    {s.tier ? ` · ${s.tier}` : ""}
                    {s.gateOk === 0 ? " · 未解锁" : ""}
                  </span>
                  <span>
                    {s.done}/{s.total}（{pct(s.rate)}）{" "}
                    <b style={{ color: s.pointsAwarded > 0 ? "#16a34a" : s.pointsAwarded < 0 ? "#dc2626" : "#94a3b8" }}>
                      {s.pointsAwarded > 0 ? `+${s.pointsAwarded}` : s.pointsAwarded || 0}
                    </b>
                  </span>
                </div>
              ))
            )}
          </div>

          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
              <Gift size={15} /> 积分流水（每一分都有原因）
            </div>
            {!reward?.ledger?.length ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>暂无流水。</div>
            ) : (
              reward.ledger.map((l: any) => (
                <div key={l.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#555", padding: "6px 0", borderBottom: "1px solid #f1f5f9" }}>
                  <span style={{ flex: 1, minWidth: 0, paddingRight: 8, wordBreak: "break-word" }}>
                    {l.reason || l.reasonCode}
                    <span style={{ color: "#b0b7c3", marginLeft: 6 }}>{l.bizDate}</span>
                  </span>
                  <b style={{ color: l.type === "deduct" ? "#dc2626" : l.type === "redeem" ? "#7c3aed" : "#16a34a" }}>
                    {l.type === "earn" ? "+" : "-"}
                    {l.amount}
                  </b>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 右侧：设置 + 审计 */}
        <div style={{ flex: "1 1 380px", minWidth: 320 }}>
          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14, marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 10 }}>积分奖罚设置</div>
            {cfg ? (
              <>
                {renderTiers("todoTiers", "计划完成率分档")}
                {renderTiers("examTiers", "考核得分率分档")}
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginBottom: 10 }}>
                  <label style={{ fontSize: 12, color: "#555" }}>
                    孩子加分门槛（计划完成率≥）
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={cfg.todoGateMinRate}
                      onChange={(e) => setCfg({ ...cfg, todoGateMinRate: Number(e.target.value) })}
                      style={{ width: 78, marginLeft: 6, padding: "3px 6px", border: "1px solid #e2e8f0", borderRadius: 6 }}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: "#555" }}>
                    孩子加分门槛（考核得分率≥）
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="1"
                      value={cfg.examGateMinScore}
                      onChange={(e) => setCfg({ ...cfg, examGateMinScore: Number(e.target.value) })}
                      style={{ width: 78, marginLeft: 6, padding: "3px 6px", border: "1px solid #e2e8f0", borderRadius: 6 }}
                    />
                  </label>
                </div>
                <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.7, marginBottom: 10 }}>
                  门控：只有「必须完成项」达到该比例，「加分项」才能加分（孩子自己的计划达标却因家长计划没完成而不加分时，
                  会在双方提示）。孩子侧只加不扣。
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <button
                    onClick={() => void saveCfg()}
                    disabled={saving}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      background: "#667eea",
                      color: "white",
                      border: "none",
                      borderRadius: 8,
                      padding: "6px 14px",
                      cursor: saving ? "default" : "pointer",
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <Save size={15} /> 保存设置
                  </button>
                  {savedTip && <span style={{ fontSize: 12, color: "#16a34a" }}>{savedTip}</span>}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>设置读取中…</div>
            )}
          </div>

          <div style={{ background: "white", border: "1px solid #e2e8f0", borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#444", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <ShieldCheck size={15} /> 计划审计与修正（{date}）
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.7, marginBottom: 10 }}>
              孩子端**不能勾选**（防虚报），完成与否由系统判定。这里可核对并纠错：撤销误判、取消不该做的计划。
            </div>
            {!plans.length ? (
              <div style={{ fontSize: 12, color: "#94a3b8" }}>当天没有计划行。</div>
            ) : (
              plans.map((p) => (
                <div
                  key={p.planId}
                  style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "7px 0", borderBottom: "1px solid #f1f5f9" }}
                >
                  <span style={{ color: "#94a3b8", width: 34, flexShrink: 0 }}>{KIND_LABEL[p.kind]}</span>
                  <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{p.title}</span>
                  <span style={{ color: STATUS_COLOR[p.status] ?? "#64748b", width: 54, flexShrink: 0 }}>
                    {STATUS_LABEL[p.status] ?? p.status}
                  </span>
                  <span style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                    {p.status !== "done" && (
                      <button
                        onClick={() => void setStatus(p, "done")}
                        title="代判完成"
                        style={{ border: "1px solid #bbf7d0", background: "#f0fdf4", color: "#15803d", borderRadius: 6, fontSize: 11, padding: "2px 6px", cursor: "pointer" }}
                      >
                        完成
                      </button>
                    )}
                    {p.status !== "pending" && (
                      <button
                        onClick={() => void setStatus(p, "reopen")}
                        title="撤销判定（回到待完成）"
                        style={{ border: "1px solid #e2e8f0", background: "white", color: "#475569", borderRadius: 6, fontSize: 11, padding: "2px 6px", cursor: "pointer" }}
                      >
                        撤销
                      </button>
                    )}
                    <button
                      onClick={() => void setStatus(p, "cancel")}
                      title="取消该计划（不计完成率、不再顺延）"
                      style={{ border: "1px solid #fecaca", background: "#fef2f2", color: "#b91c1c", borderRadius: 6, fontSize: 11, padding: "2px 6px", cursor: "pointer" }}
                    >
                      取消
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

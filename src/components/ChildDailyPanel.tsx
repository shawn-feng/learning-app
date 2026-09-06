import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * ISSUE-049：孩子「每日记录」浏览面板（家长端只读）。
 * 数据源 = 服务端 child kb `daily_entries`（date/block/title/raw/tags，raw 为 markdown 风格原文）。
 * 布局：顶部筛选栏（日期范围 + 分类 + 标签 + 标题模糊）＋ 左列条目（按日期倒序、同日期按 block）＋ 右栏选中条目原文（markdown）。
 * 默认范围：最近 7 天；空态：筛选结果为空。
 */

interface DailyEntry {
  date: string; // YYYY-MM-DD
  block: string; // 学习/生活/问答/任务
  title: string;
  raw: string;
  tags: string;
}

interface Props {
  childId: string;
}

/** 4 区块的徽章配色（区别于「学习进度/考核」其它 tab，仅用于区块区分）。 */
const BLOCK_COLORS: Record<string, { bg: string; fg: string }> = {
  学习: { bg: "#eef2ff", fg: "#3b4cca" },
  生活: { bg: "#e8f7ee", fg: "#2f8a52" },
  问答: { bg: "#fdf3e3", fg: "#a26a0a" },
  任务: { bg: "#fbe9e9", fg: "#c0392b" },
};
const BLOCK_OPTIONS = ["学习", "生活", "问答", "任务"];

function toDateStr(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 今天往前 n-1 天起（含今天）的最近 n 天起始日期。 */
function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - (n - 1));
  return toDateStr(d);
}

function todayStr(): string {
  return toDateStr(new Date());
}

/** 每条目的稳定 key（date/block/title 唯一）。 */
function entryKey(e: DailyEntry): string {
  return `${e.date}\u0000${e.block}\u0000${e.title}`;
}

const fmtLongDate = (date: string) => {
  const [y, m, d] = date.split("-");
  return `${Number(m)}月${Number(d)}日 · ${y}`;
};

const inputStyle: CSSProperties = {
  padding: "5px 8px", fontSize: 13, borderRadius: 6, border: "1px solid #ddd", background: "#fff",
};
const labelStyle: CSSProperties = { fontSize: 13, color: "#666" };

export default function ChildDailyPanel({ childId }: Props) {
  const [from, setFrom] = useState<string>(() => daysAgo(7));
  const [to, setTo] = useState<string>(() => todayStr());
  const [block, setBlock] = useState<string>(""); // "" = 全部
  const [tag, setTag] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [entries, setEntries] = useState<DailyEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedKey, setSelectedKey] = useState("");

  // 条目按日期倒序已由服务端 ORDER BY date DESC 保证；此处保持，并预置选中第一条。
  const selected = useMemo(
    () => entries.find((e) => entryKey(e) === selectedKey) || null,
    [entries, selectedKey]
  );

  /** 组装筛选条件；tag/title 空白即忽略。 */
  function buildFilters(): { block?: string; tag?: string; title?: string } {
    const f: { block?: string; tag?: string; title?: string } = {};
    if (block) f.block = block;
    if (tag.trim()) f.tag = tag.trim();
    if (title.trim()) f.title = title.trim();
    return f;
  }

  const load = useCallback(
    (f: string, t: string, filters?: { block?: string; tag?: string; title?: string }) => {
      setLoading(true);
      setError("");
      setEntries([]);
      setSelectedKey("");
      window.api
        .parentChildDaily(childId, f, t, filters)
        .then((r: any) => {
          if (r?.success) {
            const list: DailyEntry[] = r.entries ?? [];
            setEntries(list);
            if (list.length > 0) setSelectedKey(entryKey(list[0]));
          } else {
            setError(r?.error || "加载失败");
          }
        })
        .catch((e: any) => setError(e?.message || "加载失败"))
        .finally(() => setLoading(false));
    },
    [childId]
  );

  /** 进入面板 / 切换孩子：重置筛选并默认加载最近 7 天。 */
  useEffect(() => {
    setBlock("");
    setTag("");
    setTitle("");
    setFrom(daysAgo(7));
    setTo(todayStr());
    load(daysAgo(7), todayStr(), {});
  }, [load]);

  /** 生效日期范围（防 from>to：交换保证恒有结果）。 */
  function effectiveRange(): [string, string] {
    if (!from || !to) return [from, to];
    return from > to ? [to, from] : [from, to];
  }

  /** 点击「查询」：应用日期 + 分类 + 标签 + 标题。 */
  function applyQuery() {
    const [f, t] = effectiveRange();
    if (!f || !t) return;
    setFrom(f);
    setTo(t);
    load(f, t, buildFilters());
  }

  /** 分类下拉变化：即时按当前日期+其他筛选重查。 */
  function onBlockChange(b: string) {
    const [f, t] = effectiveRange();
    setBlock(b);
    if (f && t) load(f, t, { ...buildFilters(), block: b || undefined });
  }

  /** 最近 7 天：重置范围 + 清空所有筛选。 */
  function resetRecent7() {
    setFrom(daysAgo(7));
    setTo(todayStr());
    setBlock("");
    setTag("");
    setTitle("");
    load(daysAgo(7), todayStr(), {});
  }

  /** 当前数据里出现过的标签（供标签下拉联想）。 */
  const knownTags = useMemo(() => {
    const s = new Set<string>();
    for (const e of entries) for (const tg of e.tags.split(/[,，]/)) { const x = tg.trim(); if (x) s.add(x); }
    return [...s].sort();
  }, [entries]);

  // 按日期分组（服务端已倒序），组内保持 block/title 顺序。
  const byDate: Array<{ date: string; items: DailyEntry[] }> = [];
  for (const e of entries) {
    const g = byDate[byDate.length - 1];
    if (g && g.date === e.date) g.items.push(e);
    else byDate.push({ date: e.date, items: [e] });
  }

  const totalCount = entries.length;
  const hasActiveFilter = Boolean(block || tag.trim() || title.trim());

  return (
    <div>
      {/* 顶部筛选栏 */}
      <div
        style={{
          display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
          marginBottom: 12, padding: "10px 12px",
          background: "#fff", border: "1px solid #eee", borderRadius: 8,
        }}
      >
        <span style={labelStyle}>日期：</span>
        <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} style={inputStyle} />
        <span style={{ color: "#aaa" }}>至</span>
        <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} style={inputStyle} />

        <span style={{ ...labelStyle, marginLeft: 6 }}>分类：</span>
        <select value={block} onChange={(e) => onBlockChange(e.target.value)} style={inputStyle}>
          <option value="">全部</option>
          {BLOCK_OPTIONS.map((b) => (
            <option key={b} value={b}>{b}</option>
          ))}
        </select>

        <span style={{ ...labelStyle, marginLeft: 6 }}>标签：</span>
        <input
          list="child-daily-tags"
          value={tag}
          placeholder="如 诚实 / 亲情"
          onChange={(e) => setTag(e.target.value)}
          style={{ ...inputStyle, width: 110 }}
        />
        <datalist id="child-daily-tags">
          {knownTags.map((tg) => (
            <option key={tg} value={tg} />
          ))}
        </datalist>

        <span style={{ ...labelStyle, marginLeft: 6 }}>标题：</span>
        <input
          value={title}
          placeholder="标题模糊搜索"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") applyQuery(); }}
          style={{ ...inputStyle, width: 150 }}
        />

        <button
          onClick={applyQuery}
          style={{
            padding: "6px 14px", borderRadius: 6, border: "none",
            background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer",
          }}
        >
          查询
        </button>
        <button
          onClick={resetRecent7}
          style={{
            padding: "6px 12px", borderRadius: 6, border: "1px solid #ddd",
            background: "#fff", color: "#555", fontSize: 12, cursor: "pointer",
          }}
        >
          最近 7 天
        </button>
        {hasActiveFilter && (
          <span style={{ fontSize: 12, color: "#888" }}>
            已筛选：{block ? `分类 ${block}` : ""}{block && tag.trim() ? " · " : ""}{tag.trim() ? `标签 #${tag.trim()}` : ""}{(block || tag.trim()) && title.trim() ? " · " : ""}{title.trim() ? `标题含“${title.trim()}”` : ""}（共 {totalCount} 条）
          </span>
        )}
      </div>

      {error && <div style={{ color: "#b33", fontSize: 12, marginBottom: 10 }}>⚠️ {error}</div>}

      {/* 两栏：左=条目列表 ｜ 右=选中条目内容 */}
      <div style={{ display: "flex", gap: 16, alignItems: "flex-start", minWidth: 0 }}>
        {/* 左列：按日期折叠的条目 */}
        <div
          style={{
            width: 300, minWidth: 0, flexShrink: 0,
            borderRight: "1px solid #eee", paddingRight: 10, maxHeight: "72vh", overflowY: "auto",
          }}
        >
          {loading ? (
            <div className="placeholder" style={{ fontSize: 12, padding: "12px 0", color: "#999" }}>
              ⏳ 加载中…
            </div>
          ) : byDate.length === 0 ? (
            <p style={{ color: "#888", fontSize: 12, padding: "12px 0" }}>
              {hasActiveFilter ? "（无符合条件的记录，试试放宽筛选）" : "（该范围暂无每日记录）"}
            </p>
          ) : (
            byDate.map((g) => (
              <div key={g.date} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#5a67d8", marginBottom: 4 }}>
                  {fmtLongDate(g.date)}（{g.items.length}）
                </div>
                {g.items.map((e) => {
                  const k = entryKey(e);
                  const act = k === selectedKey;
                  const c = BLOCK_COLORS[e.block] || { bg: "#f0f0f0", fg: "#666" };
                  return (
                    <div
                      key={k}
                      onClick={() => setSelectedKey(k)}
                      style={{
                        padding: "7px 9px", borderRadius: 8, marginBottom: 3, cursor: "pointer",
                        background: act ? "#f0f4ff" : "#fff",
                        border: `1px solid ${act ? "#c3d2f5" : "#f0f0f0"}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                        <span
                          style={{
                            fontSize: 10, flexShrink: 0, borderRadius: 4, padding: "0 5px",
                            color: c.fg, background: c.bg,
                          }}
                        >
                          {e.block}
                        </span>
                      </div>
                      <div
                        style={{
                          fontSize: 12, fontWeight: 600, marginTop: 3, color: "#333",
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}
                      >
                        {e.title}
                      </div>
                      {e.tags ? (
                        <div
                          style={{
                            fontSize: 10, color: "#999", marginTop: 2,
                            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          }}
                        >
                          #{e.tags.split(/[,，]/).filter(Boolean).join(" #")}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* 右栏：选中条目完整原文（markdown 渲染，与聊天气泡一致） */}
        <div style={{ flex: 1, minWidth: 0, borderLeft: "1px solid #eee", paddingLeft: 14 }}>
          {loading ? (
            <div className="placeholder" style={{ padding: "20px 0", color: "#999", fontSize: 13 }}>
              ⏳ 加载中…
            </div>
          ) : !selected ? (
            <div className="placeholder" style={{ padding: "20px 0", color: "#999", fontSize: 13 }}>
              {byDate.length === 0
                ? (hasActiveFilter ? "没有符合当前筛选条件的记录" : "该日期范围内没有每日记录")
                : "（请选择左侧一条记录查看原文）"}
            </div>
          ) : (
            <div>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "#222" }}>
                  {selected.title}
                  <span
                    style={{
                      marginLeft: 8, fontSize: 11, fontWeight: 500, borderRadius: 4, padding: "1px 6px",
                      color: (BLOCK_COLORS[selected.block] || {}).fg || "#666",
                      background: (BLOCK_COLORS[selected.block] || {}).bg || "#f0f0f0",
                    }}
                  >
                    {selected.block}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#999", marginTop: 3 }}>{fmtLongDate(selected.date)}</div>
              </div>
              <div className="markdown-body" style={{ maxHeight: "62vh", overflowY: "auto", paddingRight: 4 }}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.raw || ""}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

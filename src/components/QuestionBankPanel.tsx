import { useState, useEffect } from "react";

/**
 * 家长「题库」（ISSUE-132 重构）：
 * - 维度查询：主题 → 课程 → 知识点 级联筛选（选项来自 facets 接口全量树；题目按 contexts 客户端过滤）+ 原关键字搜索；
 * - 管理：新建（可在某课某知识点下建、也可不关联直接建）、编辑、删除、挂载增删。
 * 数据链路：渲染层经 window.api 的 assess 系列方法 → /api/v1/assess/*（electron 主进程与 web shim 同签名）。
 */
const BEHAVIOR_LABEL: Record<string, string> = {
  speech_recite: "背诵评测",
  speech_read: "朗读跟读",
  generic: "口述主观题",
};

function fmtScoreLines(scoring: string | null): string[] {
  if (!scoring) return [];
  try {
    const j = JSON.parse(scoring);
    const out: string[] = [];
    if (Array.isArray(j?.dims)) {
      for (const d of j.dims) {
        out.push(`- ${d?.dim || ""}（${d?.score ?? "?"}分）：${d?.points || ""}${d?.note ? `（${d.note}）` : ""}`);
      }
    }
    if (Array.isArray(j?.special) && j.special.length) out.push(`⚠ ${j.special.join("；")}`);
    return out;
  } catch {
    return [scoring];
  }
}
/** 选择题选项（sel.options 可为空/未定义）：[] = 非选择题 */
function fmtOpts(sel: any): Array<{ key: string; text: string }> {
  return Array.isArray(sel?.options) ? sel.options : [];
}
function fmtDT(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Row {
  id: string;
  stem: string;
  answer: string;
  scoring: string | null;
  pointMax: number;
  behavior: string;
  note: string;
  knowledgeSummary: string;
  contexts: Array<{ topic: string; course: string; knowledgePoint?: string; courseUuid?: string; knowledgePointId?: string }>;
}
interface RecRow {
  childId: string;
  childName: string;
  attemptId: string | null;
  submittedAt: string | null;
  pointGot: number | null;
  pointMax: number | null;
  correct: boolean;
  aiComment: string;
  neverAssessed?: boolean;
}
interface Facets {
  topics: Array<{ name: string; topicKey: string }>;
  courses: Array<{ topic: string; title: string; uuid: string }>;
  knowledgePoints: Array<{ id: string; courseUuid: string; name: string; detail: string }>;
}
/** 挂载选择（级联）：courseUuid 必选；kpId 与「新建知识点名」二选一 */
interface MountSel {
  topic: string;
  courseUuid: string;
  kpId: string;
  isNewKp: boolean;
  newKpName: string;
  newKpDetail: string;
}
const EMPTY_MOUNT: MountSel = { topic: "", courseUuid: "", kpId: "", isNewKp: false, newKpName: "", newKpDetail: "" };

const inputStyle = { padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", fontSize: 12.5, boxSizing: "border-box" as const };

function hasMount(m: MountSel): boolean {
  return !!m.courseUuid && (m.isNewKp ? !!m.newKpName.trim() : !!m.kpId);
}

/** 挂载级联选择器：主题 → 课程 → 知识点（或输入新知识点名）。 */
function MountPicker({
  facets,
  sel,
  onChange,
}: {
  facets: Facets;
  sel: MountSel;
  onChange: (m: MountSel) => void;
}) {
  const courses = facets.courses.filter((c) => c.topic === sel.topic);
  const kps = facets.knowledgePoints.filter((k) => k.courseUuid === sel.courseUuid);
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
      <select
        value={sel.topic}
        onChange={(e) => onChange({ ...EMPTY_MOUNT, topic: e.target.value })}
        style={{ ...inputStyle, minWidth: 120 }}
      >
        <option value="">选主题…</option>
        {facets.topics.map((t) => (
          <option key={t.name} value={t.name}>
            {t.name}
          </option>
        ))}
      </select>
      <select
        value={sel.courseUuid}
        disabled={!sel.topic}
        onChange={(e) => onChange({ ...sel, courseUuid: e.target.value, kpId: "", isNewKp: false, newKpName: "", newKpDetail: "" })}
        style={{ ...inputStyle, minWidth: 150 }}
      >
        <option value="">选课程…</option>
        {courses.map((c) => (
          <option key={c.uuid} value={c.uuid}>
            {c.title}
          </option>
        ))}
      </select>
      <select
        value={sel.isNewKp ? "__new__" : sel.kpId}
        disabled={!sel.courseUuid}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "__new__") onChange({ ...sel, isNewKp: true, kpId: "", newKpName: "" });
          else onChange({ ...sel, isNewKp: false, kpId: v, newKpName: "", newKpDetail: "" });
        }}
        style={{ ...inputStyle, minWidth: 150 }}
      >
        <option value="">选知识点…</option>
        {kps.map((k) => (
          <option key={k.id} value={k.id}>
            {k.name}
          </option>
        ))}
        <option value="__new__">＋ 新知识点…</option>
      </select>
      {sel.isNewKp && (
        <input
          value={sel.newKpName}
          onChange={(e) => onChange({ ...sel, newKpName: e.target.value })}
          placeholder="新知识点名称（必填）"
          style={{ ...inputStyle, width: 160 }}
        />
      )}
      {sel.isNewKp && (
        <input
          value={sel.newKpDetail}
          onChange={(e) => onChange({ ...sel, newKpDetail: e.target.value })}
          placeholder="知识点详情（选填）"
          style={{ ...inputStyle, width: 200 }}
        />
      )}
    </div>
  );
}

/** 题目编辑表单（新建/编辑共用；编辑模式不改挂载——挂载在详情页单独管理）。 */
function QuestionEditor({
  initial,
  facets,
  initialMount,
  onCancel,
  onSaved,
}: {
  initial: Row | null;
  facets: Facets;
  /** 新建时的预选挂载（来自当前筛选上下文） */
  initialMount: MountSel;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [stem, setStem] = useState(initial?.stem || "");
  const [answer, setAnswer] = useState(initial?.answer || "");
  const [scoring, setScoring] = useState(initial?.scoring || "");
  const [pointMax, setPointMax] = useState(String(initial?.pointMax ?? 10));
  const [behavior, setBehavior] = useState(initial?.behavior || "generic");
  const [note, setNote] = useState(initial?.note || "");
  const [knowledgeSummary, setKnowledgeSummary] = useState(initial?.knowledgeSummary || "");
  const [isChoice, setIsChoice] = useState(fmtOpts(initial).length > 0);
  const [opts, setOpts] = useState<Array<{ key: string; text: string }>>(
    fmtOpts(initial).length ? fmtOpts(initial) : [{ key: "A", text: "" }]
  );
  const [mount, setMount] = useState<MountSel>(initialMount);
  const [saving, setSaving] = useState(false);
  const isSpeech = behavior === "speech_recite" || behavior === "speech_read";
  const editing = !!initial;

  async function save() {
    if (!stem.trim()) return alert("请填写题干");
    if (!answer.trim()) return alert(isSpeech ? "请填写标准原文（评测 refText）" : "请填写参考答案");
    setSaving(true);
    try {
      const api = window.api as any;
      const payload: any = {
        stem: stem.trim(),
        answer: answer.trim(),
        scoring: scoring.trim() || null,
        pointMax: Math.max(1, Number(pointMax) || 10),
        behavior,
        note: note.trim(),
        knowledgeSummary: knowledgeSummary.trim(),
        options: isChoice ? opts.filter((o) => o.text.trim()).map((o, i) => ({ key: o.key || String.fromCharCode(65 + i), text: o.text.trim() })) : [],
      };
      if (editing) payload.questionId = initial!.id;
      const r = await api.assessQuestionSave(payload);
      if (!r?.success) throw new Error(r?.error || "保存失败");
      const qid = editing ? initial!.id : String(r.data?.id || "");
      if (!editing && hasMount(mount)) {
        const link: any = { questionId: qid, courseId: mount.courseUuid };
        if (mount.isNewKp) {
          link.knowledgePoint = mount.newKpName.trim();
          if (mount.newKpDetail.trim()) link.knowledgePointDetail = mount.newKpDetail.trim();
        } else link.knowledgePointId = mount.kpId;
        const lr = await api.assessQuestionLink(link);
        if (!lr?.success) throw new Error(`题目已保存，但挂载失败：${lr?.error || "未知错误"}`);
      }
      onSaved();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ border: "1px solid #d9def0", background: "#f8f9ff", borderRadius: 10, padding: 12, marginBottom: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>{editing ? "✏️ 编辑题目" : "➕ 新建题目"}</div>

      <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#6b7686" }}>题型：</label>
        <select value={behavior} onChange={(e) => setBehavior(e.target.value)} style={{ ...inputStyle, minWidth: 140 }}>
          {Object.entries(BEHAVIOR_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, color: "#6b7686" }}>分值：</label>
        <input value={pointMax} onChange={(e) => setPointMax(e.target.value)} style={{ ...inputStyle, width: 56 }} />
        <label style={{ fontSize: 12, color: "#6b7686", display: "flex", gap: 4, alignItems: "center" }}>
          <input type="checkbox" checked={isChoice} onChange={(e) => setIsChoice(e.target.checked)} disabled={isSpeech} />
          选择题（提供选项，口头作答）
        </label>
      </div>

      <textarea
        value={stem}
        onChange={(e) => setStem(e.target.value)}
        placeholder="题干（必填）"
        rows={2}
        style={{ ...inputStyle, width: "100%", marginBottom: 6 }}
      />
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder={isSpeech ? "标准原文（背诵/朗读的评测原文，必填）" : "参考答案（必填）"}
        rows={2}
        style={{ ...inputStyle, width: "100%", marginBottom: 6 }}
      />
      {isChoice && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>选项（至少两项；孩子看选项口头报答案）：</div>
          {opts.map((o, i) => (
            <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center" }}>
              <input
                value={o.key}
                onChange={(e) => setOpts(opts.map((x, xi) => (xi === i ? { ...x, key: e.target.value } : x)))}
                style={{ ...inputStyle, width: 44 }}
              />
              <input
                value={o.text}
                onChange={(e) => setOpts(opts.map((x, xi) => (xi === i ? { ...x, text: e.target.value } : x)))}
                placeholder={`选项 ${o.key || i + 1} 内容`}
                style={{ ...inputStyle, flex: 1 }}
              />
              <button onClick={() => setOpts(opts.filter((_, xi) => xi !== i))} style={inputStyle} disabled={opts.length <= 2}>
                ✕
              </button>
            </div>
          ))}
          <button onClick={() => setOpts([...opts, { key: String.fromCharCode(65 + opts.length), text: "" }])} style={inputStyle}>
            ＋ 加一个选项
          </button>
        </div>
      )}
      {!isSpeech && (
        <textarea
          value={scoring}
          onChange={(e) => setScoring(e.target.value)}
          placeholder="评分标准（选填，自由文本或 JSON）"
          rows={2}
          style={{ ...inputStyle, width: "100%", marginBottom: 6 }}
        />
      )}
      {isSpeech && (
        <div style={{ fontSize: 12, color: "#8a93a6", marginBottom: 6 }}>
          背诵/朗读题不打分制标准：行为按发音评测引擎判分（通过线默认 90 分）。
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <input value={knowledgeSummary} onChange={(e) => setKnowledgeSummary(e.target.value)} placeholder="知识点概要（选填）" style={{ ...inputStyle, width: 220 }} />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="备注（选填）" style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
      </div>

      {!editing && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>
            关联到课程/知识点（可选——不选则建为「未挂载」题，之后可在详情页补挂）：
          </div>
          <MountPicker facets={facets} sel={mount} onChange={setMount} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={save}
          disabled={saving}
          style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: "#667eea", color: "#fff", fontSize: 13, cursor: "pointer" }}
        >
          {saving ? "保存中…" : "保存"}
        </button>
        <button onClick={onCancel} style={{ padding: "7px 14px", borderRadius: 8, border: "1px solid #ccc", background: "#fff", fontSize: 13, cursor: "pointer" }}>
          取消
        </button>
      </div>
    </div>
  );
}

export default function QuestionBankPanel() {
  const [rows, setRows] = useState<Row[]>([]);
  const [facets, setFacets] = useState<Facets>({ topics: [], courses: [], knowledgePoints: [] });
  const [loading, setLoading] = useState(true);
  const [fTopic, setFTopic] = useState("");
  const [fCourse, setFCourse] = useState("");
  const [fKp, setFKp] = useState("");
  const [filter, setFilter] = useState("");
  const [qId, setQId] = useState<string | null>(null);
  const [records, setRecords] = useState<RecRow[] | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [editor, setEditor] = useState<null | { mode: "create" } | { mode: "edit"; q: Row }>(null);
  const [addMount, setAddMount] = useState<MountSel>(EMPTY_MOUNT);

  async function refresh(keepSelection = true) {
    try {
      const api = window.api as any;
      const [r, f] = await Promise.all([api.assessQuestionList(), api.assessBankFacets()]);
      if (r?.success && Array.isArray(r.data)) setRows(r.data);
      if (f?.success && f.data) setFacets(f.data);
      if (!keepSelection) setQId(null);
    } catch {
      /* 忽略 */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function pick(q: Row) {
    setQId(q.id);
    setRecords(null);
    setAddMount(EMPTY_MOUNT);
    setRecLoading(true);
    try {
      const r: any = await window.api.assessQuestionRecords(q.id);
      if (r?.success) setRecords(r.data || []);
    } catch {
      setRecords([]);
    } finally {
      setRecLoading(false);
    }
  }

  async function removeMount(courseUuid: string | undefined, kpId: string | undefined) {
    if (!qId || !courseUuid || !kpId) return;
    if (!confirm("移除这处挂载？（题目本身保留在题库）")) return;
    const r: any = await (window.api as any).assessQuestionUnlink({ questionId: qId, courseId: courseUuid, knowledgePointId: kpId });
    if (!r?.success) return alert(r?.error || "移除失败");
    await refresh();
  }

  async function addMountNow() {
    if (!qId || !hasMount(addMount)) return;
    const link: any = { questionId: qId, courseId: addMount.courseUuid };
    if (addMount.isNewKp) {
      link.knowledgePoint = addMount.newKpName.trim();
      if (addMount.newKpDetail.trim()) link.knowledgePointDetail = addMount.newKpDetail.trim();
    } else link.knowledgePointId = addMount.kpId;
    const r: any = await (window.api as any).assessQuestionLink(link);
    if (!r?.success) return alert(r?.error || "挂载失败");
    setAddMount(EMPTY_MOUNT);
    await refresh();
  }

  async function removeQuestion(q: Row) {
    if (!confirm(`删除这道题？\n\n${String(q.stem).slice(0, 80)}\n\n将同时移除它在各课知识点下的挂载（共 ${q.contexts.length} 处）；历史考核记录不受影响。`)) return;
    const r: any = await (window.api as any).assessQuestionDelete(q.id);
    if (!r?.success) return alert(r?.error || "删除失败");
    setQId(null);
    await refresh(false);
  }

  // 维度级联过滤（contexts 客户端匹配；facets 提供全量下拉树）
  const kw = filter.trim().toLowerCase();
  const shown = rows.filter((r) => {
    if (fTopic && !r.contexts.some((c) => c.topic === fTopic)) return false;
    if (fCourse && !r.contexts.some((c) => c.topic === fTopic && c.course === fCourse)) return false;
    if (fKp && !r.contexts.some((c) => c.topic === fTopic && c.course === fCourse && (c.knowledgePoint || "") === fKp)) return false;
    if (kw) {
      const hay = [r.stem, r.answer, r.behavior, r.note || "", ...r.contexts.flatMap((c) => [c.topic, c.course, c.knowledgePoint || ""])]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  const sel = rows.find((r) => r.id === qId) || null;

  // 课程下拉选项（随主题级联）；知识点下拉选项（随课程级联，按名称聚合）
  const courseOptions = facets.courses.filter((c) => c.topic === fTopic);
  const kpOptions: string[] = [];
  for (const c of facets.courses) {
    if (fTopic && c.topic !== fTopic) continue;
    if (fCourse && c.title !== fCourse) continue;
    for (const k of facets.knowledgePoints.filter((k) => k.courseUuid === c.uuid)) {
      if (!kpOptions.includes(k.name)) kpOptions.push(k.name);
    }
  }

  // 新建预选挂载：当前筛选已定位到 知识点/课程 时自动带上
  function initialMountForCreate(): MountSel {
    const m = { ...EMPTY_MOUNT, topic: fTopic };
    const course = fCourse ? facets.courses.find((x) => x.topic === fTopic && x.title === fCourse) : undefined;
    if (course) {
      m.courseUuid = course.uuid;
      const kp = fKp ? facets.knowledgePoints.find((k) => k.courseUuid === course.uuid && k.name === fKp) : undefined;
      if (kp) m.kpId = kp.id;
    } else if (fTopic && facets.courses.filter((x) => x.topic === fTopic).length === 1) {
      m.courseUuid = facets.courses.find((x) => x.topic === fTopic)!.uuid;
    }
    return m;
  }

  const selectStyle = { ...inputStyle, minWidth: 130, maxWidth: 220 };

  return (
    <div>
      <h3 style={{ marginBottom: 4 }}>📖 题库</h3>
      <p style={{ color: "#6b7686", fontSize: 13, marginTop: 0 }}>
        共 {rows.length} 道题，当前筛选显示 {shown.length} 道 · 点题目看详情与各孩子最近一次考核记录；可新建/编辑/删除
      </p>

      {/* 维度筛选栏 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
        <select
          value={fTopic}
          onChange={(e) => {
            setFTopic(e.target.value);
            setFCourse("");
            setFKp("");
          }}
          style={selectStyle}
        >
          <option value="">全部主题</option>
          {facets.topics.map((t) => (
            <option key={t.name} value={t.name}>
              {t.name}
            </option>
          ))}
        </select>
        <select
          value={fCourse}
          disabled={!fTopic}
          onChange={(e) => {
            setFCourse(e.target.value);
            setFKp("");
          }}
          style={selectStyle}
        >
          <option value="">全部课程</option>
          {courseOptions.map((c) => (
            <option key={c.uuid} value={c.title}>
              {c.title}
            </option>
          ))}
        </select>
        <select value={fKp} disabled={!fCourse} onChange={(e) => setFKp(e.target.value)} style={selectStyle}>
          <option value="">全部知识点</option>
          {kpOptions.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="搜索题干 / 答案 / 备注…"
          style={{ ...inputStyle, flex: 1, minWidth: 160 }}
        />
        {(fTopic || fCourse || fKp || filter) && (
          <button
            onClick={() => {
              setFTopic("");
              setFCourse("");
              setFKp("");
              setFilter("");
            }}
            style={{ ...inputStyle, cursor: "pointer" }}
          >
            清空筛选
          </button>
        )}
        <button
          onClick={() => setEditor({ mode: "create" })}
          style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 12.5, cursor: "pointer" }}
        >
          ＋ 新建题目
        </button>
      </div>

      {editor && (
        <QuestionEditor
          initial={editor.mode === "edit" ? editor.q : null}
          facets={facets}
          initialMount={editor.mode === "create" ? initialMountForCreate() : EMPTY_MOUNT}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            refresh();
          }}
        />
      )}

      {loading ? (
        <p style={{ color: "#888", fontSize: 13 }}>加载题库…</p>
      ) : shown.length === 0 ? (
        <p style={{ color: "#aaa", fontSize: 13 }}>{rows.length === 0 ? "题库还是空的，点右上「＋ 新建题目」创建第一道题" : "没有匹配的题目"}</p>
      ) : (
        <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
          <div style={{ width: "42%", minWidth: 280, border: "1px solid #eee", borderRadius: 8, padding: 6, maxHeight: 560, overflow: "auto", boxSizing: "border-box" }}>
            {shown.map((q, i) => (
              <div
                key={q.id}
                onClick={() => pick(q)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 6,
                  cursor: "pointer",
                  border: qId === q.id ? "1px solid #667eea" : "1px solid transparent",
                  background: qId === q.id ? "#f0f4ff" : "transparent",
                  fontSize: 12.5,
                  lineHeight: 1.45,
                }}
              >
                <div style={{ color: "#333" }}>
                  <b>{i + 1}.</b> {String(q.stem).slice(0, 66)}
                  {String(q.stem).length > 66 ? "…" : ""}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 4, fontSize: 11, color: "#9aa3b2", flexWrap: "wrap" }}>
                  <span style={{ color: q.behavior === "generic" ? "#556" : "#3b4cca" }}>{BEHAVIOR_LABEL[q.behavior] || q.behavior}</span>
                  <span>{q.pointMax || 10} 分</span>
                  {q.contexts[0] ? (
                    <span>
                      {q.contexts[0].topic ? `${q.contexts[0].topic} / ` : ""}
                      {q.contexts[0].course}
                    </span>
                  ) : (
                    <span style={{ color: "#c9a227" }}>未挂载</span>
                  )}
                  {q.contexts.length > 1 && <span>等 {q.contexts.length} 处</span>}
                </div>
              </div>
            ))}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {!sel ? (
              <p style={{ color: "#999", fontSize: 12, paddingTop: 8 }}>← 选择左侧题目查看详情；也可新建题目（可挂到某课某知识点下，或不关联）</p>
            ) : (
              <div>
                <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                  <div style={{ fontSize: 14, lineHeight: 1.5, color: "#222", fontWeight: 600, marginBottom: 6, flex: 1 }}>{sel.stem}</div>
                  <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    <button
                      onClick={() => setEditor({ mode: "edit", q: sel })}
                      style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #667eea", background: "#fff", color: "#667eea", fontSize: 12, cursor: "pointer" }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => removeQuestion(sel)}
                      style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid #d66", background: "#fff", color: "#d66", fontSize: 12, cursor: "pointer" }}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: "#667eea", marginBottom: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span>
                    {BEHAVIOR_LABEL[sel.behavior] || sel.behavior} · {sel.pointMax || 10} 分
                  </span>
                  {sel.contexts.length === 0 && <span style={{ color: "#c9a227" }}>未挂载（不归属任何课程/知识点）</span>}
                  {sel.contexts.map((c, ci) => (
                    <span
                      key={ci}
                      style={{ background: "#f0f4ff", borderRadius: 6, padding: "2px 6px", display: "inline-flex", gap: 4, alignItems: "center" }}
                    >
                      {c.topic ? `${c.topic} / ` : ""}
                      {c.course}
                      {c.knowledgePoint ? `（${c.knowledgePoint}）` : ""}
                      {c.courseUuid && c.knowledgePointId && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            removeMount(c.courseUuid, c.knowledgePointId);
                          }}
                          title="移除这处挂载"
                          style={{ border: "none", background: "transparent", color: "#a66", cursor: "pointer", fontSize: 11, padding: 0 }}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  ))}
                </div>

                {/* 添加挂载 */}
                <div style={{ marginBottom: 8, border: "1px dashed #d5daea", borderRadius: 8, padding: 8 }}>
                  <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>挂载到课程/知识点：</div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                    <MountPicker facets={facets} sel={addMount} onChange={setAddMount} />
                    <button
                      onClick={addMountNow}
                      disabled={!hasMount(addMount)}
                      style={{ ...inputStyle, cursor: hasMount(addMount) ? "pointer" : "default", opacity: hasMount(addMount) ? 1 : 0.5 }}
                    >
                      添加挂载
                    </button>
                  </div>
                </div>

                {fmtOpts(sel).length ? (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>选项（选择题：孩子看选项口头作答）：</div>
                    {fmtOpts(sel).map((o, oi) => (
                      <div key={oi} style={{ fontSize: 13, background: "#f4f6fc", border: "1px solid #e3e8f3", borderRadius: 6, padding: "4px 8px", marginBottom: 3 }}>
                        <b style={{ color: "#667eea" }}>{o.key}.</b> {o.text}
                      </div>
                    ))}
                  </div>
                ) : null}
                {sel.answer ? (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: "#6b7686" }}>参考答案{sel.behavior !== "generic" ? "（评测原文）" : ""}：</div>
                    <div style={{ fontSize: 13, color: "#2f8a52", background: "#f4faf6", padding: "6px 10px", borderRadius: 6, whiteSpace: "pre-wrap" }}>{sel.answer}</div>
                  </div>
                ) : null}
                {fmtScoreLines(sel.scoring).length > 0 && (
                  <div style={{ marginBottom: 6 }}>
                    <div style={{ fontSize: 12, color: "#6b7686" }}>评分标准：</div>
                    <div style={{ fontSize: 12, background: "#faf8f4", padding: "6px 10px", borderRadius: 6, whiteSpace: "pre-wrap", lineHeight: 1.7 }}>
                      {fmtScoreLines(sel.scoring).join("\n")}
                    </div>
                  </div>
                )}
                {sel.note ? (
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <b style={{ color: "#6b7686" }}>备注：</b>
                    <span style={{ color: "#556" }}>{sel.note}</span>
                  </div>
                ) : null}
                {sel.knowledgeSummary ? (
                  <div style={{ fontSize: 12, marginBottom: 4 }}>
                    <b style={{ color: "#6b7686" }}>知识点概要：</b>
                    <span style={{ color: "#556" }}>{sel.knowledgeSummary}</span>
                  </div>
                ) : null}

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: 12, color: "#6b7686", marginBottom: 4 }}>各孩子考核记录（最近一次）</div>
                  {recLoading ? (
                    <span style={{ color: "#999", fontSize: 12 }}>加载中…</span>
                  ) : records === null ? null : (
                    <div style={{ borderTop: "1px solid #f0f0f0" }}>
                      {records.length === 0 ? (
                        <span style={{ color: "#aaa", fontSize: 12 }}>暂无记录（这道题还没被考过）</span>
                      ) : (
                        records.map((r: RecRow) => (
                          <div key={r.childId} style={{ padding: "8px 2px", borderBottom: "1px solid #f3f3f3", fontSize: 12, lineHeight: 1.55 }}>
                            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                              <b>{r.childName || "孩子"}</b>
                              {r.neverAssessed ? (
                                <span style={{ color: "#aaa", fontSize: 11 }}>还没考过</span>
                              ) : (
                                <>
                                  <span style={{ color: "#9aa3b2", fontSize: 11 }}>{fmtDT(r.submittedAt)}</span>
                                  <span style={{ fontWeight: 700, color: r.correct ? "#2f8a52" : "#b33" }}>
                                    {r.pointGot != null ? `${r.pointGot}/${r.pointMax ?? "?"}` : "—"} {r.correct ? "✓ 对" : "✗ 错"}
                                  </span>
                                </>
                              )}
                            </div>
                            {!r.neverAssessed && r.aiComment ? <div style={{ color: "#556", marginTop: 2 }}>{r.aiComment}</div> : null}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

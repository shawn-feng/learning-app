import { useEffect, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ArrowLeft, FolderOpen, Plus, ChevronUp, ChevronDown, Trash2, Pencil, Upload, X, Tag } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import MaterialManagerModal from "./MaterialManagerModal";
import IconButton from "./IconButton";

interface ParentTopic {
  name: string;
  topicKey: string;
  method: string;
  learned: number;
  total: number;
  htmlCount: number;
  rules: Record<string, string>;
}

interface CourseRow {
  title: string;
  sortOrder: number;
  lessonMethod: string;
  material: string;
  sendMaterial: string;
  tags: string;
  htmlPath: string;
  teachingCopy: string;
}

type Tab = "method" | "course" | "info";

interface Props {
  topic: ParentTopic;
  initialTab?: Tab;
  onBack: () => void;
}

/**
 * 主题详情页（课程管理，两列，ISSUE-050 移除原中列 AI 对话）：
 * 左=课程列表（添加/删除/排序），右=标签内容：教学方法(method markdown 可编辑) /
 * 课程详情(名称+教学文案+发给学生的学习材料 html 渲染) / 基本信息。
 * 家长与 agent 的对话统一在家长中心右侧常驻聊天面板进行（ParentChatPanel，childId=parent）。
 */
export default function TopicDetail({ topic, initialTab = "course", onBack }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [selected, setSelected] = useState<CourseRow | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [matOpen, setMatOpen] = useState(false);

  // 标签可编辑（ISSUE-045）：选项来自父库 tags 定义表
  const [tagOptions, setTagOptions] = useState<Array<{ tag: string; dimension: string; criteria: string }>>([]);
  const [tagDraft, setTagDraft] = useState("");
  const [addValue, setAddValue] = useState("");

  // 教学文案可编辑（保存到 courses.teaching_copy）
  const [editingCopy, setEditingCopy] = useState(false);
  const [copyText, setCopyText] = useState("");

  // method 编辑器
  const [savedMethod, setSavedMethod] = useState(topic.method); // 已保存到数据库的 method（页面显示源）
  const [methodText, setMethodText] = useState(topic.method); // 编辑器草稿
  const [editingMethod, setEditingMethod] = useState(false);
  const [savingMethod, setSavingMethod] = useState(false);

  const topicDir = topic.topicKey;

  useEffect(() => {
    setEditingCopy(false);
  }, [selected]);

  useEffect(() => {
    refreshCourses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicDir]);

  // ISSUE-045：打开主题时拉取父库标签定义表作为下拉选项
  useEffect(() => {
    loadTagOptions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topicDir]);

  async function refreshCourses(keepSelection = true) {
    const r = await window.api.parentListCourses(topicDir);
    if (!r?.success) return;
    const list: CourseRow[] = r.data || [];
    setCourses(list);
    if (keepSelection && selected) {
      setSelected(list.find((c) => c.title === selected.title) || null);
    } else if (!selected && list.length) {
      setSelected(list[0]);
    }
  }

  async function addCourse() {
    const title = newTitle.trim();
    if (!title) {
      setMsg({ ok: false, text: "请输入课程名称" });
      return;
    }
    const r = await window.api.parentUpsertCourse(topicDir, { title });
    if (r?.success) {
      setMsg({ ok: true, text: `已添加课程「${title}」` });
      setNewTitle("");
      const list = await window.api.parentListCourses(topicDir);
      setCourses(list?.success ? list.data : []);
      setSelected({ title, sortOrder: 0, lessonMethod: "", material: "", sendMaterial: "", tags: "", htmlPath: "" });
    } else {
      setMsg({ ok: false, text: r?.error || "添加失败" });
    }
  }

  async function deleteCourse(c: CourseRow) {
    if (!window.confirm(`确定删除课程「${c.title}」？（共享资料文件保留）`)) return;
    const r = await window.api.parentDeleteCourse(topicDir, c.title);
    if (r?.success) {
      setMsg({ ok: true, text: `已删除「${c.title}」` });
      setSelected(null);
      await refreshCourses(false);
    } else {
      setMsg({ ok: false, text: r?.error || "删除失败" });
    }
  }

  // ==================== 标签可编辑（ISSUE-045）====================
  async function loadTagOptions() {
    try {
      const r: any = await window.api.parentGetTags();
      if (r?.success) setTagOptions(r.data || []);
    } catch {
      /* 标签选项加载失败不阻断主流程 */
    }
  }

  function currentTagList(): string[] {
    if (!selected) return [];
    return (selected.tags || "").split(",").map((t) => t.trim()).filter(Boolean);
  }

  async function saveCourseTags(tags: string[]) {
    if (!selected) return;
    const joined = tags.join(",");
    const r: any = await window.api.parentUpsertCourse(topicDir, { title: selected.title, tags: joined });
    if (r?.success) {
      const updated = { ...selected, tags: joined };
      setSelected(updated);
      setCourses((prev) => prev.map((c) => (c.title === updated.title ? updated : c)));
      setMsg({ ok: true, text: "✓ 标签已保存" });
    } else {
      setMsg({ ok: false, text: r?.error || "标签保存失败" });
    }
  }

  function removeTag(t: string) {
    saveCourseTags(currentTagList().filter((x) => x !== t));
  }

  function addSelectedTag() {
    if (!addValue) return;
    saveCourseTags([...currentTagList(), addValue]);
    setAddValue("");
  }

  async function addNewTag() {
    const t = tagDraft.trim();
    if (!t) return;
    try {
      await window.api.parentUpsertTag(t);
    } catch {
      /* 写回定义表失败不阻断，仍可应用到本课 */
    }
    await loadTagOptions();
    const list = currentTagList();
    if (!list.includes(t)) saveCourseTags([...list, t]);
    setTagDraft("");
  }

  // 教学文案：编辑保存到 courses.teaching_copy（upsert 为部分更新，传 title + teachingCopy）
  async function saveCopy() {
    if (!selected) return;
    if (!copyText.trim()) {
      setMsg({ ok: false, text: "教学文案为空，未保存（可重新填写后保存）" });
      return;
    }
    const r: any = await window.api.parentUpsertCourse(topicDir, { title: selected.title, teachingCopy: copyText });
    if (r?.success) {
      const updated = { ...selected, teachingCopy: copyText };
      setSelected(updated);
      setCourses((prev) => prev.map((c) => (c.title === updated.title ? updated : c)));
      setMsg({ ok: true, text: "✓ 教学文案已保存" });
      setEditingCopy(false);
    } else {
      setMsg({ ok: false, text: r?.error || "保存失败" });
    }
  }


  async function moveCourse(c: CourseRow, direction: -1 | 1) {
    const r = await window.api.parentMoveCourse(topicDir, c.title, direction);
    if (r?.success && r.data) {
      await refreshCourses();
    } else {
      setMsg({ ok: false, text: "已到边界或移动失败" });
    }
  }

  async function saveMethod() {
    setSavingMethod(true);
    setMsg(null);
    try {
      const r = await window.api.parentUpsertTopic({ name: topic.name, topicKey: topicDir, method: methodText });
      if (r?.success) {
        setSavedMethod(methodText); // 立即更新页面显示（markdown 渲染源）
        setMethodText(methodText);
        setEditingMethod(false);
        setMsg({ ok: true, text: "✓ 教学方法已保存" });
      } else {
        setMsg({ ok: false, text: `✗ 保存失败：${r?.error || "未知错误"}` });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: `✗ 保存失败：${String(e?.message || e)}` });
    } finally {
      setSavingMethod(false);
    }
  }

  async function uploadMaterials() {
    const r = await window.api.parentUploadMaterial(topicDir);
    if (!r?.success) {
      setMsg({ ok: false, text: r?.error || "上传失败" });
      return;
    }
    const files: { name: string; relPath: string }[] = r.data?.files || [];
    if (!files.length) return;
    let linked = 0;
    for (const f of files) {
      if (!/\.(html|htm)$/i.test(f.relPath)) continue;
      const title = f.name.replace(/\.[^.]+$/, "");
      const hit = courses.find((c) => c.title === title) || (selected?.title === title ? selected : null);
      if (hit) {
        await window.api.parentUpsertCourse(topicDir, { ...hit, htmlPath: f.relPath });
        linked++;
      }
    }
    setMsg({ ok: true, text: `已上传 ${files.length} 个文件${linked ? `，关联 ${linked} 门课程资料` : ""}` });
    await refreshCourses();
  }

  return (
    // ISSUE-037 续：外层用 flex:1 + min-height:0 + overflow:hidden 撑满 dashboard-main
    //（现在 display:flex column）并在内部滚动，替代此前的 calc(100vh - 120px) 估算高度
    //（估算偏差 / 消息增多会把整个页面拉长，聊天区无法独立滚动）。
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      {/* 头部：返回 + 主题名 + 标签切换 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <IconButton
          icon={ArrowLeft}
          title="返回主题列表"
          onClick={onBack}
        />
        <div style={{ fontSize: 16, fontWeight: 700 }}>
          {topic.name}
          <span style={{ color: "#aaa", fontWeight: 400, fontSize: 13 }}>（{topicDir} · {courses.length} 课）</span>
        </div>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
          {(
            [
              ["info", "基本信息"],
              ["__mat__", "学习资料管理"],
              ["method", "教学方法"],
              ["course", "课程详情"],
            ] as Array<[string, string]>
          ).map(([k, label]) =>
            k === "__mat__" ? (
              <button
                key={k}
                onClick={() => setMatOpen(true)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 13,
                  cursor: "pointer",
                  background: "#f0f0f0",
                  color: "#555",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <FolderOpen size={14} /> {label}
              </button>
            ) : (
              <button
                key={k}
                onClick={() => setTab(k as Tab)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 6,
                  border: "none",
                  fontSize: 13,
                  cursor: "pointer",
                  background: tab === k ? "#667eea" : "#f0f0f0",
                  color: tab === k ? "#fff" : "#555",
                }}
              >
                {label}
              </button>
            )
          )}
        </div>
      </div>

      {msg && (
        <div
          style={{
            fontSize: 12,
            padding: "6px 10px",
            borderRadius: 6,
            marginBottom: 8,
            background: msg.ok ? "#e8f7ee" : "#fdecec",
            color: msg.ok ? "#2f8a52" : "#b33",
          }}
        >
          {msg.text}
        </div>
      )}

      {/* 两列：课程列表 | 标签内容（ISSUE-050 移除原中列 AI 对话，家长对话在右侧常驻面板） */}
      <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 16 }}>
        {/* 左：课程列表 */}
        <div style={{ width: 280, display: "flex", flexDirection: "column", minWidth: 0, borderRight: "1px solid #eee", paddingRight: 8 }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addCourse()}
              placeholder="新课程名称"
              style={{ flex: 1, padding: "6px 8px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13, minWidth: 0 }}
            />
            <button
              onClick={addCourse}
              style={{ padding: "6px 12px", borderRadius: 6, border: "none", background: "#667eea", color: "#fff", fontSize: 12, cursor: "pointer", whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 4 }}
            >
              <Plus size={16} /> 添加
            </button>
          </div>
          <div style={{ overflowY: "auto", flex: 1 }}>
            {courses.length === 0 && <p style={{ color: "#888", fontSize: 12, padding: 12 }}>暂无课程，输入名称添加，或让 AI 协助创建。</p>}
            {courses.map((c, i) => (
              <div
                key={c.title}
                onClick={() => setSelected(c)}
                style={{
                  padding: "8px 10px",
                  borderRadius: 8,
                  marginBottom: 4,
                  cursor: "pointer",
                  background: selected?.title === c.title ? "#f0f4ff" : "#fff",
                  border: "1px solid #f0f0f0",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "#bbb", width: 16 }}>{i + 1}</span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
                </div>
                <div style={{ display: "flex", gap: 4, marginTop: 4, justifyContent: "flex-end" }}>
                  <MiniBtn icon={ChevronUp} title="上移" disabled={i === 0} onClick={(e) => { e.stopPropagation(); moveCourse(c, -1); }} />
                  <MiniBtn icon={ChevronDown} title="下移" disabled={i === courses.length - 1} onClick={(e) => { e.stopPropagation(); moveCourse(c, 1); }} />
                  <MiniBtn icon={Trash2} title="删除" danger onClick={(e) => { e.stopPropagation(); deleteCourse(c); }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 右：标签内容（占满剩余宽度） */}
        <div style={{ flex: 1, minWidth: 0, overflowY: "auto", borderLeft: "1px solid #eee", paddingLeft: 12 }}>
          {tab === "method" && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 700 }}>📖 教学方法</div>
                {!editingMethod ? (
                  <IconButton icon={Pencil} title="编辑" onClick={() => setEditingMethod(true)} />
                ) : (
                  <div style={{ display: "flex", gap: 6 }}>
                    <button onClick={() => { setMethodText(savedMethod); setEditingMethod(false); }} style={smallBtn}>取消</button>
                    <button onClick={saveMethod} disabled={savingMethod} style={{ ...smallBtn, background: "#667eea", color: "#fff" }}>
                      {savingMethod ? "保存中…" : "保存"}
                    </button>
                  </div>
                )}
              </div>
              {editingMethod ? (
                <textarea
                  value={methodText}
                  onChange={(e) => setMethodText(e.target.value)}
                  style={{ width: "100%", minHeight: "55vh", padding: 10, borderRadius: 8, border: "1px solid #ddd", fontSize: 13, fontFamily: "monospace", boxSizing: "border-box", resize: "vertical" }}
                />
              ) : (
                <div className="markdown-body" style={{ border: "1px solid #f0f0f0", borderRadius: 8, padding: "10px 14px", minHeight: 200 }}>
                  {savedMethod ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{savedMethod}</ReactMarkdown> : <span style={{ color: "#aaa" }}>（暂无教学方法，点「编辑」填写）</span>}
                </div>
              )}
            </div>
          )}

          {tab === "course" && (
            <div>
              {!selected ? (
                <p style={{ color: "#888", fontSize: 13 }}>请先在左侧选择或添加一门课程。</p>
              ) : (
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{selected.title}</div>
                    <IconButton icon={Upload} title="上传资料" onClick={uploadMaterials} />
                  </div>
                  <Section label="标签">
                    <div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
                        {currentTagList().length === 0 && <span style={{ color: "#aaa" }}>（无）</span>}
                        {currentTagList().map((t) => (
                          <span
                            key={t}
                            style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#eef2ff", color: "#3b4cca", borderRadius: 12, padding: "2px 8px", fontSize: 12 }}
                          >
                            {t}
                            <button
                              onClick={() => removeTag(t)}
                              title="移除"
                              style={{ border: "none", background: "transparent", color: "#3b4cca", cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 0, display: "inline-flex" }}
                            >
                              <X size={14} />
                            </button>
                          </span>
                        ))}
                      </div>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                        <select
                          value={addValue}
                          onChange={(e) => setAddValue(e.target.value)}
                          style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #ddd", fontSize: 12, maxWidth: 160 }}
                        >
                          <option value="">+ 从词库添加…</option>
                          {tagOptions
                            .map((o) => o.tag)
                            .filter((t) => !currentTagList().includes(t))
                            .map((t) => {
                              const def = tagOptions.find((o) => o.tag === t);
                              return (
                                <option key={t} value={t}>
                                  {def ? `${t}（${def.dimension}）` : t}
                                </option>
                              );
                            })}
                        </select>
                        <IconButton icon={Plus} title="添加" onClick={addSelectedTag} disabled={!addValue} />
                        <input
                          value={tagDraft}
                          onChange={(e) => setTagDraft(e.target.value)}
                          placeholder="自定义新标签"
                          style={{ padding: "4px 6px", borderRadius: 6, border: "1px solid #ddd", fontSize: 12, width: 110 }}
                        />
                        <IconButton icon={Tag} title="新增标签" onClick={addNewTag} disabled={!tagDraft.trim()} />
                      </div>
                    </div>
                  </Section>
                  <Section label="教学文案">
                    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
                      {editingCopy ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button onClick={() => { setCopyText(selected.teachingCopy || ""); setEditingCopy(false); }} style={smallBtn}>取消</button>
                          <button onClick={saveCopy} style={{ ...smallBtn, background: "#667eea", color: "#fff" }}>保存</button>
                        </div>
                      ) : (
                        <IconButton icon={Pencil} title="编辑" onClick={() => { setCopyText(selected.teachingCopy || ""); setEditingCopy(true); }} />
                      )}
                    </div>
                    {editingCopy ? (
                      <textarea
                        value={copyText}
                        onChange={(e) => setCopyText(e.target.value)}
                        rows={8}
                        placeholder="教学文案（Markdown 支持）…"
                        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box", resize: "vertical" }}
                      />
                    ) : selected.teachingCopy ? (
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.teachingCopy}</ReactMarkdown>
                      </div>
                    ) : (
                      <span style={{ color: "#aaa" }}>（数据库暂无教学文案；AI 可用 parent_course_save 写入，或点「编辑」填写）</span>
                    )}
                  </Section>
                  {selected.material && (
                    <Section label="教学资料说明">
                      <div className="markdown-body">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.material}</ReactMarkdown>
                      </div>
                    </Section>
                  )}
                  <Section label="发给学生的学习材料">
                    <StudentMaterial course={selected} />
                  </Section>
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <IconButton icon={Trash2} title="删除课程" danger onClick={() => deleteCourse(selected)} />
                    <IconButton icon={Upload} title="上传资料" onClick={uploadMaterials} />
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "info" && (
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>📋 基本信息</div>
              <InfoRow k="主题名" v={topic.name} />
              <InfoRow k="目录名" v={topicDir} />
              <InfoRow k="课程数" v={String(courses.length)} />
              <InfoRow k="html 资料" v={`${topic.htmlCount} 份`} />
              <InfoRow k="学习方法" v={savedMethod ? `${savedMethod.length} 字符` : "未填写"} />
              <InfoRow k="每日目标" v={topic.rules?.daily ? `${topic.rules.daily} 课` : "未设置"} />
              <InfoRow k="主题类型" v={topic.rules?.type || "未设置"} />
            </div>
          )}
        </div>
      </div>
      {matOpen && <MaterialManagerModal topicDir={topicDir} topicName={topic.name} onClose={() => setMatOpen(false)} />}
    </div>
  );
}

/** 学习材料渲染：优先 html 文件（iframe），否则 sendMaterial 是 html 片段 → iframe，否则 markdown。 */
function StudentMaterial({ course }: { course: CourseRow }) {
  const [fileHtml, setFileHtml] = useState<{ found: boolean; format: string; content: string; fileUrl: string } | null>(null);

  useEffect(() => {
    setFileHtml(null);
    if (course.htmlPath) {
      window.api.parentReadMaterial(course.htmlPath).then((r: any) => {
        if (r?.success) setFileHtml(r.data);
      });
    }
  }, [course.htmlPath]);

  const send = course.sendMaterial || "";
  const looksHtml = /<(html|body|div|h1|h2|section|p\s|style|script)[\s>]/i.test(send);

  if (fileHtml?.found && fileHtml.format === "html") {
    // 直接渲染主进程已改写好的 html：内部相对资源已被改写为 asset:// 绝对地址
    // （见 electron/lib/parent-library.ts rewriteHtmlAssetRefs），srcDoc 在 dev/prod 均能跨源加载。
    return <iframe sandbox="allow-scripts allow-same-origin" srcDoc={fileHtml.content} style={{ width: "100%", minHeight: 360, border: "1px solid #eee", borderRadius: 8, background: "#fff" }} title="学习材料" />;
  }
  if (looksHtml) {
    return <iframe sandbox="allow-scripts allow-same-origin" srcDoc={send} style={{ width: "100%", minHeight: 360, border: "1px solid #eee", borderRadius: 8, background: "#fff" }} title="学习材料" />;
  }
  if (send) {
    return (
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{send}</ReactMarkdown>
      </div>
    );
  }
  return <span style={{ color: "#aaa" }}>（未填；可上传 html 资料自动关联）</span>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#667eea", marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13, lineHeight: 1.6 }}>{children}</div>
    </div>
  );
}

function InfoRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: "flex", padding: "6px 0", borderBottom: "1px solid #f3f3f3", fontSize: 13 }}>
      <span style={{ width: 90, color: "#888" }}>{k}</span>
      <span style={{ flex: 1, wordBreak: "break-all" }}>{v}</span>
    </div>
  );
}

function MiniBtn({ icon, title, onClick, disabled, danger }: { icon: LucideIcon; title: string; onClick: (e: React.MouseEvent) => void; disabled?: boolean; danger?: boolean }) {
  return (
    <IconButton icon={icon} title={title} onClick={onClick} disabled={disabled} danger={danger} />
  );
}

const smallBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid #ddd",
  background: "#fff",
  fontSize: 12,
  cursor: "pointer",
};


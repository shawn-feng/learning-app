/**
 * 文件区网盘（ISSUE-131 P1）：家长/孩子双端共用的文件管理面板。
 *
 * - 家长模式（childId 省略）：根 = materials/ uploads/ workspaces/<pid>/ 整棵虚拟树，
 *   孩子目录在树内直接可管（决策 2）；
 * - 孩子模式（传 childId）：根 = 自己的工作区（决策 3），onClose 传入时以弹框呈现（ISSUE-026 范式）。
 *
 * 操作：新建文件夹 / 重命名 / 移动 / 删除 / 上传到当前目录 / 下载。
 * materials 区删/改/移先做 R-1 引用影响预检（fsRefs），命中引用弹确认后带 confirm:true 执行；
 * 服务端 delete/rename/move 还有一道 needsConfirm 短路兜底，两条路径都会把引用清单摆给用户。
 * uploads 区（files 通道原始件）P1 只开浏览/上传/删除/下载——改名/移动会断 `files/<id>` 引用。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, Search } from "lucide-react";

interface FsEntry {
  name: string;
  /** 人类可读标签（孩子目录=孩子名等）；展示优先，操作用 path */
  label?: string;
  path: string;
  type: "dir" | "file";
  size: number;
  mtime: string;
  fileId?: string;
}

interface RefHit {
  source: "course" | "display" | "exam_plan";
  detail: string;
}

const REF_SOURCE_LABEL: Record<string, string> = {
  course: "课程引用",
  display: "展示登记",
  exam_plan: "考核计划",
};

function formatSize(n: number): string {
  if (!n) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(iso: string): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return iso;
  }
}

function fileIcon(name: string, isDir: boolean): string {
  if (isDir) return "📁";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["html", "htm"].includes(ext)) return "🌐";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "🖼️";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) return "🔊";
  if (["mp4", "webm", "mov"].includes(ext)) return "🎬";
  if (ext === "pdf") return "📕";
  if (["md", "txt", "json", "csv"].includes(ext)) return "📄";
  return "📎";
}

const btn: React.CSSProperties = {
  border: "1px solid #d7dce5",
  background: "#fff",
  borderRadius: 8,
  padding: "5px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "#3c4658",
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#667eea", borderColor: "#667eea", color: "#fff" };
const btnDanger: React.CSSProperties = { ...btn, color: "#c0392b", borderColor: "#eec7c2" };
const btnMini: React.CSSProperties = { ...btn, padding: "3px 8px", fontSize: 11, borderRadius: 6 };
const btnIcon: React.CSSProperties = { ...btn, padding: "5px 7px", display: "inline-flex", alignItems: "center" };

type SortKey = "name" | "size" | "mtime";
type SortCol = [SortKey, string, number | undefined, "left" | "right"];
/** 表头列定义（key/标签/列宽/对齐；名称列 flex 撑满）。 */
const SORT_COLS: SortCol[] = [
  ["name", "名称", undefined, "left"],
  ["size", "大小", 76, "right"],
  ["mtime", "修改时间", 130, "left"],
];
/** 排序：目录恒在前，同区按 key 比较后乘方向（名字按中文自然序）。 */
function sortEntries(list: FsEntry[], key: SortKey, dir: 1 | -1): FsEntry[] {
  return [...list].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    let r = 0;
    if (key === "name") r = a.name.localeCompare(b.name, "zh-Hans-CN", { numeric: true });
    else if (key === "size") r = a.size - b.size;
    else r = (a.mtime || "").localeCompare(b.mtime || "");
    return r * dir;
  });
}

export default function FilesPanel({
  childId,
  onClose,
}: {
  /** 孩子上下文（根=自己工作区）；省略 = 家长模式（整棵虚拟树） */
  childId?: string;
  /** 传入则以弹框呈现（孩子端 ISSUE-026 范式） */
  onClose?: () => void;
}) {
  // 目录导航历史：stack + 当前位置（后退/前进沿栈回跳，目录点击/面包屑/向上压栈）
  const [nav, setNav] = useState<{ stack: string[]; idx: number }>({ stack: [""], idx: 0 });
  const cwd = nav.stack[nav.idx] ?? "";
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showMkdir, setShowMkdir] = useState(false);
  const [mkdirName, setMkdirName] = useState("");
  const [renameTarget, setRenameTarget] = useState<FsEntry | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [moveTarget, setMoveTarget] = useState<FsEntry | null>(null);
  const uploadRef = useRef<HTMLInputElement | null>(null);
  // 检索：null = 目录浏览模式；非 null = 检索结果模式（{q, entries, truncated}）
  const [search, setSearch] = useState<{ q: string; entries: FsEntry[]; truncated: boolean } | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [searching, setSearching] = useState(false);
  // 排序：key + 方向（表头点击切换）
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  // uploads 区整区收敛（P1）：按条目自身路径判区（检索结果可能来自任意目录）
  const readOnlyEntry = (e: FsEntry) => e.path === "uploads" || e.path.startsWith("uploads/");

  const load = useCallback(
    async (path: string) => {
      setLoading(true);
      setError("");
      try {
        const r = await window.api.fsList({ path, childId });
        if (r?.success) {
          setEntries((r.entries || []) as FsEntry[]);
        } else {
          setError(r?.error || "加载失败");
        }
      } finally {
        setLoading(false);
      }
    },
    [childId]
  );

  useEffect(() => {
    void load("");
  }, [load]);

  // 进入目录：截断「前进」分支后压栈
  const go = (path: string) => {
    setMoveTarget(null);
    setNav((n) => {
      if (n.stack[n.idx] === path) return n;
      const stack = [...n.stack.slice(0, n.idx + 1), path];
      return { stack, idx: stack.length - 1 };
    });
    void load(path);
  };

  // 后退/前进：沿历史回跳（delta = -1 / +1），不压栈
  const jump = (delta: -1 | 1) => {
    const i = nav.idx + delta;
    if (i < 0 || i >= nav.stack.length) return;
    setNav({ ...nav, idx: i });
    setMoveTarget(null);
    void load(nav.stack[i]);
  };

  // 向上一级；已在根则不可再上
  const goUp = () => go(cwd.includes("/") ? cwd.slice(0, cwd.lastIndexOf("/")) : "");

  // 子树检索（当前目录范围内向下）；空词 = 回到目录浏览
  const doSearch = async (rawQ: string) => {
    const q = rawQ.trim();
    if (!q) {
      setSearch(null);
      return;
    }
    setSearching(true);
    setError("");
    try {
      const r = await window.api.fsSearch({ path: cwd, query: q, childId });
      if (r?.success) {
        setSearch({ q, entries: (r.entries || []) as FsEntry[], truncated: !!r.truncated });
      } else {
        setError(r?.error || "检索失败");
      }
    } finally {
      setSearching(false);
    }
  };

  /** 当前视图刷新：浏览模式重载目录；检索模式重跑同一检索（操作后结果保持新鲜）。 */
  const refreshCurrent = useCallback(async () => {
    if (search) await doSearch(search.q);
    else await load(cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, load, cwd, childId]);

  // 展示列表 = 目录项或检索结果，按表头排序（目录恒在前）
  const displayed = useMemo(
    () => sortEntries(search ? search.entries : entries, sortKey, sortDir),
    [search, entries, sortKey, sortDir]
  );

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };

  const run = async (fn: () => Promise<any>, okMsg?: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const r = await fn();
      if (r?.needsConfirm) return r; // R-1 服务端兜底短路：引用清单交由 handleNeedsConfirm 呈现
      if (r?.success) {
        if (okMsg) setNotice(okMsg);
        await refreshCurrent();
      } else {
        setError(r?.error || "操作失败");
      }
      return r;
    } finally {
      setBusy(false);
    }
  };

  /** R-1：materials 区操作前预检引用；命中则弹确认，返回是否放行（confirm 已带时跳过预检）。
   *  按条目自身路径判区（检索结果可能来自任意目录，cwd 不可靠）。 */
  const confirmRefsIfNeeded = async (path: string, action: string, confirm: boolean): Promise<boolean> => {
    if (confirm || !(path === "materials" || path.startsWith("materials/"))) return true;
    const r = await window.api.fsRefs({ path, childId });
    const refs: RefHit[] = r?.refs || [];
    if (!refs.length) return true;
    const lines = refs.map((x) => `· 【${REF_SOURCE_LABEL[x.source] || x.source}】${x.detail}`).join("\n");
    const c = await window.api.confirmDialog({
      title: "该资料正被引用",
      message: `确定要${action}「${path.split("/").pop()}」吗？`,
      detail: `以下功能正在引用这份资料，操作后可能失效：\n${lines}`,
      confirmLabel: "仍然执行",
      cancelLabel: "取消",
    });
    return !!c?.confirmed;
  };

  /** 服务端 needsConfirm 兜底：把返回的引用清单摆给用户，确认后带 confirm:true 重发。 */
  const handleNeedsConfirm = async (
    r: { needsConfirm?: boolean; refs?: RefHit[] },
    path: string,
    action: string,
    resend: (confirm: boolean) => Promise<any>
  ): Promise<boolean> => {
    if (!r?.needsConfirm) return false;
    const refs: RefHit[] = r.refs || [];
    const lines = refs.map((x) => `· 【${REF_SOURCE_LABEL[x.source] || x.source}】${x.detail}`).join("\n");
    const c = await window.api.confirmDialog({
      title: "该资料正被引用",
      message: `确定要${action}「${path.split("/").pop()}」吗？`,
      detail: `以下功能正在引用这份资料，操作后可能失效：\n${lines}`,
      confirmLabel: "仍然执行",
      cancelLabel: "取消",
    });
    if (c?.confirmed) await run(() => resend(true));
    return true;
  };

  const handleMkdir = async () => {
    const name = mkdirName.trim();
    if (!name) return;
    const r = await run(() => window.api.fsMkdir({ path: cwd, name, childId }));
    if (r?.success) {
      setShowMkdir(false);
      setMkdirName("");
    }
  };

  const handleRename = async (confirm = false) => {
    if (!renameTarget) return;
    const newName = renameValue.trim();
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    if (!(await confirmRefsIfNeeded(renameTarget.path, "重命名", confirm))) return;
    const r = await run(() =>
      window.api.fsRename({ path: renameTarget.path, newName, confirm, childId })
    );
    if (await handleNeedsConfirm(r, renameTarget.path, "重命名", (c) =>
      window.api.fsRename({ path: renameTarget.path, newName, confirm: c, childId })
    )) {
      setRenameTarget(null);
      return;
    }
    if (r?.success) setRenameTarget(null);
  };

  const handleDelete = async (e: FsEntry, confirm = false) => {
    if (!(await confirmRefsIfNeeded(e.path, "删除", confirm))) return;
    const r = await run(() => window.api.fsDelete({ path: e.path, confirm, childId }));
    if (await handleNeedsConfirm(r, e.path, "删除", (c) =>
      window.api.fsDelete({ path: e.path, confirm: c, childId })
    )) {
      return;
    }
  };

  const startMove = (e: FsEntry) => {
    setMoveTarget(e);
    setNotice(`正在移动「${e.name}」——进入目标文件夹后点上方「移到这里」。`);
  };

  const handleMoveTo = async (confirm = false) => {
    if (!moveTarget) return;
    if (!(await confirmRefsIfNeeded(moveTarget.path, "移动", confirm))) return;
    const r = await run(() =>
      window.api.fsMove({ from: moveTarget.path, toDir: cwd, confirm, childId })
    );
    if (await handleNeedsConfirm(r, moveTarget.path, "移动", (c) =>
      window.api.fsMove({ from: moveTarget.path, toDir: cwd, confirm: c, childId })
    )) {
      setMoveTarget(null);
      return;
    }
    if (r?.success) setMoveTarget(null);
  };

  const handleUpload = async (files: FileList | null, overwrite = false) => {
    if (!files || !files.length) return;
    setBusy(true);
    setError("");
    setNotice("");
    let lastError = "";
    let conflictName = "";
    try {
      for (const f of Array.from(files)) {
        const data = await f.arrayBuffer();
        const r = await window.api.fsUpload({
          path: cwd,
          name: f.name,
          mime: f.type || "application/octet-stream",
          data,
          overwrite,
          childId,
        });
        if (r?.success) {
          setNotice(`已上传「${f.name}」`);
        } else {
          lastError = r?.error || "上传失败";
          if ((r?.error || "").includes("已存在同名")) conflictName = f.name;
        }
      }
      if (lastError) {
        if (conflictName) {
          const c = await window.api.confirmDialog({
            title: "同名文件已存在",
            message: `「${conflictName}」已存在，要覆盖吗？`,
            confirmLabel: "覆盖",
            cancelLabel: "取消",
          });
          if (c?.confirmed) {
            setBusy(false);
            return handleUpload(files, true);
          }
        } else {
          setError(lastError);
        }
      } else {
        await load(cwd);
      }
    } finally {
      setBusy(false);
      if (uploadRef.current) uploadRef.current.value = "";
    }
  };

  const handleDownload = async (e: FsEntry) => {
    const r = await window.api.fsDownloadUrl({ path: e.path, childId });
    if (r?.success && r.url) {
      const a = document.createElement("a");
      a.href = r.url;
      a.download = e.name;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      setError(r?.error || "下载失败");
    }
  };

  // 面包屑（materials/a/b → [根, materials, a, b]）
  const crumbs = cwd ? cwd.split("/") : [];
  const title = childId ? "我的文件" : "文件";

  const body = (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: 1 }}>
      {/* 标题行（弹框模式带关闭） */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 16 }}>🗂️ {title}</h3>
        <span style={{ fontSize: 12, color: "#8a94a6" }}>
          {childId ? "工作区里的文件；AI 老师生成的成果也在里面" : "资料库 / 上传原始件 / 各孩子工作区统一管理"}
        </span>
        {onClose && (
          <button
            style={{ marginLeft: "auto", border: "none", background: "none", fontSize: 18, cursor: "pointer" }}
            onClick={onClose}
          >
            ✕
          </button>
        )}
      </div>

      {/* 面包屑 */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4, fontSize: 13, marginBottom: 8 }}>
        <span style={{ cursor: "pointer", color: cwd ? "#667eea" : "#3c4658", fontWeight: 600 }} onClick={() => go("")}>
          根目录
        </span>
        {crumbs.map((seg, i) => {
          const p = crumbs.slice(0, i + 1).join("/");
          const last = i === crumbs.length - 1;
          return (
            <span key={p} style={{ display: "flex", gap: 4 }}>
              <span style={{ color: "#b3bac6" }}>/</span>
              <span
                style={{ cursor: last ? "default" : "pointer", color: last ? "#3c4658" : "#667eea", fontWeight: last ? 600 : 400 }}
                onClick={() => !last && go(p)}
              >
                {seg}
              </span>
            </span>
          );
        })}
      </div>

      {/* 工具行 */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <button
          style={{ ...btnIcon, opacity: nav.idx > 0 ? 1 : 0.45, cursor: nav.idx > 0 ? "pointer" : "default" }}
          disabled={busy || nav.idx <= 0}
          title="后退"
          onClick={() => jump(-1)}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          style={{
            ...btnIcon,
            opacity: nav.idx < nav.stack.length - 1 ? 1 : 0.45,
            cursor: nav.idx < nav.stack.length - 1 ? "pointer" : "default",
          }}
          disabled={busy || nav.idx >= nav.stack.length - 1}
          title="前进"
          onClick={() => jump(1)}
        >
          <ArrowRight size={15} />
        </button>
        <button
          style={{ ...btnIcon, opacity: cwd ? 1 : 0.45, cursor: cwd ? "pointer" : "default" }}
          disabled={busy || !cwd}
          title="向上一级"
          onClick={goUp}
        >
          <ArrowUp size={15} />
        </button>
        <button style={btnPrimary} disabled={busy} onClick={() => { setShowMkdir((v) => !v); setMkdirName(""); }}>
          ＋ 新建文件夹
        </button>
        <button style={btn} disabled={busy} onClick={() => uploadRef.current?.click()}>
          ⬆ 上传到当前目录
        </button>
        {moveTarget && (
          <>
            <button style={btnPrimary} disabled={busy || moveTarget.path === cwd} onClick={() => handleMoveTo(false)}>
              ⇨ 移到这里
            </button>
            <button style={btn} onClick={() => setMoveTarget(null)}>取消移动</button>
          </>
        )}
        {/* 检索：当前目录范围内向下（Enter 检索 / Esc 清除） */}
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              border: "1px solid #d7dce5",
              borderRadius: 8,
              padding: "4px 8px",
              background: "#fff",
            }}
          >
            <Search size={14} color="#8a94a6" />
            <input
              value={searchInput}
              placeholder="搜索当前目录及子目录…"
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void doSearch(searchInput);
                if (e.key === "Escape") {
                  setSearchInput("");
                  setSearch(null);
                }
              }}
              style={{ border: "none", outline: "none", fontSize: 12, width: 170, background: "transparent" }}
            />
            {searchInput && (
              <button
                title="清除"
                style={{ border: "none", background: "none", cursor: "pointer", color: "#8a94a6", fontSize: 12, padding: 0 }}
                onClick={() => {
                  setSearchInput("");
                  setSearch(null);
                }}
              >
                ✕
              </button>
            )}
          </div>
          <button style={btn} disabled={busy || searching || !searchInput.trim()} onClick={() => doSearch(searchInput)}>
            检索
          </button>
        </div>
        <button style={btn} disabled={busy} onClick={() => (search ? doSearch(search.q) : load(cwd))}>
          ↻ 刷新
        </button>
        <input
          ref={uploadRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(ev) => handleUpload(ev.target.files, false)}
        />
      </div>

      {showMkdir && (
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            autoFocus
            value={mkdirName}
            placeholder="文件夹名称"
            onChange={(e) => setMkdirName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleMkdir()}
            style={{ flex: 1, border: "1px solid #d7dce5", borderRadius: 8, padding: "6px 10px", fontSize: 13 }}
          />
          <button style={btnPrimary} disabled={busy || !mkdirName.trim()} onClick={handleMkdir}>确定</button>
          <button style={btn} onClick={() => setShowMkdir(false)}>取消</button>
        </div>
      )}

      {notice && (
        <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 8, background: "#eefaf0", color: "#1d7a3d", fontSize: 12 }}>
          {notice}
        </div>
      )}
      {error && (
        <div style={{ marginBottom: 8, padding: "6px 10px", borderRadius: 8, background: "#fdeceb", color: "#c0392b", fontSize: 12 }}>
          {error}
        </div>
      )}

      {/* 检索模式提示条 */}
      {search && (
        <div
          style={{
            marginBottom: 8,
            padding: "6px 10px",
            borderRadius: 8,
            background: "#eef2ff",
            color: "#3b4cca",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span>
            检索「{search.q}」：{search.entries.length} 项命中（范围：{cwd || "根目录"} 及其子目录）
            {search.truncated && "，结果已截断，请换更精确的关键词"}
          </span>
          <button
            style={{ ...btnMini, marginLeft: "auto" }}
            onClick={() => {
              setSearch(null);
              setSearchInput("");
            }}
          >
            返回目录浏览
          </button>
        </div>
      )}

      {/* 表头（排序；列宽与数据行对齐） */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 14px",
          fontSize: 12,
          color: "#5a6478",
          borderBottom: "1px solid #e6eaf0",
        }}
      >
        <span style={{ flexShrink: 0, width: 16 }} />
        {SORT_COLS.map(([key, label, width, align]) => (
          <span
            key={key}
            onClick={() => toggleSort(key)}
            style={{
              cursor: "pointer",
              userSelect: "none",
              flexShrink: 0,
              flex: key === "name" ? 1 : undefined,
              minWidth: 0,
              width,
              textAlign: align,
              fontWeight: sortKey === key ? 700 : 400,
              color: sortKey === key ? "#3b4cca" : undefined,
            }}
            title={`按${label}排序`}
          >
            {label}
            {sortKey === key && (sortDir === 1 ? " ▲" : " ▼")}
          </span>
        ))}
        <span style={{ flexShrink: 0 }}>操作</span>
      </div>

      {/* 列表 */}
      <div style={{ overflowY: "auto", flex: 1, minHeight: 0, background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12 }}>
        {loading || searching ? (
          <div style={{ padding: 28, textAlign: "center", color: "#98a1b2", fontSize: 13 }}>
            {searching ? "检索中…" : "加载中…"}
          </div>
        ) : displayed.length === 0 ? (
          <div style={{ padding: 28, textAlign: "center", color: "#98a1b2", fontSize: 13 }}>
            {search ? "没有匹配的文件或文件夹，换个关键词试试。" : "空目录。上传文件或新建文件夹开始整理。"}
          </div>
        ) : (
          displayed.map((e) => (
            <div
              key={e.path}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 14px",
                borderBottom: "1px solid #f0f2f7",
                fontSize: 13,
              }}
            >
              {renameTarget && renameTarget.path === e.path ? (
                <>
                  <span>{e.type === "dir" ? "📁" : "📄"}</span>
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(ev) => setRenameValue(ev.target.value)}
                    onKeyDown={(ev) => ev.key === "Enter" && handleRename()}
                    style={{ flex: 1, border: "1px solid #d7dce5", borderRadius: 6, padding: "4px 8px", fontSize: 13 }}
                  />
                  <button style={btnMini} disabled={busy} onClick={() => handleRename()}>确定</button>
                  <button style={btnMini} onClick={() => setRenameTarget(null)}>取消</button>
                </>
              ) : (
                <>
                  <span style={{ flexShrink: 0 }}>{fileIcon(e.name, e.type === "dir")}</span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      cursor: e.type === "dir" ? "pointer" : "default",
                      fontWeight: e.type === "dir" ? 600 : 400,
                    }}
                    onClick={() => {
                      if (e.type !== "dir") return;
                      if (search) {
                        // 检索结果里点目录：跳出检索并进入该目录
                        setSearch(null);
                        setSearchInput("");
                      }
                      go(e.path);
                    }}
                    title={search ? e.path : e.label ? `${e.label}（${e.name}）` : e.name}
                  >
                    {e.label || e.name}
                    {e.label && (
                      <span style={{ fontSize: 11, color: "#b3bac6", marginLeft: 6 }}>{e.name}</span>
                    )}
                    {search && e.path.includes("/") && (
                      <span style={{ fontSize: 11, color: "#8a94a6", marginLeft: 6 }}>
                        {e.path.slice(0, e.path.lastIndexOf("/"))}
                      </span>
                    )}
                  </span>
                  <span style={{ width: 76, textAlign: "right", color: "#8a94a6", fontSize: 12, flexShrink: 0 }}>
                    {e.type === "file" ? formatSize(e.size) : "–"}
                  </span>
                  <span style={{ width: 130, color: "#8a94a6", fontSize: 12, flexShrink: 0 }}>
                    {formatTime(e.mtime)}
                  </span>
                  <span style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                    {e.type === "file" && (
                      <button style={btnMini} disabled={busy} onClick={() => handleDownload(e)}>下载</button>
                    )}
                    {!readOnlyEntry(e) && (
                      <>
                        <button
                          style={btnMini}
                          disabled={busy}
                          onClick={() => {
                            setRenameTarget(e);
                            setRenameValue(e.name);
                          }}
                        >
                          重命名
                        </button>
                        <button style={btnMini} disabled={busy || e.type === "dir" && cwd.startsWith(e.path)} onClick={() => startMove(e)}>
                          移动
                        </button>
                      </>
                    )}
                    {e.type === "dir" && readOnlyEntry(e) && (
                      <span style={{ fontSize: 11, color: "#b3bac6" }} title="服务端大文件通道原始件（uuid 落盘），P1 暂不支持改名/移动">
                        原始件
                      </span>
                    )}
                    <button style={btnDanger} disabled={busy} onClick={() => handleDelete(e, false)}>删除</button>
                  </span>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );

  if (!onClose) return body; // 页面内嵌（家长 Dashboard）

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15,23,42,.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: "#f6f8fb",
          borderRadius: 16,
          width: "min(760px, 94vw)",
          height: "min(640px, 88vh)",
          display: "flex",
          flexDirection: "column",
          padding: "16px 20px",
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {body}
      </div>
    </div>
  );
}

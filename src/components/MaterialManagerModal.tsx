import { useCallback, useEffect, useState } from "react";

interface MaterialNode {
  name: string;
  relPath: string;
  isDir: boolean;
  ext?: string;
  children?: MaterialNode[];
}

interface CourseRow {
  title: string;
  htmlPath?: string;
}

/**
 * 学习资料管理弹框（主题级）：
 * 以文件夹分级（树状）展示 materials/<topicDir>/ 下**所有**文件（含任意子目录，不只 media），
 * 家长可上传新资料（复用 parentUploadMaterial，html 自动关联同名课程）或删除资料。
 * 资料按「主题」为单位存储，故本弹框挂在主题卡片上，而非单个课程。
 */
export default function MaterialManagerModal({ topicDir, topicName, onClose }: { topicDir: string; topicName: string; onClose: () => void }) {
  const [tree, setTree] = useState<MaterialNode[]>([]);
  const [courses, setCourses] = useState<CourseRow[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState<string | null>(null);

  const reload = useCallback(() => {
    window.api.parentListTopicMaterials(topicDir).then((r: any) => {
      if (r?.success) setTree(r.data || []);
    });
  }, [topicDir]);

  useEffect(() => {
    reload();
    window.api.parentListCourses(topicDir).then((r: any) => {
      if (r?.success) setCourses(r.data || []);
    });
  }, [reload, topicDir]);

  function toggle(relPath: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(relPath)) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  }

  async function onUpload() {
    setBusy(true);
    setErr(null);
    try {
      const r: any = await window.api.parentUploadMaterial(topicDir, targetDir || undefined);
      if (!r?.success) { setErr(r?.error || "上传失败"); return; }
      const files: { name: string; relPath: string }[] = r.data?.files || [];
      // 上传的 html 自动关联同名课程（沿用原有行为）
      for (const f of files) {
        if (!/\.(html|htm)$/i.test(f.relPath)) continue;
        const title = f.name.replace(/\.[^.]+$/, "");
        const hit = courses.find((c) => c.title === title);
        if (hit) {
          await window.api.parentUpsertCourse(topicDir, { title: hit.title, htmlPath: f.relPath });
        }
      }
      reload();
    } finally {
      setBusy(false);
    }
  }

  async function onDelete(node: MaterialNode) {
    if (node.isDir) return;
    if (!window.confirm(`确定删除资料「${node.relPath}」？\n此操作不可恢复；若该文件正被某课程引用（如 html 学习材料），将出现断链。`)) return;
    const r: any = await window.api.parentDeleteMaterial(topicDir, node.relPath);
    if (!r?.success) { setErr(r?.error || "删除失败"); return; }
    reload();
  }

  function renderNodes(nodes: MaterialNode[], depth: number): React.ReactNode {
    return nodes.map((n) => {
      const pad = { paddingLeft: depth * 16 + 8 };
      if (n.isDir) {
        const open = !collapsed.has(n.relPath);
        const sel = targetDir === n.relPath;
        return (
          <div key={n.relPath}>
            <div style={{ ...rowStyle, ...pad, display: "flex", alignItems: "center", background: sel ? "#eef3ff" : "transparent", borderRadius: 6 }}>
              <button
                onClick={() => toggle(n.relPath)}
                style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 11, color: "#888", padding: "2px 4px", flexShrink: 0 }}
                title={open ? "折叠" : "展开"}
              >
                {open ? "▾" : "▸"}
              </button>
              <button
                onClick={() => setTargetDir(sel ? null : n.relPath)}
                style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 13, fontWeight: 600, color: sel ? "#667eea" : "#555", padding: "4px 2px", textAlign: "left", flex: 1 }}
                title={`上传到 ${n.relPath}/`}
              >
                📁 {n.name}
                {n.children && n.children.length > 0 ? `（${n.children.length}）` : ""}
              </button>
            </div>
            {open && n.children && n.children.length > 0 && renderNodes(n.children, depth + 1)}
          </div>
        );
      }
      return (
        <div key={n.relPath} style={{ ...rowStyle, ...pad, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ fontSize: 13, wordBreak: "break-all", marginRight: 8 }}>
            <span style={{ marginRight: 4 }}>{extIcon(n.ext)}</span>
            {n.name}
            {n.ext && (
              <span style={{ marginLeft: 6, fontSize: 11, color: "#fff", background: "#667eea", borderRadius: 4, padding: "1px 6px" }}>
                {n.ext.slice(1).toUpperCase()}
              </span>
            )}
          </span>
          <button onClick={() => onDelete(n)} style={{ ...smallBtn, background: "#fff0f0", color: "#e53e3e", borderColor: "#f3c0c0", flexShrink: 0 }}>删除</button>
        </div>
      );
    });
  }

  const totalFiles = countFiles(tree);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <h2 style={{ fontSize: 16, marginBottom: 6 }}>🗂 学习资料管理 · {topicName}</h2>
        <p style={{ fontSize: 12, color: "#888", marginTop: 0, marginBottom: 8 }}>
          主题目录：data/parents/default/materials/{topicDir}/（含全部子目录，共 {totalFiles} 个文件）
        </p>
        <p style={{ fontSize: 12, marginTop: 0, marginBottom: 12, lineHeight: 1.6 }}>
          上传到：{targetDir ? (
            <>
              <b style={{ color: "#667eea" }}>materials/{topicDir}/{targetDir}/</b>
              <button onClick={() => setTargetDir(null)} style={{ ...smallBtn, marginLeft: 8, padding: "2px 8px", fontSize: 11 }}>↩ 根目录</button>
            </>
          ) : (
            <b style={{ color: "#667eea" }}>主题根目录 materials/{topicDir}/</b>
          )}
          <span style={{ color: "#aaa", marginLeft: 6 }}>（点击目录名切换目标；未选中时媒体自动进 media/）</span>
        </p>
        {err && <p style={{ color: "#e53e3e", fontSize: 12, marginBottom: 8 }}>{err}</p>}
        <div style={{ maxHeight: 340, overflowY: "auto", marginBottom: 8, border: "1px solid #f0f0f0", borderRadius: 8, padding: "4px 8px" }}>
          {tree.length === 0 ? (
            <p style={{ color: "#888", fontSize: 13, padding: 8 }}>该主题暂无资料，点击下方「上传资料」添加。</p>
          ) : (
            renderNodes(tree, 0)
          )}
        </div>
        <div className="modal-actions">
          <button className="cancel" onClick={onClose}>关闭</button>
          <button className="confirm" onClick={onUpload} disabled={busy}>{busy ? "上传中…" : targetDir ? `上传到「${targetDir}」` : "上传资料"}</button>
        </div>
      </div>
    </div>
  );
}

function countFiles(nodes: MaterialNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.isDir) n += countFiles(node.children || []);
    else n++;
  }
  return n;
}

function extIcon(ext?: string): string {
  switch ((ext || "").toLowerCase()) {
    case ".html": case ".htm": return "📄";
    case ".md": return "📝";
    case ".pdf": return "📕";
    case ".jpg": case ".jpeg": case ".png": case ".webp": case ".gif": return "🖼️";
    case ".mp3": case ".wav": case ".m4a": case ".ogg": case ".aac": case ".flac": return "🎵";
    case ".mp4": case ".webm": case ".mov": return "🎬";
    case ".txt": return "📃";
    default: return "📄";
  }
}

const smallBtn: React.CSSProperties = {
  padding: "5px 12px",
  borderRadius: 6,
  border: "1px solid #ddd",
  background: "#fff",
  fontSize: 12,
  cursor: "pointer",
};

const rowStyle: React.CSSProperties = {
  padding: "7px 0",
  borderBottom: "1px solid #f3f3f3",
  fontSize: 13,
};

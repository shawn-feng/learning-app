import { useEffect, useMemo, useState } from "react";

/**
 * 学习主题打包导出对话框（2026-09-25 方案）：
 * 打开即拉取预览（主题内容计数 + 资料文件清单）；「是否打包资料文件」默认否——
 * 勾选后按类型分组列出文件，支持整组勾选/单文件勾选，实时合计体积（单包上限 200MB）。
 * 导出 = 服务端生成 .ltpkg（zip）→ Electron 落盘 / Web 浏览器下载。
 */
interface PreviewData {
  topic: { name: string; topicKey: string };
  counts: { courses: number; knowledgePoints: number; questions: number };
  files: Array<{ path: string; type: string; size: number; refCount: number }>;
}

interface Props {
  topic: { name: string; topicKey: string };
  onClose: () => void;
  /** 导出成功后回调（刷新列表/提示） */
  onDone: (msg: { ok: boolean; text: string }) => void;
}

/** 全局 .modal input { width:100% } 会把勾选框拉满整行、挤掉文件名——所有 checkbox 必须内联重置。 */
const CHECKBOX_STYLE = { width: "auto", margin: 0, padding: 0 } as const;

/** 服务端 inferType → 展示分组（顺序即显示顺序）。 */
const TYPE_GROUPS: Array<{ key: string; label: string; types: string[] }> = [
  { key: "html", label: "网页", types: ["html", "css", "js", "json"] },
  { key: "image", label: "图片", types: ["image"] },
  { key: "audio", label: "音频", types: ["audio"] },
  { key: "video", label: "视频", types: ["video"] },
  { key: "text", label: "文档", types: ["text"] },
  { key: "other", label: "其他", types: ["other"] },
];

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/** 与 electron/lib/topic-package.ts defaultExportFileName 同规则（渲染层不能 import 主进程模块）。 */
function defaultExportFileName(topicName: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const safe = topicName.replace(/[\\/:*?"<>|]/g, " ").trim() || "topic";
  return `${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.ltpkg`;
}

export default function TopicExportDialog({ topic, onClose, onDone }: Props) {
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState("");
  const [includeFiles, setIncludeFiles] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    window.api.parentExportPreview(topic.topicKey).then((r: any) => {
      if (r?.success) setPreview(r.data);
      else setError(r?.error || "获取预览失败");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic.topicKey]);

  const groups = useMemo(() => {
    const files = preview?.files || [];
    return TYPE_GROUPS.map((g) => {
      const items = files.filter((f) => g.types.includes(f.type));
      return { ...g, items };
    }).filter((g) => g.items.length > 0);
  }, [preview]);

  const selectedBytes = useMemo(
    () => (preview?.files || []).filter((f) => selected.has(f.path)).reduce((s, f) => s + f.size, 0),
    [preview, selected]
  );

  function toggleFile(path: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleGroup(paths: string[]) {
    setSelected((prev) => {
      const allIn = paths.every((p) => prev.has(p));
      const next = new Set(prev);
      for (const p of paths) {
        if (allIn) next.delete(p);
        else next.add(p);
      }
      return next;
    });
  }

  async function doExport() {
    setExporting(true);
    setError("");
    try {
      const files = includeFiles ? [...selected] : [];
      const r = await window.api.parentExportTopic(topic.topicKey, files, defaultExportFileName(topic.name));
      if (r?.success) {
        onDone({
          ok: true,
          text: `已导出「${topic.name}」→ ${r.file}${includeFiles ? `（含资料 ${selected.size} 个文件）` : "（纯数据包，不含资料文件）"}`,
        });
        onClose();
      } else if (!r?.canceled) {
        setError(r?.error || "导出失败");
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>打包导出 — {topic.name}</div>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#888" }}>
          导出成 .ltpkg 主题包（zip），发给另一套学习伙伴后「导入主题」一键使用。
          {preview && (
            <>
              {" "}包含 {preview.counts.courses} 门课程 · {preview.counts.knowledgePoints} 个知识点 ·{" "}
              {preview.counts.questions} 道题。
            </>
          )}
        </p>

        {error && (
          <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8, background: "#fdecec", color: "#b33" }}>
            {error}
          </div>
        )}

        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" }}>
          <input type="checkbox" style={CHECKBOX_STYLE} checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
          打包多媒体资料（视频、音频、图片、网页等）
        </label>
        {!includeFiles && (
          <p style={{ margin: "4px 0 8px", fontSize: 11, color: "#aaa" }}>
            默认只打包课程与题目内容；未随包的资料，导入端可让 AI 重新生成，或后续补发一个带资料的包。
          </p>
        )}

        {includeFiles && (
          <div style={{ border: "1px solid #eee", borderRadius: 8, padding: "8px 10px", maxHeight: "40vh", overflowY: "auto" }}>
            {!preview && <div style={{ fontSize: 12, color: "#888" }}>资料清单加载中…</div>}
            {preview && preview.files.length === 0 && (
              <div style={{ fontSize: 12, color: "#888" }}>该主题暂无资料文件。</div>
            )}
            {groups.map((g) => {
              const paths = g.items.map((f) => f.path);
              const allIn = paths.every((p) => selected.has(p));
              const gBytes = g.items.reduce((s, f) => s + f.size, 0);
              return (
                <div key={g.key} style={{ marginBottom: 8 }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    <input type="checkbox" style={CHECKBOX_STYLE} checked={allIn} onChange={() => toggleGroup(paths)} />
                    {g.label}（{g.items.length} 个 · {fmtSize(gBytes)}）
                  </label>
                  <div style={{ marginLeft: 20 }}>
                    {g.items.map((f) => (
                      <label
                        key={f.path}
                        title={f.path}
                        style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0", cursor: "pointer" }}
                      >
                        <input type="checkbox" style={CHECKBOX_STYLE} checked={selected.has(f.path)} onChange={() => toggleFile(f.path)} />
                        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {f.path.slice(topic.topicKey.length + 1) || f.path}
                        </span>
                        {f.refCount > 0 && <span style={{ color: "#667eea", fontSize: 11, whiteSpace: "nowrap" }}>被{f.refCount}课引用</span>}
                        <span style={{ color: "#999", fontSize: 11, whiteSpace: "nowrap" }}>{fmtSize(f.size)}</span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 12, alignItems: "center" }}>
          {includeFiles && (
            <span style={{ fontSize: 12, color: "#888", marginRight: "auto" }}>
              已选资料 {selected.size} 个 · {fmtSize(selectedBytes)}
            </span>
          )}
          <button className="cancel" onClick={onClose}>
            取消
          </button>
          <button
            onClick={doExport}
            disabled={exporting}
            style={{
              padding: "6px 16px",
              borderRadius: 6,
              border: "none",
              background: exporting ? "#aab" : "#667eea",
              color: "#fff",
              fontSize: 12,
              cursor: exporting ? "default" : "pointer",
            }}
          >
            {exporting ? "导出中…" : "导出"}
          </button>
        </div>
      </div>
    </div>
  );
}

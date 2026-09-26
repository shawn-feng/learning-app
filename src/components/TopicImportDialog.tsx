import { useState } from "react";

/**
 * 学习主题包导入对话框（2026-09-25 方案）：
 * 选 .ltpkg 文件（Electron 系统框 / Web 浏览器选择）→ 上传服务端导入 → 展示导入报告
 * （主题名/是否自动重命名/课程·知识点·题目·文件计数/缺资料清单/警告）。
 * 导入后的主题处于「未分配」状态，需到孩子管理里「添加学习主题」给孩子。
 */
interface ImportReport {
  ok: true;
  topic: { name: string; topicKey: string };
  renamed: boolean;
  refreshed: boolean;
  courses: number;
  knowledge_points: number;
  questions: number;
  files: number;
  missing_files: string[];
  warnings: string[];
}

interface Props {
  onClose: () => void;
  /** 导入成功点「完成」后回调（刷新主题列表/提示） */
  onDone: (msg: { ok: boolean; text: string }) => void;
}

export default function TopicImportDialog({ onClose, onDone }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);

  async function pickAndImport() {
    setBusy(true);
    setError("");
    try {
      const r = await window.api.parentImportTopic();
      if (r?.success) {
        setReport(r.report as ImportReport);
      } else if (!r?.canceled) {
        setError(r?.error || "导入失败");
      }
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    if (report) {
      const suffix = report.renamed ? "（已自动重命名）" : report.refreshed ? "（已刷新已有主题）" : "";
      onDone({ ok: true, text: `已导入主题「${report.topic.name}」${suffix}` });
    }
    onClose();
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>导入学习主题包</div>
        <p style={{ margin: "0 0 10px", fontSize: 12, color: "#888" }}>
          选择 .ltpkg 主题包文件导入（可从另一套学习伙伴「打包导出」获得）。
          导入后主题未分配给孩子，需到「孩子管理 → 学习主题」里添加。
        </p>

        {error && (
          <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8, background: "#fdecec", color: "#b33" }}>
            {error}
          </div>
        )}

        {report ? (
          <div style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              导入成功：主题「{report.topic.name}」（{report.topic.topicKey}）
              {report.renamed && (
                <span style={{ color: "#b8860b", fontWeight: 400, fontSize: 12 }}> · 与现有主题同名，已自动重命名</span>
              )}
              {report.refreshed && (
                <span style={{ color: "#2f8a52", fontWeight: 400, fontSize: 12 }}> · 已刷新已有主题（进度不受影响）</span>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              {report.courses} 门课程 · {report.knowledge_points} 个知识点 · {report.questions} 道题 · {report.files} 个资料文件
            </div>
            {report.missing_files.length > 0 && (
              <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8, background: "#fff7e6", color: "#8a6d3b" }}>
                <div style={{ fontWeight: 600 }}>以下课程引用的多媒体资料未随包（可在本机让 AI 重新生成，或请原作者补发带资料的包）：</div>
                {report.missing_files.map((m) => (
                  <div key={m}>{m}</div>
                ))}
              </div>
            )}
            {report.warnings.length > 0 && (
              <div style={{ fontSize: 12, padding: "6px 10px", borderRadius: 6, marginBottom: 8, background: "#fdecec", color: "#b33" }}>
                {report.warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
            同名主题处理：名字相同且来自同一主题（目录名一致）时刷新已有内容；同名但不同主题会自动重命名导入（如「论语 (2)」）。
          </p>
        )}

        <div className="modal-actions" style={{ marginTop: 12 }}>
          {report ? (
            <button
              onClick={finish}
              style={{
                padding: "6px 16px",
                borderRadius: 6,
                border: "none",
                background: "#667eea",
                color: "#fff",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              完成
            </button>
          ) : (
            <>
              <button className="cancel" onClick={onClose}>
                取消
              </button>
              <button
                onClick={pickAndImport}
                disabled={busy}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: busy ? "#aab" : "#667eea",
                  color: "#fff",
                  fontSize: 12,
                  cursor: busy ? "default" : "pointer",
                }}
              >
                {busy ? "导入中…" : "选择包文件并导入"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

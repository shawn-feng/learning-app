import { useState } from "react";

/**
 * 学习主题包导入对话框（两阶段，2026-09-26 同名提示需求）：
 * ① 选文件 → 服务端 inspect（不落库）：包信息 + 同名冲突裁决；
 * ② 无冲突 → 直接 apply；有冲突 → 提示（刷新已有主题 / 将自动重命名），
 *    主题名与目录名可编辑，确认后按家长改定的身份 apply（服务端二次校验防覆盖）。
 * 导入后的主题如未分配，需到「孩子管理 → 学习主题」里添加给孩子。
 */
interface InspectInfo {
  name: string;
  topicKey: string;
  counts: { courses: number; knowledgePoints: number; questions: number; files: number };
  conflict: { type: "none" | "refresh" | "rename"; suggestedName: string; suggestedKey: string };
}

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

export default function TopicImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (msg: { ok: boolean; text: string }) => void }) {
  const [phase, setPhase] = useState<"idle" | "inspecting" | "confirm" | "importing">("idle");
  const [fileRef, setFileRef] = useState<string | null>(null);
  const [info, setInfo] = useState<InspectInfo | null>(null);
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<ImportReport | null>(null);

  async function pickAndInspect() {
    setPhase("inspecting");
    setError("");
    try {
      const picked = await window.api.parentImportPick();
      if (!picked?.success) {
        if (!picked?.canceled) setError(picked?.error || "选择文件失败");
        setPhase("idle");
        return;
      }
      setFileRef(picked.path ?? picked.fileRef ?? null);
      const r = await window.api.parentImportInspect(picked.path ?? picked.fileRef);
      if (!r?.success) {
        setError(r?.error || "读取主题包失败");
        setPhase("idle");
        return;
      }
      const inf = r.info as InspectInfo;
      setInfo(inf);
      if (inf.conflict.type === "none") {
        await doApply(); // 无冲突走服务端默认身份
        return;
      }
      setName(inf.conflict.suggestedName);
      setKey(inf.conflict.suggestedKey);
      setPhase("confirm");
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase("idle");
    }
  }

  async function doApply(targetName?: string, targetKey?: string) {
    setPhase("importing");
    setError("");
    try {
      const r = await window.api.parentImportApply(fileRef, targetName, targetKey);
      if (r?.success) {
        setReport(r.report as ImportReport);
        setPhase("idle");
      } else {
        setError(r?.error || "导入失败");
        if (info && info.conflict.type !== "none") setPhase("confirm");
        else setPhase("idle");
      }
    } catch (e: any) {
      setError(String(e?.message || e));
      setPhase(info && info.conflict.type !== "none" ? "confirm" : "idle");
    }
  }

  function finish() {
    if (report) {
      const suffix = report.renamed ? "（已按新名字导入）" : report.refreshed ? "（已刷新已有主题）" : "";
      onDone({ ok: true, text: `已导入主题「${report.topic.name}」${suffix}` });
    }
    onClose();
  }

  const conflict = info?.conflict;
  // phase 在 JSX 分支里会被 TS 收窄成 "confirm"，运行中 doApply 会把它改成 "importing"——
  // 用顶层布尔做判断，避免分支内比较被当成不可达（TS2367）。
  const importing = phase === "importing";

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>导入学习主题包</div>
        {!report && (
          <p style={{ margin: "0 0 10px", fontSize: 12, color: "#888" }}>
            选择 .ltpkg 主题包文件导入（可从另一套学习伙伴「打包导出」获得）。
            {fileRef && <>已选择：{fileRef}</>}
          </p>
        )}

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
                <span style={{ color: "#b8860b", fontWeight: 400, fontSize: 12 }}> · 已按新名字/目录导入</span>
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
        ) : phase === "confirm" && info && conflict ? (
          <div style={{ fontSize: 13 }}>
            <div style={{ padding: "8px 10px", borderRadius: 6, marginBottom: 10, background: "#fff7e6", color: "#8a6d3b", fontSize: 12 }}>
              {conflict.type === "refresh" ? (
                <>
                  已存在同名主题「{info.name}」（目录 {info.topicKey}，{info.counts.courses} 门课）。
                  <b>直接导入会刷新它的内容</b>（孩子的学习进度不受影响）；想作为新主题保留两份，请修改下面的名字。
                </>
              ) : (
                <>
                  已存在同名主题（{conflict.suggestedName !== info.name ? `将自动命名为「${conflict.suggestedName}」` : "名字冲突"}）。
                  可在下方修改为主题名/目录名后导入为新主题。
                </>
              )}
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 8 }}>
              包内含 {info.counts.courses} 门课程 · {info.counts.knowledgePoints} 个知识点 · {info.counts.questions} 道题 · {info.counts.files} 个资料文件
            </div>
            <label style={{ display: "block", fontSize: 12, color: "#666", marginBottom: 4 }}>主题名</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" }}
            />
            <label style={{ display: "block", fontSize: 12, color: "#666", margin: "8px 0 4px" }}>
              目录名（资料存放目录；改名后新主题的资料会放到新目录）
            </label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid #ddd", fontSize: 13, boxSizing: "border-box" }}
            />
            <p style={{ margin: "8px 0 0", fontSize: 11, color: "#999" }}>
              保持名字与目录名不变 = 刷新已有主题；改掉名字并换一个目录名 = 作为新主题导入（孩子的学习进度都不受影响）。
            </p>
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 12, color: "#888" }}>
            同名主题会在导入前提示，可以选择刷新已有主题或改名导入为新主题。
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
          ) : phase === "confirm" ? (
            <>
              <button className="cancel" onClick={onClose}>
                取消
              </button>
              <button
                onClick={() => doApply(name.trim(), key.trim())}
                disabled={importing || !name.trim() || !key.trim()}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: importing ? "#aab" : "#667eea",
                  color: "#fff",
                  fontSize: 12,
                  cursor: importing ? "default" : "pointer",
                }}
              >
                {importing ? "导入中…" : "确认导入"}
              </button>
            </>
          ) : (
            <>
              <button className="cancel" onClick={onClose}>
                取消
              </button>
              <button
                onClick={pickAndInspect}
                disabled={phase === "inspecting"}
                style={{
                  padding: "6px 16px",
                  borderRadius: 6,
                  border: "none",
                  background: phase === "inspecting" ? "#aab" : "#667eea",
                  color: "#fff",
                  fontSize: 12,
                  cursor: phase === "inspecting" ? "default" : "pointer",
                }}
              >
                {phase === "inspecting" ? "读取主题包…" : "选择包文件并导入"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

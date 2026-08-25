import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { BarChart3, Database, FolderOpen, Save, Undo2 } from "lucide-react";

/**
 * 数据备份 / 恢复设置（ISSUE-041 层 A）。
 * - 一键备份：把 data/ 全量（排除敏感数据）打成 zip 到用户指定目录。
 * - 从备份恢复：解压回 data/，默认保护本机 API key 与登录凭证。
 * - 定时备份：每天在设定时间自动备份到指定目录（需先选定目录）。
 */
export default function BackupSettings() {
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState("22");
  const [minute, setMinute] = useState("30");
  const [destDir, setDestDir] = useState("");
  const [busy, setBusy] = useState<"" | "backup" | "restore" | "cloud" | "progress">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // 云端同步（ISSUE-041 层 C）
  const [children, setChildren] = useState<any[]>([]);
  const [selectedChild, setSelectedChild] = useState("");
  const [progress, setProgress] = useState<any>(null);

  useEffect(() => {
    window.api.backupConfigGet().then((cfg: any) => {
      if (!cfg) return;
      setEnabled(!!cfg.enabled);
      setHour(String(cfg.hour ?? 22).padStart(2, "0"));
      setMinute(String(cfg.minute ?? 30).padStart(2, "0"));
      setDestDir(cfg.destDir || "");
    });
    window.api.childList().then((list: any[]) => {
      const kids = Array.isArray(list) ? list : [];
      setChildren(kids);
      if (kids.length > 0) setSelectedChild(kids[0].childId);
    });
  }, []);

  // ---- 跨机查进度（ISSUE-041：云端只做消息交换，进度摘要仅在查询时上传） ----

  async function handleQueryProgress() {
    if (!selectedChild) return;
    setBusy("progress");
    setMsg(null);
    const r = await window.api.syncQueryProgress(selectedChild);
    setBusy("");
    if (r.success) {
      setProgress(r.data);
      const note = r.data?.note ? `（${r.data.note}）` : "";
      setMsg({ ok: true, text: `已请求孩子端刷新进度，并读取云端当前摘要${note}` });
    } else {
      setMsg({ ok: false, text: `查询失败：${r.error}` });
    }
  }

  async function handleBackup() {
    setBusy("backup");
    setMsg(null);
    const r = await window.api.createBackup();
    setBusy("");
    if (r.success) {
      setMsg({ ok: true, text: `备份完成：${r.file}（${r.count} 个文件）` });
    } else if (r.canceled) {
      setMsg({ ok: true, text: "已取消" });
    } else {
      setMsg({ ok: false, text: `备份失败：${r.error}` });
    }
  }

  async function handleRestore() {
    const c = await window.api.confirmDialog({
      title: "恢复备份",
      message: "将用备份文件覆盖当前全部使用数据（课程、进度、生活记录等）。",
      detail:
        "模型 API key 与登录凭证不会受影响。建议恢复前先做一次新备份。是否继续？",
      confirmLabel: "继续恢复",
      cancelLabel: "取消",
    });
    if (!c.confirmed) return;
    setBusy("restore");
    setMsg(null);
    const r = await window.api.restoreBackup();
    setBusy("");
    if (r.success) {
      const skip = Array.isArray(r.skipped) && r.skipped.length > 0 ? `（跳过 ${r.skipped.length} 个受保护条目）` : "";
      setMsg({ ok: true, text: `恢复完成：${r.restored} 个文件${skip}` });
    } else if (r.canceled) {
      setMsg({ ok: true, text: "已取消" });
    } else {
      setMsg({ ok: false, text: `恢复失败：${r.error}` });
    }
  }

  async function handlePickDir() {
    const r = await window.api.pickDirectory("选择定时备份保存目录");
    if (r && !r.canceled && r.path) setDestDir(r.path);
  }

  async function handleSaveConfig() {
    const h = parseInt(hour, 10);
    const m = parseInt(minute, 10);
    if (!Number.isFinite(h) || h < 0 || h > 23) {
      setMsg({ ok: false, text: "小时需为 0-23" });
      return;
    }
    if (!Number.isFinite(m) || m < 0 || m > 59) {
      setMsg({ ok: false, text: "分钟需为 0-59" });
      return;
    }
    const r = await window.api.backupConfigSet({ enabled, hour: h, minute: m, destDir });
    setMsg(
      r && typeof r.enabled === "boolean"
        ? { ok: true, text: "定时备份配置已保存" }
        : { ok: false, text: "保存失败" }
    );
  }

  const btn: React.CSSProperties = {
    padding: "10px 20px",
    background: "#667eea",
    color: "white",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  };
  const ghost: React.CSSProperties = {
    padding: "10px 20px",
    background: "#f0f4ff",
    color: "#667eea",
    border: "none",
    borderRadius: 8,
    cursor: "pointer",
  };

  return (
    <div className="settings-section">
      <h3>数据备份 / 恢复</h3>
      <p className="desc">
        备份孩子学习生活记录、家长课程管理与 AI 提示词等使用数据，打包为 zip 文件。
        不包含模型 API key、登录凭证、孩子密码哈希与会话历史。
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <IconButton icon={Database} title="立即备份" style={btn} disabled={busy !== ""} onClick={handleBackup} />
        <IconButton icon={Undo2} title="从备份恢复" style={ghost} disabled={busy !== ""} onClick={handleRestore} />
      </div>

      {msg && (
        <p style={{ fontSize: 13, color: msg.ok ? "#0f6e56" : "#a32d2d", marginBottom: 16 }}>
          {msg.text}
        </p>
      )}

      <h4 style={{ fontSize: 15, marginBottom: 8 }}>跨机查进度</h4>
      <p className="desc" style={{ marginBottom: 12 }}>
        在另一台电脑分配主题给孩子后，孩子端会在本地写入课程数据（课程资料文件需通过 zip
        备份迁移到孩子端）。你在这里查询时，孩子端会把学习进度摘要上传到云端（仅此一种数据上云，非备份）。
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        <select
          value={selectedChild}
          onChange={(e) => setSelectedChild(e.target.value)}
          style={{ padding: 8, border: "1px solid #ddd", borderRadius: 8, fontSize: 14 }}
        >
          {children.map((c) => (
            <option key={c.childId} value={c.childId}>
              {c.name || c.childId}
            </option>
          ))}
        </select>
        <IconButton icon={BarChart3} title="云端查进度" style={ghost} disabled={busy !== ""} onClick={handleQueryProgress} />
      </div>

      {progress && (
        <div
          style={{
            border: "1px solid #ddd",
            borderRadius: 8,
            padding: 12,
            marginBottom: 16,
            fontSize: 13,
            background: "#fafbff",
          }}
        >
          {progress.note && <p style={{ color: "#888", marginBottom: 8 }}>{progress.note}</p>}
          {(() => {
            const s = progress.summary || {};
            const topics = Array.isArray(s.topics) ? s.topics : [];
            const daily = Array.isArray(s.daily) ? s.daily : [];
            if (topics.length === 0 && daily.length === 0) {
              return <p style={{ color: "#888" }}>（暂无进度摘要，孩子端学习后再次查询即可看到）</p>;
            }
            return (
              <>
                {topics.length > 0 && (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ color: "#667eea" }}>
                        <th style={{ textAlign: "left", padding: "4px 8px" }}>主题</th>
                        <th style={{ textAlign: "center", padding: "4px 8px" }}>已完成</th>
                        <th style={{ textAlign: "center", padding: "4px 8px" }}>课程数</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topics.map((t: any) => (
                        <tr key={t.file || t.name}>
                          <td style={{ padding: "4px 8px" }}>{t.name}</td>
                          <td style={{ textAlign: "center", padding: "4px 8px" }}>{t.done}</td>
                          <td style={{ textAlign: "center", padding: "4px 8px" }}>{t.courses}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {daily.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    {daily.map((d: any) => (
                      <p key={d.date} style={{ margin: "2px 0", color: "#444" }}>
                        <b>{d.date}</b>：{d.summary}
                      </p>
                    ))}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      <h4 style={{ fontSize: 15, marginBottom: 8 }}>定时备份</h4>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 14 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          启用
        </label>
        <span style={{ fontSize: 14 }}>每天</span>
        <input
          type="number"
          min={0}
          max={23}
          value={hour}
          onChange={(e) => setHour(e.target.value)}
          style={{ width: 64, padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        />
        <span style={{ fontSize: 14 }}>:</span>
        <input
          type="number"
          min={0}
          max={59}
          value={minute}
          onChange={(e) => setMinute(e.target.value)}
          style={{ width: 64, padding: 8, border: "1px solid #ddd", borderRadius: 8 }}
        />
        <IconButton icon={FolderOpen} title="选择目录" style={ghost} onClick={handlePickDir} />
        <IconButton icon={Save} title="保存" style={btn} onClick={handleSaveConfig} />
      </div>
      <p style={{ fontSize: 13, color: "#888", marginTop: 8 }}>
        {destDir ? `备份目录：${destDir}` : "尚未选择备份目录（定时备份需要先选择目录）"}
      </p>
    </div>
  );
}

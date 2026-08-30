import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import { Database, FolderOpen, Save, Undo2 } from "lucide-react";

/**
 * 数据备份 / 恢复设置（ISSUE-003：备份的是**服务端用户数据**）。
 * - 一键备份：向服务端拉取该家长的数据（家长库 + 每个孩子的学习库：课程/进度/生活记录）
 *   打包为 zip，保存到用户指定目录。
 * - 从备份恢复：选择本地 zip 上传到服务端覆盖其数据；**服务端恢复前会自动先备份当前数据**。
 * - 定时备份：每天在设定时间自动执行一次「一键备份」到指定目录（需先选定目录）。
 * 不含：账号/鉴权、模型 API key、登录凭证、材料大文件。
 */
export default function BackupSettings() {
  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState("22");
  const [minute, setMinute] = useState("30");
  const [destDir, setDestDir] = useState("");
  const [busy, setBusy] = useState<"" | "backup" | "restore">("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    window.api.backupConfigGet().then((cfg: any) => {
      if (!cfg) return;
      setEnabled(!!cfg.enabled);
      setHour(String(cfg.hour ?? 22).padStart(2, "0"));
      setMinute(String(cfg.minute ?? 30).padStart(2, "0"));
      setDestDir(cfg.destDir || "");
    });
  }, []);

  const fmtBytes = (n: number) =>
    n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

  async function handleBackup() {
    setBusy("backup");
    setMsg(null);
    const r = await window.api.createBackup();
    setBusy("");
    if (r.success) {
      setMsg({ ok: true, text: `备份完成：${r.file}（${r.bytes ? fmtBytes(r.bytes) : `${r.count} 个文件`}）` });
    } else if (r.canceled) {
      setMsg({ ok: true, text: "已取消" });
    } else {
      setMsg({ ok: false, text: `备份失败：${r.error}` });
    }
  }

  async function handleRestore() {
    const c = await window.api.confirmDialog({
      title: "恢复备份",
      message: "将用备份文件覆盖服务端当前数据（课程、进度、生活记录等）。",
      detail: "恢复前服务端会自动先备份当前数据（可回滚）。模型 API key 与登录凭证不受影响。是否继续？",
      confirmLabel: "继续恢复",
      cancelLabel: "取消",
    });
    if (!c.confirmed) return;
    setBusy("restore");
    setMsg(null);
    const r = await window.api.restoreBackup();
    setBusy("");
    if (r.success) {
      const skip = Array.isArray(r.skipped) && r.skipped.length > 0 ? `（跳过 ${r.skipped.length} 个不适用条目）` : "";
      const pre = r.preRestore ? `（服务端已自动备份恢复前数据）` : "";
      setMsg({ ok: true, text: `恢复完成：${r.restored} 个文件${skip}${pre}` });
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
        备份的是<b>服务端数据</b>（家长课程库 + 每个孩子的学习库：课程 / 进度 / 生活记录），打包为
        zip 文件保存到本机。不包含账号、模型 API key、登录凭证与材料大文件。恢复时服务端会先自动备份当前数据。
      </p>

      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <IconButton icon={Database} title="立即备份（服务端数据 → 本地 zip）" style={btn} disabled={busy !== ""} onClick={handleBackup} />
        <IconButton icon={Undo2} title="从备份恢复（上传 zip 覆盖服务端）" style={ghost} disabled={busy !== ""} onClick={handleRestore} />
      </div>

      {msg && (
        <p style={{ fontSize: 13, color: msg.ok ? "#0f6e56" : "#a32d2d", marginBottom: 16 }}>
          {msg.text}
        </p>
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

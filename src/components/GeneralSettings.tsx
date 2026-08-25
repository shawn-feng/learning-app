import { useState, useEffect } from "react";
import IconButton from "./IconButton";
import { Download, Power, RefreshCw, Save } from "lucide-react";

// ISSUE-040: 通用设置页新增「软件更新」区块（手动检查 / 下载进度 / 重启安装）。
// 状态机来自主进程 updater.ts，经 window.api.onUpdateStatus / onUpdateProgress 事件驱动；
// 所有派生 UI 均基于 state 渲染，不依赖 setState 闭包同步读取。
export default function GeneralSettings() {
  const [limit, setLimit] = useState(20);
  const [msg, setMsg] = useState("");

  // ---- 软件更新状态 ----
  const [appVersion, setAppVersion] = useState("");
  const [updStatus, setUpdStatus] = useState<string>("idle");
  const [updInfo, setUpdInfo] = useState<any>(null);
  const [updError, setUpdError] = useState("");
  const [updProgress, setUpdProgress] = useState<number | null>(null);
  const [updSpeed, setUpdSpeed] = useState(0);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    window.api.materialsLimitGet().then((r: any) => {
      if (r?.success && typeof r.limit === "number") setLimit(r.limit);
    });
    // 当前版本号：主进程 app.getVersion()（package.json），与云端对比的基准
    window.api.getAppVersion().then((r: any) => {
      if (r?.success) setAppVersion(r.version);
    }).catch(() => {});
  }, []);

  // 监听主进程更新状态/进度事件；组件卸载时取消监听
  useEffect(() => {
    const offStatus = window.api.onUpdateStatus((d: any) => {
      setUpdStatus(d?.status || "idle");
      setUpdInfo(d?.info || null);
      setUpdError(d?.error || "");
      setChecking(d?.status === "checking");
    });
    const offProgress = window.api.onUpdateProgress((d: any) => {
      if (d && typeof d.percent === "number") {
        setUpdProgress(d.percent);
        setUpdSpeed(d.bytesPerSecond || 0);
      }
    });
    return () => {
      offStatus();
      offProgress();
    };
  }, []);

  async function checkUpdate() {
    setMsg("");
    setUpdStatus("checking");
    setChecking(true);
    setUpdProgress(null);
    setUpdError("");
    const r = await window.api.checkUpdate();
    // 主进程事件流会推送状态；这里兜底处理「无事件」分支（如开发模式 disabled）
    if (!r?.ok && r?.status === "disabled") {
      setUpdStatus("disabled");
      setChecking(false);
    }
  }

  function save() {
    const n = parseInt(String(limit), 10);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg("请输入正整数");
      return;
    }
    window.api.materialsLimitSet(n).then((r: any) => {
      if (r?.success) {
        setLimit(r.limit);
        setMsg("已保存");
      } else {
        setMsg(r.error || "保存失败");
      }
    });
  }

  const downloading = updStatus === "downloading";
  const busy = checking || downloading;

  return (
    <div className="settings-section">
      <h3>通用设置</h3>
      <p className="desc">调整学习伙伴的通用行为。</p>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          学习资料保留数量
        </label>
        <p style={{ fontSize: 13, color: "#888", margin: "0 0 8px", lineHeight: 1.6 }}>
          孩子模式左侧「学习资料」列表最多保留多少份资料；超出后只保留最近的一份。退出再进入时资料也会保留（除非会话被重置）。默认 20。
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <input
            type="number"
            min={1}
            value={limit}
            onChange={(e) => setLimit(parseInt(e.target.value, 10) || 1)}
            style={{ width: 120, padding: 10, border: "1px solid #ddd", borderRadius: 8 }}
          />
          <IconButton
            icon={Save}
            title="保存"
            onClick={save}
            style={{ padding: "10px 20px", background: "#667eea", color: "white", border: "none", borderRadius: 8 }}
          />
        </div>
        {msg && (
          <p style={{ fontSize: 13, color: msg === "已保存" ? "#48bb78" : "red", marginTop: 8 }}>
            {msg}
          </p>
        )}
      </div>

      {/* ISSUE-040: 软件更新（electron-updater 自动更新，安装包托管阿里云 OSS） */}
      <div style={{ paddingTop: 16, borderTop: "1px solid #eee" }}>
        <h4 style={{ fontSize: 15, marginBottom: 4 }}>软件更新</h4>
        <p style={{ fontSize: 13, color: "#888", margin: "0 0 8px", lineHeight: 1.6 }}>
          当前版本 <b>{appVersion || "…"}</b>。检查并安装最新版本（差量下载，升级不影响本地数据）。
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <IconButton
            icon={RefreshCw}
            title="检查更新"
            onClick={checkUpdate}
            disabled={busy}
            style={{
              padding: "10px 20px",
              background: busy ? "#ddd" : "#667eea",
              color: busy ? "#666" : "white",
              border: "none",
              borderRadius: 8,
              cursor: busy ? "default" : "pointer",
            }}
          />
          {updStatus === "available" && (
            <IconButton
              icon={Download}
              title="开始下载"
              onClick={() => window.api.downloadUpdate()}
              style={{ padding: "10px 20px", background: "#f0f4ff", color: "#667eea", border: "none", borderRadius: 8, cursor: "pointer" }}
            />
          )}
          {updStatus === "downloaded" && (
            <IconButton
              icon={Power}
              title="重启并安装"
              onClick={() => window.api.quitAndInstall()}
              style={{ padding: "10px 20px", background: "#48bb78", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}
            />
          )}
        </div>

        {updStatus === "not-available" && (
          <p style={{ fontSize: 13, color: "#48bb78", marginTop: 8 }}>
            已是最新版本（v{appVersion}）。
          </p>
        )}
        {updStatus === "available" && (
          <p style={{ fontSize: 13, color: "#667eea", marginTop: 8 }}>
            发现新版本 v{updInfo?.version || ""}，正在下载…
          </p>
        )}
        {updStatus === "downloading" && updProgress !== null && (
          <div style={{ marginTop: 8 }}>
            <div style={{ background: "#eee", borderRadius: 6, height: 8, overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.min(100, Math.max(0, updProgress))}%`,
                  background: "#667eea",
                  height: "100%",
                  transition: "width 0.2s",
                }}
              />
            </div>
            <p style={{ fontSize: 12, color: "#888", marginTop: 6 }}>
              {updProgress.toFixed(1)}%（{formatBytes(updSpeed)}/s）
            </p>
          </div>
        )}
        {updStatus === "downloaded" && (
          <p style={{ fontSize: 13, color: "#48bb78", marginTop: 8 }}>
            新版本 v{updInfo?.version || ""} 已下载完成，点击「重启并安装」完成升级。
          </p>
        )}
        {updStatus === "error" && (
          <p style={{ fontSize: 13, color: "red", marginTop: 8 }}>
            更新失败：{updError || "未知错误"}。请稍后重试，或到官网手动下载安装。
          </p>
        )}
        {updStatus === "disabled" && (
          <p style={{ fontSize: 13, color: "#888", marginTop: 8 }}>当前环境（开发模式）不支持自动更新。</p>
        )}
      </div>
    </div>
  );
}

function formatBytes(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "0 KB";
  if (bps < 1024) return `${bps} B`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB`;
  return `${(bps / 1024 / 1024).toFixed(1)} MB`;
}

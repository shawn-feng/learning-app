import { useState } from "react";

export default function SkillImport() {
  const [skills, setSkills] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [importing, setImporting] = useState(false);

  useState(() => {
    window.api.skillsList().then((list: string[]) => setSkills(list));
  });

  async function handleSelectFolder() {
    setMessage("");
    setImporting(true);
    try {
      const result = await window.api.skillImportFolder();
      if (result?.success) {
        setMessage(`技能已导入: ${result.name}`);
        const list = await window.api.skillsList();
        setSkills(list);
      } else if (result?.cancelled) {
        // user cancelled
      } else {
        setMessage(result?.error || "导入失败");
      }
    } catch (e: any) {
      setMessage(e.message || "导入失败");
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="settings-section">
      <h3>技能管理</h3>
      <p className="desc">
        从本地导入预制 Skill 包，安装到共享技能目录，所有孩子立即可用。
      </p>

      <div className="import-drop" onClick={handleSelectFolder}>
        {importing ? "导入中..." : "📁 点击选择 Skill 文件夹"}
      </div>

      {message && (
        <p style={{ marginTop: 12, fontSize: 13, color: "#667eea" }}>{message}</p>
      )}

      <h4 style={{ marginTop: 24, marginBottom: 12, fontSize: 15 }}>已安装技能</h4>
      {skills.length === 0 ? (
        <p style={{ color: "#888", fontSize: 13 }}>暂无技能</p>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {skills.map((s) => (
            <div
              key={s}
              style={{
                padding: "8px 14px",
                background: "#f0f4ff",
                borderRadius: 8,
                fontSize: 13,
                color: "#667eea",
              }}
            >
              {s}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

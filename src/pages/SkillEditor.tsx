import { useState, useEffect } from "react";
import ChatWindow, { type ChatMessage, nowTime } from "../components/ChatWindow";

export default function SkillEditor() {
  const [skills, setSkills] = useState<string[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.skillsList().then((list: string[]) => setSkills(list));
    window.api.piStartParent();
  }, []);

  useEffect(() => {
    window.api.onPiStreaming((data: any) => {
      if (data.childId !== "parent") return;
      setMessages((prev) => {
        const clone = [...prev];
        const last = clone[clone.length - 1];
        if (last && last.role === "ai") {
          clone[clone.length - 1] = { ...last, text: last.text + (data.delta || "") };
        } else {
          clone.push({ id: `ai-${Date.now()}`, role: "ai", text: data.delta || "", time: nowTime() });
        }
        return clone;
      });
    });
    window.api.onPiAgentEnd((data: any) => {
      if (data.childId === "parent") setBusy(false);
    });
  }, []);

  async function selectSkill(name: string) {
    setSelectedSkill(name);
    const result = await window.api.skillRead(name, "SKILL.md");
    if (result?.success) setFileContent(result.content);
  }

  async function handleSave() {
    if (!selectedSkill) return;
    const result = await window.api.skillWrite(selectedSkill, "SKILL.md", fileContent);
    if (result?.success) alert("已保存");
  }

  async function handleSend(text: string) {
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text, time: nowTime() }]);
    setBusy(true);
    try {
      await window.api.piPromptParent(text);
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)" }}>
      <h3>技能编辑器</h3>
      <p className="desc">
        左侧选择技能文件，右侧编辑内容。底部可以与 AI 对话，让它帮你创建或调整技能。
      </p>

      <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 16 }}>
        <div style={{ width: 180, borderRight: "1px solid #eee", overflowY: "auto" }}>
          {skills.map((s) => (
            <div
              key={s}
              onClick={() => selectSkill(s)}
              style={{
                padding: "10px 12px",
                cursor: "pointer",
                background: selectedSkill === s ? "#f0f4ff" : "transparent",
                borderRadius: 8,
                marginBottom: 4,
                fontSize: 14,
              }}
            >
              {s}
            </div>
          ))}
          {skills.length === 0 && (
            <p style={{ color: "#888", fontSize: 12, padding: 12 }}>暂无技能</p>
          )}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {selectedSkill ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>{selectedSkill}/SKILL.md</strong>
                <button
                  onClick={handleSave}
                  style={{
                    padding: "6px 16px",
                    background: "#667eea",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    fontSize: 13,
                  }}
                >
                  保存
                </button>
              </div>
              <textarea
                value={fileContent}
                onChange={(e) => setFileContent(e.target.value)}
                style={{
                  flex: 1,
                  fontFamily: "monospace",
                  fontSize: 13,
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: 12,
                  resize: "none",
                  minHeight: 200,
                }}
              />
            </>
          ) : (
            <div style={{ color: "#888", fontSize: 13, textAlign: "center", marginTop: 40 }}>
              选择左侧技能开始编辑
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 }}>
        <ChatWindow
          messages={messages}
          onSend={handleSend}
          disabled={busy}
        />
      </div>
    </div>
  );
}

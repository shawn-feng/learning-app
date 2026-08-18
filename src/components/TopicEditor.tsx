import { useState, useEffect } from "react";
import ChatWindow, { type ChatMessage } from "../components/ChatWindow";

interface ChildInfo {
  childId: string;
  name: string;
}

interface TopicEntry {
  topic: string;
  files: string[];
  subdirs: string[];
}

export default function TopicEditor() {
  const [children, setChildren] = useState<ChildInfo[]>([]);
  const [childId, setChildId] = useState<string | null>(null);
  const [rootFiles, setRootFiles] = useState<string[]>([]);
  const [topics, setTopics] = useState<TopicEntry[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null); // 相对 learning/ 的路径
  const [fileContent, setFileContent] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.childList().then((list: ChildInfo[]) => {
      setChildren(list || []);
      if (list?.length) setChildId(list[0].childId);
    });
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
          clone.push({ id: `ai-${Date.now()}`, role: "ai", text: data.delta || "" });
        }
        return clone;
      });
    });
    window.api.onPiAgentEnd((data: any) => {
      if (data.childId === "parent") setBusy(false);
    });
  }, []);

  useEffect(() => {
    if (!childId) return;
    setSelectedFile(null);
    setFileContent("");
    window.api.learningList(childId).then((r: any) => {
      if (r?.success) {
        setRootFiles(r.rootFiles || []);
        setTopics(r.topics || []);
      }
    });
  }, [childId]);

  const currentChild = children.find((c) => c.childId === childId);

  async function openFile(relPath: string) {
    if (!childId) return;
    setSelectedFile(relPath);
    const r = await window.api.learningRead(childId, relPath);
    if (r?.success) setFileContent(r.content || "");
  }

  async function handleSave() {
    if (!childId || !selectedFile) return;
    const r = await window.api.learningWrite(childId, selectedFile, fileContent);
    if (r?.success) alert("已保存");
  }

  async function handleSend(text: string) {
    let full = text;
    if (messages.length === 0 && currentChild) {
      full = `当前选中的孩子是「${currentChild.name}」（childId=${currentChild.childId}）。${text}`;
    }
    setMessages((prev) => [...prev, { id: `u-${Date.now()}`, role: "user", text }]);
    setBusy(true);
    try {
      await window.api.piPromptParent(full);
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)" }}>
      <h3>教学内容</h3>
      <p className="desc">
        选择孩子查看其学习主题文件，底部与 AI 对话，让它引导你生成进度文件、教学方法、每课文案等。
      </p>

      <div style={{ marginBottom: 12 }}>
        <label style={{ fontSize: 13, marginRight: 8 }}>孩子：</label>
        <select
          value={childId || ""}
          onChange={(e) => setChildId(e.target.value)}
          style={{ padding: "6px 10px", borderRadius: 6, fontSize: 13 }}
        >
          {children.map((c) => (
            <option key={c.childId} value={c.childId}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div style={{ display: "flex", flex: 1, minHeight: 0, gap: 16 }}>
        <div style={{ width: 220, borderRight: "1px solid #eee", overflowY: "auto", paddingRight: 8 }}>
          <div style={{ fontSize: 12, color: "#888", marginBottom: 4 }}>学习根目录</div>
          {rootFiles.map((f) => (
            <FileRow key={f} label={f} active={selectedFile === f} onClick={() => openFile(f)} />
          ))}

          {topics.map((t) => (
            <div key={t.topic} style={{ marginTop: 8 }}>
              <div style={{ fontSize: 12, color: "#888", marginBottom: 4, fontWeight: 600 }}>📁 {t.topic}</div>
              {t.files.map((f) => {
                const rel = `${t.topic}/${f}`;
                return <FileRow key={rel} label={f} active={selectedFile === rel} onClick={() => openFile(rel)} />;
              })}
              {t.subdirs.length > 0 && (
                <div style={{ fontSize: 11, color: "#bbb", paddingLeft: 12, marginTop: 2 }}>
                  {t.subdirs.map((d) => `📂 ${d}/`).join("  ")}
                </div>
              )}
            </div>
          ))}

          {rootFiles.length === 0 && topics.length === 0 && (
            <p style={{ color: "#888", fontSize: 12, padding: 12 }}>该孩子暂无学习主题</p>
          )}
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {selectedFile ? (
            <>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>{selectedFile}</strong>
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
              选择左侧文件查看/编辑，或在下方对话让 AI 引导生成
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16, borderTop: "1px solid #eee", paddingTop: 12 }}>
        <ChatWindow messages={messages} onSend={handleSend} disabled={busy} />
      </div>
    </div>
  );
}

function FileRow({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      style={{
        padding: "7px 12px",
        cursor: "pointer",
        background: active ? "#f0f4ff" : "transparent",
        borderRadius: 6,
        marginBottom: 2,
        fontSize: 13,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </div>
  );
}

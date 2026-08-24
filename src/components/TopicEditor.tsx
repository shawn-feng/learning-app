import { useState, useEffect, useRef, useCallback } from "react";
import ChatWindow, { type ChatMessage, type ToolCallState, nowTime } from "../components/ChatWindow";

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
  // 当前正在工作的 AI 消息 id（思考/工具/正式回复都更新到同一气泡，与孩子聊天界面一致）
  const workingIdRef = useRef<string | null>(null);

  // 更新当前工作气泡（按 id 定位）
  const patchWorking = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const id = workingIdRef.current;
    if (!id) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  useEffect(() => {
    window.api.childList().then((list: ChildInfo[]) => {
      setChildren(list || []);
      if (list?.length) setChildId(list[0].childId);
    });
    // ISSUE-026：本页使用「教学内容生成专用会话」（专门提示词，与通用家长助手解耦）
    // ISSUE-037：会话初始化结果显式检查，失败提示，禁止静默吞错
    window.api
      .piStartParentContent()
      .then((r: any) => {
        if (!r?.success) {
          setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ AI 会话初始化失败：${r?.error || "未知错误"}`, time: nowTime() }]);
        }
      })
      .catch((e: any) => {
        setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ AI 会话初始化失败：${e?.message || e}`, time: nowTime() }]);
      });
  }, []);

  useEffect(() => {
    // 流式文本：working 气泡期间累积（working 态不显示正文，reply 时整体替换）
    window.api.onPiStreaming((data: any) => {
      if (data.childId !== "parent-content") return;
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
      if (data.childId === "parent-content") setBusy(false);
    });
    // 思考增量（主进程已节流）——在 working 气泡里实时展示
    window.api.onPiThinking((data: any) => {
      if (data.childId !== "parent-content") return;
      patchWorking((m) => ({ ...m, thinking: (m.thinking || "") + data.delta }));
    });
    // 工具开始调用
    window.api.onPiToolStart((data: any) => {
      if (data.childId !== "parent-content") return;
      const call: ToolCallState = {
        id: data.toolCallId || `tool-${Date.now()}`,
        name: data.toolName,
        argsPreview: data.argsPreview,
        status: "running",
      };
      patchWorking((m) => ({ ...m, tools: [...(m.tools || []), call] }));
    });
    // 工具结束调用：更新对应工具状态
    window.api.onPiToolEnd((data: any) => {
      if (data.childId !== "parent-content") return;
      patchWorking((m) => ({
        ...m,
        tools: (m.tools || []).map((t) =>
          t.id === data.toolCallId
            ? { ...t, status: data.isError ? ("error" as const) : ("done" as const), resultPreview: data.resultPreview }
            : t
        ),
      }));
    });
    // 正式回复：替换 working 气泡为最终文本（与孩子聊天界面一致）
    window.api.onPiReply((data: any) => {
      if (data.childId !== "parent-content") return;
      const id = workingIdRef.current;
      workingIdRef.current = null;
      setMessages((prev) => {
        if (id && prev.some((m) => m.id === id)) {
          return prev.map((m) => (m.id === id ? { ...m, text: data.text, working: false } : m));
        }
        const clone = [...prev];
        const last = clone[clone.length - 1];
        if (last && last.role === "ai") {
          clone[clone.length - 1] = { ...last, text: data.text, working: false };
        } else {
          clone.push({ id: `ai-${Date.now()}`, role: "ai", text: data.text, time: nowTime() });
        }
        return clone;
      });
      setBusy(false);
    });
    window.api.onPiReplyEnd((data: any) => {
      if (data.childId === "parent-content") setBusy(false);
    });
    // 回复错误：替换 working 气泡为错误提示
    window.api.onPiReplyError((data: any) => {
      if (data.childId !== "parent-content") return;
      const id = workingIdRef.current;
      workingIdRef.current = null;
      setMessages((prev) => {
        if (id && prev.some((m) => m.id === id)) {
          return prev.map((m) => (m.id === id ? { ...m, text: `⚠️ ${data.error}`, working: false } : m));
        }
        const clone = [...prev];
        const last = clone[clone.length - 1];
        if (last && last.role === "ai") {
          clone[clone.length - 1] = { ...last, text: `⚠️ ${data.error}`, working: false };
        } else {
          clone.push({ id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${data.error}`, time: nowTime() });
        }
        return clone;
      });
      setBusy(false);
    });
    // SDK 会话级错误事件兜底提示
    window.api.onPiError((error: string) => {
      setBusy(false);
      setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${error}`, time: nowTime() }]);
    });
  }, [patchWorking]);

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

  async function handleSend(text: string) {
    let full = text;
    if (messages.length === 0 && currentChild) {
      full = `当前选中的孩子是「${currentChild.name}」（childId=${currentChild.childId}）。${text}`;
    }
    // ISSUE-026：把当前查看的文件内容作为上下文带给 AI，便于针对该文件生成/改写
    if (selectedFile) {
      full = `${full}\n\n【当前正在查看的文件：${selectedFile}】\n${fileContent}`;
    }
    // 发送：创建用户气泡 + AI working 气泡（思考/工具/正式回复都进这一条，与孩子聊天界面一致）
    const workingId = `ai-${Date.now()}`;
    workingIdRef.current = workingId;
    setMessages((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", text, time: nowTime() },
      { id: workingId, role: "ai", text: "", thinking: "", tools: [], working: true, time: nowTime() },
    ]);
    setBusy(true);
    try {
      const r: any = await window.api.piPromptParentContent(full);
      // ISSUE-037：检查返回值 success，失败显式提示（主进程把错误包在返回值而非抛异常）
      if (!r?.success) {
        const id = workingIdRef.current;
        workingIdRef.current = null;
        if (id) {
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, text: `⚠️ ${r?.error || "发送失败，请重试"}`, working: false } : m))
          );
        } else {
          setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${r?.error || "发送失败，请重试"}`, time: nowTime() }]);
        }
        setBusy(false);
      }
    } catch (e: any) {
      const id = workingIdRef.current;
      workingIdRef.current = null;
      if (id) {
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, text: `⚠️ ${e?.message || "发送失败，请重试"}`, working: false } : m))
        );
      } else {
        setMessages((prev) => [...prev, { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${e?.message || "发送失败，请重试"}`, time: nowTime() }]);
      }
      setBusy(false);
    }
  }

  return (
    // ISSUE-037 续：flex:1 + min-height:0 + overflow:hidden 撑满 Settings tab（已 flex column），
    // 替代 calc(100vh - 180px) 估算高度（估算偏差会把页面拉长、聊天区无法独立滚动）。
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <h3>教学内容</h3>
      <p className="desc">
        左侧选择孩子并查看其学习主题文件（只读预览），右侧与 AI 沟通，让它引导你生成进度文件、教学方法、每课文案等。
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
        {/* 左栏：目录树 + 文件只读预览 */}
        <div
          style={{
            width: 380,
            display: "flex",
            flexDirection: "column",
            borderRight: "1px solid #eee",
            paddingRight: 8,
            minWidth: 0,
          }}
        >
          <div style={{ overflowY: "auto", flexShrink: 0, maxHeight: "45%" }}>
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

          <div style={{ flex: 1, overflowY: "auto", borderTop: "1px solid #eee", marginTop: 8, paddingTop: 8, minHeight: 0 }}>
            {selectedFile ? (
              <>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{selectedFile}</div>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    fontFamily: "monospace",
                    fontSize: 12,
                    margin: 0,
                    color: "#333",
                  }}
                >
                  {fileContent}
                </pre>
              </>
            ) : (
              <div style={{ color: "#888", fontSize: 13, textAlign: "center", marginTop: 20 }}>
                选择左侧文件查看预览，或在右侧对话让 AI 引导生成
              </div>
            )}
          </div>
        </div>

        {/* 右栏：与 AI 沟通 */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <ChatWindow messages={messages} onSend={handleSend} disabled={busy} />
        </div>
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

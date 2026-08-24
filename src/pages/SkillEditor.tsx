import { useState, useEffect, useRef, useCallback } from "react";
import ChatWindow, { type ChatMessage, type ToolCallState, nowTime } from "../components/ChatWindow";

export default function SkillEditor() {
  const [skills, setSkills] = useState<string[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | null>(null);
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
    window.api.skillsList().then((list: string[]) => setSkills(list));
    // ISSUE-037：会话初始化结果显式检查，失败提示，禁止静默吞错
    window.api
      .piStartParent()
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
    // 思考增量（主进程已节流）——在 working 气泡里实时展示
    window.api.onPiThinking((data: any) => {
      if (data.childId !== "parent") return;
      patchWorking((m) => ({ ...m, thinking: (m.thinking || "") + data.delta }));
    });
    // 工具开始调用
    window.api.onPiToolStart((data: any) => {
      if (data.childId !== "parent") return;
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
      if (data.childId !== "parent") return;
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
      if (data.childId !== "parent") return;
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
      if (data.childId === "parent") setBusy(false);
    });
    // 回复错误：替换 working 气泡为错误提示
    window.api.onPiReplyError((data: any) => {
      if (data.childId !== "parent") return;
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
  }, [patchWorking]);

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
      const r: any = await window.api.piPromptParent(text);
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
    // ISSUE-037 续：flex:1 + min-height:0 + overflow:hidden 撑满可视区（若将来重新启用该页），
    // 替代 calc(100vh - 180px) 估算高度（估算偏差会把页面拉长、聊天区无法独立滚动）。
    <div className="settings-section" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
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

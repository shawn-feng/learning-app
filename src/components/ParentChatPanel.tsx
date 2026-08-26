import { useState, useEffect, useRef, useCallback } from "react";
import ChatWindow, { type ChatMessage, type ToolCallState, nowTime } from "./ChatWindow";

/**
 * 家长中心右侧常驻聊天面板（ISSUE-050）：
 * 对接通用家长会话（pi:start_parent / pi:prompt_parent，childId="parent"），
 * 家长可在任意管理页面右侧直接与 agent 对话（建课、改资料、答疑等）。
 *
 * 事件处理模式与 SkillEditor 一致：思考/工具/正式回复都更新到同一个 working 气泡；
 * ChatWindow 传 owner="parent"，附件上传/打开走 data/parents/<pid>/uploads/（ISSUE-044）。
 */
export default function ParentChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  // 当前正在工作的 AI 消息 id（思考/工具/正式回复都更新到同一气泡）
  const workingIdRef = useRef<string | null>(null);

  // 更新当前工作气泡（按 id 定位）
  const patchWorking = useCallback((patch: (m: ChatMessage) => ChatMessage) => {
    const id = workingIdRef.current;
    if (!id) return;
    setMessages((prev) => prev.map((m) => (m.id === id ? patch(m) : m)));
  }, []);

  useEffect(() => {
    // ISSUE-037：会话初始化结果显式检查，失败提示，禁止静默吞错
    window.api
      .piStartParent()
      .then((r: any) => {
        if (!r?.success) {
          setMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ AI 会话初始化失败：${r?.error || "未知错误"}`, time: nowTime() },
          ]);
        }
      })
      .catch((e: any) => {
        setMessages((prev) => [
          ...prev,
          { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ AI 会话初始化失败：${e?.message || e}`, time: nowTime() },
        ]);
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
    // 回复错误：替换 working 气泡为错误提示（不再静默）
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
    // SDK 会话级错误事件兜底提示
    window.api.onPiError((error: string) => {
      setBusy(false);
    });
  }, [patchWorking]);

  async function handleSend(text: string) {
    // 发送：创建用户气泡 + AI working 气泡（思考/工具/正式回复都进这一条）
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
      // ISSUE-037：主进程把错误包在返回值里（{success:false}）而不是抛异常——必须显式检查
      if (!r?.success) {
        const id = workingIdRef.current;
        workingIdRef.current = null;
        if (id) {
          setMessages((prev) =>
            prev.map((m) => (m.id === id ? { ...m, text: `⚠️ ${r?.error || "发送失败，请重试"}`, working: false } : m))
          );
        } else {
          setMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${r?.error || "发送失败，请重试"}`, time: nowTime() },
          ]);
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
        setMessages((prev) => [
          ...prev,
          { id: `ai-${Date.now()}`, role: "ai", text: `⚠️ ${e?.message || "发送失败，请重试"}`, time: nowTime() },
        ]);
      }
      setBusy(false);
    }
  }

  return (
    <div className="parent-chat-panel">
      <div className="parent-chat-title">家长助手</div>
      <ChatWindow messages={messages} onSend={handleSend} disabled={busy} owner="parent" />
    </div>
  );
}

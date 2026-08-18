import path from "path";

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName: string = event.toolName;
    if (!["read", "write", "edit"].includes(toolName)) return;

    const inputPath: string | undefined = event.input?.path;
    if (!inputPath) return;

    const cwd: string = ctx.cwd;
    const resolved = path.resolve(cwd, inputPath);

    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      return { block: true, reason: "路径超出工作空间范围" };
    }
  });

  // 每轮对话动态注入当前日期。
  // 根因：get_date 工具是"按需调用"的，AI 跨天可能复用旧日期（实测：8/14 调过一次，
  // 8/15 就沿用旧值 8/14）。这里每轮都注入，且 SDK 传的是 _baseSystemPrompt（不含上轮
  // 修改），不会累积；返回的 systemPrompt 只作用于本轮。
  // 注意：只注入「日期+星期」、不注入时分秒——system prompt 是 LLM 前缀缓存（DeepSeek
  // context caching 自动命中）的公共前缀，若精确到秒，每轮 system prompt 都变，导致
  // 其后全部历史消息每轮都无法命中缓存（首 token 变慢、input 成本按全价计）。只注入
  // 日期则同一天内 system prompt 完全稳定，缓存正常；跨天只变一次。精确时间（几点几分）
  // 由 get_date 工具在需要时提供。
  pi.on("before_agent_start", async (event: any) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const weekday = weekdays[d.getDay()];

    const note = `\n\n## 当前日期\n今天是 ${dateStr}（${weekday}）。\n当你需要日期时（写 daily 日志、更新进度文件的日期字段、回答"今天几号/星期几"等）一律以这里给出的日期为准，不要使用对话历史里出现过的旧日期；当需要精确到几点几分时，调用 get_date 工具获取当前时间。`;

    return { systemPrompt: (event.systemPrompt || "") + note };
  });
}

/**
 * learning-guard 扩展（唯一真源，2026-09-12 自 electron/extensions 上移）。
 *
 * 两件事（都是「会话级红线」，不能靠模型自觉）：
 * 1. **文件工具越界拦截**：read/write/edit/ls 的 path 解析后必须落在会话 cwd 内，
 *    否则 block。服务端场景下 cwd = 孩子/家长工作区，等价于再做一层与路径沙箱并行的兜底
 *    （工具实现里已校验一次；这里挡的是 SDK 内置 read/write/edit 这类不经过我们实现的工具）。
 * 2. **每轮注入当前日期**：`get_date` 是按需调用的，模型跨天可能复用旧日期（实测 8/14 调过一次、
 *    8/15 沿用旧值）。每轮注入且只注入「日期+星期」——system prompt 是前缀缓存的公共前缀，
 *    若注入精确到秒会导致其后全部历史每轮都无法命中缓存（首 token 变慢、input 按全价计）。
 *
 * 本扩展不发任何网络/文件副作用，也不 import electron，故两端共用同一份。
 */
import path from "node:path";

const FS_TOOLS = ["read", "write", "edit", "ls"];

export default function learningGuard(pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const toolName: string = event?.toolName;
    if (!FS_TOOLS.includes(toolName)) return;

    const inputPath: string | undefined = event?.input?.path;
    if (!inputPath) return;

    const cwd: string = ctx?.cwd ?? "";
    if (!cwd) return;
    const resolved = path.resolve(cwd, inputPath);
    if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
      return { block: true, reason: "路径超出工作空间范围" };
    }
  });

  pi.on("before_agent_start", async (event: any) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const weekdays = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
    const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const weekday = weekdays[d.getDay()];
    const note = `\n\n## 当前日期\n今天是 ${dateStr}（${weekday}）。\n当你需要日期时（写 daily 记录、更新课程时间字段（首次学习/最近复习）、回答"今天几号/星期几"等）一律以这里给出的日期为准，不要使用对话历史里出现过的旧日期；当需要精确到几点几分时，调用 get_date 工具获取当前时间。`;
    return { systemPrompt: (event?.systemPrompt || "") + note };
  });
}

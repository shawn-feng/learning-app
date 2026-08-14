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
}

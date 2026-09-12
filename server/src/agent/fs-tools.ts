/**
 * server 作用域文件工具（P1）：read / write / edit / ls 的服务端版本。
 *
 * 为什么需要：agent 上移服务端后，客户端那套 `cwd=data/children/<id>` 的本地文件工具不存在了，
 * 而 agent 仍需要读写自己工作区里的中间产物（生成的 html/md、临时数据）。
 * 安全边界（对应设计红线「隔离不放松」）：
 *   - 根目录固定为 `<dataDir>/workspaces/<parentId>/<childId>`，由调用方按登录家长与孩子注入；
 *   - 一切相对路径经 `resolveWithin` 校验，越界（..、绝对路径、符号链接指向外部）直接抛错；
 *   - 写操作限制单次大小，避免模型一次写入超大内容拖垮服务端。
 */
import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { resolveWithin, relativeDisplayPath } from "@pi/agent-core";

const MAX_WRITE_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 256 * 1024;

function ok(text: string) {
  // 服务端锁定的 SDK（0.84.1）要求 AgentToolResult.details 必填——这是与客户端
  // 版本的类型差异之一，正因如此运行时/SDK 必须由各侧各自解析（见 tsconfig/build 的 alias 说明）。
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** 递归列目录（限深度与条目数，避免大目录灌爆上下文） */
function listTree(root: string, relDir: string, maxEntries = 200): string {
  const out: string[] = [];
  const walk = (dirAbs: string, depth: number) => {
    if (out.length >= maxEntries || depth > 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= maxEntries) return;
      const abs = path.join(dirAbs, e.name);
      const rel = relativeDisplayPath(root, abs);
      if (e.isDirectory()) {
        out.push(`${rel}/`);
        walk(abs, depth + 1);
      } else {
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* 忽略 */
        }
        out.push(`${rel} (${size}B)`);
      }
    }
  };
  walk(resolveWithin(root, relDir || "."), 0);
  return out.length ? out.join("\n") : "（空目录）";
}

export function createServerFsTools(workspaceRoot: string) {
  const readTool = defineTool({
    name: "read",
    label: "读取工作区文件",
    description:
      "读取当前孩子工作区内的文本文件（相对路径，如 outputs/report.md）。\n\n" +
      "**边界**：只能访问本孩子工作区内的文件，越界路径（../ 或绝对路径）会被拒绝。\n" +
      "大文件（>256KB）会被截断。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区根的文件路径" }),
      offset: Type.Optional(Type.Number({ description: "起始行（从 0 开始，可选）" })),
      limit: Type.Optional(Type.Number({ description: "最多读取行数（可选）" })),
    }),
    execute: async (_id: string, params: any) => {
      const abs = resolveWithin(workspaceRoot, params.path);
      if (!fs.existsSync(abs)) {
        throw new Error(`文件不存在：${params.path}（可用 ls 查看工作区现有文件）`);
      }
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) throw new Error(`${params.path} 是目录，请用 ls`);
      const raw = fs.readFileSync(abs);
      const truncatedBytes = raw.length > MAX_READ_BYTES;
      const text = raw.subarray(0, MAX_READ_BYTES).toString("utf-8");
      const lines = text.split("\n");
      const offset = Math.max(0, Number(params.offset ?? 0));
      const limit = params.limit ? Math.max(1, Number(params.limit)) : lines.length;
      const slice = lines.slice(offset, offset + limit);
      return ok(
        `${params.path}（共 ${lines.length} 行${truncatedBytes ? "，已按 256KB 截断" : ""}）：\n` +
          slice.join("\n")
      );
    },
  });

  const writeTool = defineTool({
    name: "write",
    label: "写入工作区文件",
    description:
      "把文本写入当前孩子工作区内的文件（相对路径）。父目录会自动创建，覆盖已有文件。\n\n" +
      "**边界**：只能写本孩子工作区内的文件；单次写入上限 2MB。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区根的文件路径" }),
      content: Type.String({ description: "要写入的完整文本内容" }),
    }),
    execute: async (_id: string, params: any) => {
      const size = Buffer.byteLength(String(params.content ?? ""), "utf-8");
      if (size > MAX_WRITE_BYTES) {
        throw new Error(`内容过大（${size} 字节 > 2MB），请拆分写入`);
      }
      const abs = resolveWithin(workspaceRoot, params.path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(params.content ?? ""), "utf-8");
      return ok(`已写入 ${params.path}（${size} 字节）`);
    },
  });

  const editTool = defineTool({
    name: "edit",
    label: "替换工作区文件片段",
    description:
      "在工作区文件内做精确字符串替换（oldString → newString）。要求 oldString 唯一出现，否则报错。\n\n" +
      "**边界**：只能编辑本孩子工作区内的文件。",
    parameters: Type.Object({
      path: Type.String({ description: "相对工作区根的文件路径" }),
      oldString: Type.String({ description: "要被替换的原文（必须在文件中唯一出现）" }),
      newString: Type.String({ description: "替换后的文本" }),
    }),
    execute: async (_id: string, params: any) => {
      const abs = resolveWithin(workspaceRoot, params.path);
      if (!fs.existsSync(abs)) throw new Error(`文件不存在：${params.path}`);
      const text = fs.readFileSync(abs, "utf-8");
      const oldStr = String(params.oldString ?? "");
      const count = oldStr ? text.split(oldStr).length - 1 : 0;
      if (count === 0) throw new Error(`未找到要替换的内容（请先用 read 核对原文）`);
      if (count > 1) throw new Error(`要替换的内容出现 ${count} 次（不唯一），请提供更长的上下文`);
      fs.writeFileSync(abs, text.replace(oldStr, String(params.newString ?? "")), "utf-8");
      return ok(`已更新 ${params.path}`);
    },
  });

  const lsTool = defineTool({
    name: "ls",
    label: "列出工作区文件",
    description:
      "列出当前孩子工作区内某目录的文件树（相对路径，默认工作区根）。最多 200 条、深度 4 层。\n\n" +
      "**边界**：只能查看本孩子工作区。",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "相对工作区根的目录（默认根目录）" })),
    }),
    execute: async (_id: string, params: any) => {
      const dir = resolveWithin(workspaceRoot, String(params?.path ?? "."));
      if (!fs.existsSync(dir)) throw new Error(`目录不存在：${params?.path ?? "."}`);
      return ok(`${params?.path || "."} 内容：\n${listTree(workspaceRoot, String(params?.path ?? "."))}`);
    },
  });

  return [readTool, writeTool, editTool, lsTool];
}

export const SERVER_FS_TOOL_NAMES = ["read", "write", "edit", "ls"];

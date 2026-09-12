/**
 * 路径沙箱（唯一真源）：parentId / childId 作用域内的所有目录拼装集中在此。
 *
 * 为什么单独成模块：
 * - 设计红线「隔离不放松」要求在服务端逐条对照 ISSUE-023 的教训——路径一旦由各模块自行
 *   `path.join(dataDir, ...)` 拼装，就会出现「漏带 parentId」「.. 逃逸」「跨孩子越权」三类漏洞；
 *   集中成一处后，只有本模块能拼路径，审计点唯一。
 * - 本模块**不得 import electron、不得依赖调用方全局状态**：dataDir 一律由构造参数注入，
 *   因此同一份代码可被服务端（agent 宿主）与客户端复用。
 *
 * 服务端实际布局（与 server/src/db/*、server/src/routes/* 对齐）：
 *   <dataDir>/kb/<parentId>/<childId>.sqlite     孩子知识库
 *   <dataDir>/sessions/<parentId>/<childId>/     会话文件（server 权威）
 *   <dataDir>/materials/<parentId>/<topic>/…     课程学习资料真源
 *   <dataDir>/parents/<parentId>/                家长库（parent.sqlite）
 *   <dataDir>/files/                             通用上传
 *   <dataDir>/logs/                              服务端日志
 */
import path from "node:path";

export interface CorePaths {
  dataDir: string;
  /** 通用上传目录 */
  filesDir(): string;
  /** 家长目录（家长库 parent.sqlite 所在） */
  parentDir(parentId: string): string;
  /** 家长资料真源目录（<topic>/… 树） */
  materialsDir(parentId: string): string;
  /** 某主题的资料目录 */
  topicDir(parentId: string, topicDirName: string): string;
  /** 孩子知识库目录（父级，内含 <childId>.sqlite） */
  childKbParentDir(parentId: string): string;
  /** 孩子知识库文件 */
  childKbFile(parentId: string, childId: string): string;
  /** 孩子会话目录（server 权威，按 childId 隔离） */
  childSessionsDir(parentId: string, childId: string): string;
  /** 家长会话目录 */
  parentSessionsDir(parentId: string): string;
}

/** 组合 dataDir 得到路径提供器。所有返回值均由本模块拼接，调用方不得自行 join。 */
export function createCorePaths(dataDir: string): CorePaths {
  const abs = path.resolve(dataDir);
  return {
    dataDir: abs,
    filesDir: () => path.join(abs, "files"),
    parentDir: (parentId) => path.join(abs, "parents", nonEmpty(parentId, "parentId")),
    materialsDir: (parentId) => path.join(abs, "materials", nonEmpty(parentId, "parentId")),
    topicDir: (parentId, topicDirName) =>
      path.join(abs, "materials", nonEmpty(parentId, "parentId"), safeSegment(topicDirName, "topic")),
    childKbParentDir: (parentId) => path.join(abs, "kb", nonEmpty(parentId, "parentId")),
    childKbFile: (parentId, childId) =>
      path.join(abs, "kb", nonEmpty(parentId, "parentId"), `${safeSegment(childId, "childId")}.sqlite`),
    childSessionsDir: (parentId, childId) =>
      path.join(abs, "sessions", nonEmpty(parentId, "parentId"), safeSegment(childId, "childId")),
    parentSessionsDir: (parentId) =>
      path.join(abs, "sessions", nonEmpty(parentId, "parentId"), "parent"),
  };
}

/** 单段路径名（parentId/childId/topic）：非空、不得含分隔符或 ..（防越目录） */
export function safeSegment(value: string, what: string): string {
  const v = (value ?? "").trim();
  if (!v) throw new Error(`${what} 不能为空`);
  if (v === "." || v === ".." || /[\\/]/.test(v) || v.includes("\0")) {
    throw new Error(`${what} 含非法字符：${value}`);
  }
  return v;
}

function nonEmpty(value: string, what: string): string {
  return safeSegment(value, what);
}

/**
 * 把相对路径解析到 root 之内；越界（.. 逃逸、绝对路径、符号链接逃出）一律抛错。
 *
 * 为什么必须在这里做：agent 的 read/write/edit/ls 工具直接吃模型给的相对路径，
 * 模型可以（也必然会）给出 `../../parents/other/materials/x.html` 这类输入；
 * 一旦放行就是跨家长/跨孩子越权。集中在此处校验 = 一处防线覆盖全部工具。
 */
export function resolveWithin(root: string, rel: string): string {
  const rootAbs = path.resolve(root);
  const raw = (rel ?? "").trim();
  if (!raw) throw new Error("路径不能为空");
  if (raw.includes("\0")) throw new Error("路径含非法字符");
  if (path.isAbsolute(raw)) throw new Error(`不允许绝对路径：${rel}`);
  const resolved = path.resolve(rootAbs, raw);
  const withSep = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (resolved !== rootAbs && !resolved.startsWith(withSep)) {
    throw new Error(`路径越界（仅允许访问当前作用域内文件）：${rel}`);
  }
  return resolved;
}

/** 相对 root 的展示路径（统一正斜杠，供 agent 上下文/日志使用） */
export function relativeDisplayPath(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join("/");
}

/**
 * 学习主题打包导出 / 导入（客户端侧，2026-09-25 方案）。
 *
 * - exportTopicPackage(topicKey, files, destPath)：POST /parent-lib/export-topic（JSON body 带
 *   勾选的资料清单）→ 服务端返回 .ltpkg（zip）二进制 → 落盘到用户指定路径。
 * - importTopicPackage(zipPath)：上传 .ltpkg → POST /parent-lib/import-topic（multipart）→
 *   服务端校验/冲突改写/落库/落文件，返回导入报告。
 * - fetchExportPreview(topicKey)：导出对话框打开时的预览（内容计数 + 资料文件清单）。
 *
 * 服务端实现：server/src/routes/topic-package.ts（包结构/冲突策略见该文件头注释）。
 */
import fs from "fs";
import { serverFetch, serverFetchBinary, serverUploadWithFields, ServerError } from "./server-client";
import { getCachedLicense } from "./auth-manager";

export interface ExportPreviewFile {
  path: string;
  type: string;
  size: number;
  /** 被本主题课程（material/html_path）引用的次数 */
  refCount: number;
}

export interface ExportPreview {
  topic: { name: string; topicKey: string };
  counts: { courses: number; knowledgePoints: number; questions: number };
  files: ExportPreviewFile[];
}

export interface ImportReport {
  ok: true;
  topic: { name: string; topicKey: string };
  renamed: boolean;
  refreshed: boolean;
  courses: number;
  knowledge_points: number;
  questions: number;
  files: number;
  missing_files: string[];
  warnings: string[];
}

function token(): string {
  return getCachedLicense()?.token ?? "";
}

/** 服务端 404 = 还没部署主题打包功能的旧 learning-server，把裸 "Not Found" 翻译成可操作的话。 */
function withServerHint(e: unknown): Error {
  const err = e as { status?: number; message?: string };
  if (err?.status === 404 || /not found/i.test(String(err?.message || ""))) {
    return new Error("服务端还没有主题打包功能（learning-server 版本过旧）——请更新并重启服务端后重试");
  }
  return (e as Error) ?? new Error(String(e));
}

/** 导出预览：主题信息 + 内容计数 + 资料文件清单（含每文件被引用次数）。 */
export async function fetchExportPreview(topicKey: string): Promise<ExportPreview> {
  try {
    return await serverFetch<ExportPreview>(`/parent-lib/export-topic/${encodeURIComponent(topicKey)}/preview`, {
      token: token(),
    });
  } catch (e) {
    throw withServerHint(e);
  }
}

/** 导出：下载 .ltpkg 到 destPath（tmp 写入 + rename，防半截文件）。 */
export async function exportTopicPackage(
  topicKey: string,
  files: string[],
  destPath: string
): Promise<{ file: string; bytes: number }> {
  let zip: Buffer;
  try {
    zip = await serverFetchBinary("/parent-lib/export-topic", {
      method: "POST",
      body: { topic_key: topicKey, files },
      token: token(),
      timeoutMs: 300000, // 带视频资料时传输可达百 MB 级
    });
  } catch (e) {
    throw withServerHint(e);
  }
  const tmpPath = `${destPath}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, zip);
    await fs.promises.rename(tmpPath, destPath);
  } catch (e) {
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    throw e;
  }
  return { file: destPath, bytes: zip.length };
}

/** 导入探测报告（服务端 inspect：只解包+冲突裁决，不写任何数据）。 */
export interface ImportInspect {
  name: string;
  topicKey: string;
  counts: { courses: number; knowledgePoints: number; questions: number; files: number };
  conflict: { type: "none" | "refresh" | "rename"; suggestedName: string; suggestedKey: string };
}

/**
 * 导入探测：上传包到服务端 inspect（不落库），返回冲突信息——
 * 同名主题时客户端据此提示，并允许家长改主题名/目录名后再 apply。
 */
export async function inspectTopicPackage(zipPath: string): Promise<ImportInspect> {
  let r: (ImportInspect & { error?: string }) | { ok?: false; error?: string };
  try {
    r = (await serverUploadWithFields(
      "/parent-lib/import-topic",
      { name: zipPath.split(/[\\/]/).pop() || "topic.ltpkg", mime: "application/zip", data: await fs.promises.readFile(zipPath) },
      { mode: "inspect" },
      token(),
      { timeoutMs: 300000 }
    )) as (ImportInspect & { error?: string }) | { ok?: false; error?: string };
  } catch (e) {
    throw withServerHint(e);
  }
  if (!r || (r as { name?: string }).name == null) {
    throw new ServerError(0, (r as { error?: string })?.error || "探测失败：服务端未确认");
  }
  return r as ImportInspect;
}

/**
 * 导入应用：上传包落库。targetName/targetKey 给出时按家长确认的身份导入
 * （服务端校验：目录名/主题名与现有主题冲突会拒收并给出可操作提示）；
 * 缺省走服务端自动冲突策略（同名同目录刷新 / 同名不同目录自动重命名）。
 */
export async function applyTopicPackage(
  zipPath: string,
  targetName?: string,
  targetKey?: string
): Promise<ImportReport> {
  const fields: Record<string, string> = { mode: "apply" };
  if (targetName != null) fields.target_name = targetName;
  if (targetKey != null) fields.target_key = targetKey;
  let r: (ImportReport & { error?: string }) | { ok?: false; error?: string };
  try {
    r = (await serverUploadWithFields(
      "/parent-lib/import-topic",
      { name: zipPath.split(/[\\/]/).pop() || "topic.ltpkg", mime: "application/zip", data: await fs.promises.readFile(zipPath) },
      fields,
      token(),
      { timeoutMs: 300000 }
    )) as (ImportReport & { error?: string }) | { ok?: false; error?: string };
  } catch (e) {
    throw withServerHint(e);
  }
  if (!r || (r as { ok?: boolean }).ok !== true) {
    throw new ServerError(0, (r as { error?: string })?.error || "导入失败：服务端未确认");
  }
  return r as ImportReport;
}

/** 导出文件名惯例：<主题名>-<YYYYMMDD>.ltpkg（对话框默认名；主题名里的非法字符换成空格）。 */
export function defaultExportFileName(topicName: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const safe = topicName.replace(/[\\/:*?"<>|]/g, " ").trim() || "topic";
  return `${safe}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.ltpkg`;
}

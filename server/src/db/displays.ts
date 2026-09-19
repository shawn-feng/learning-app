/**
 * 展示登记读写（ISSUE-113）：display_content 推送后登记到孩子库 display_contents，
 * 会话重进时 /open 回填左侧资料列表；/reset / 跨天新会话时清空（随会话走）。
 * 同 path 重复展示 → 就地更新 ts（对齐客户端 ISSUE-021「移到最新位置」语义）。
 */
import { openKb } from "./kb.js";

export interface DisplayEntry {
  path: string;
  title: string;
  source: string;
  content: string;
  ts: number;
}

/** 登记/更新一条展示（同 path 就地更新 ts 与内容）。失败不抛（登记不应阻断推送/业务）。 */
export function registerDisplay(
  dataDir: string,
  parentId: string,
  childId: string,
  childKey: string,
  entry: DisplayEntry
): void {
  try {
    const db = openKb(dataDir, parentId, childId);
    try {
      db.prepare(
        `INSERT INTO display_contents (child_key, path, title, source, content, ts) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(child_key, path) DO UPDATE SET
           title = excluded.title, source = excluded.source,
           content = excluded.content, ts = excluded.ts`
      ).run(childKey, entry.path, entry.title, entry.source, entry.content, entry.ts);
    } finally {
      db.close();
    }
  } catch (e) {
    console.warn(`[displays] 登记失败（不影响推送）：${(e as Error).message}`);
  }
}

/** 清空展示登记：childKey 省略 = 清该孩子全部会话种类（/reset 全量重置用）。 */
export function clearDisplayLog(dataDir: string, parentId: string, childId: string, childKey?: string): void {
  const db = openKb(dataDir, parentId, childId);
  try {
    if (childKey) db.prepare("DELETE FROM display_contents WHERE child_key = ?").run(childKey);
    else db.prepare("DELETE FROM display_contents").run();
  } finally {
    db.close();
  }
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 会话回填清单（/open 用）：ts 升序（复现会话内出现顺序），取最新 limit 条后转升序返回。
 * shape 对齐客户端 Material（id/format/title/time/filePath/content）。
 * source=materials 的共享资料由客户端 refreshStaleMaterials 拉最新；
 * source=workspace 的一次性页面这里直接带 content（客户端刷新链路不覆盖 outputs/）。
 */
export function listDisplays(
  dataDir: string,
  parentId: string,
  childId: string,
  childKey: string,
  limit: number
): Array<{ id: string; format: "html"; title: string; time: string; filePath: string; content: string }> {
  const db = openKb(dataDir, parentId, childId);
  try {
    const rows = db
      .prepare(
        `SELECT path, title, source, content, ts FROM (
           SELECT * FROM display_contents WHERE child_key = ? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`
      )
      .all(childKey, Math.max(1, Math.floor(limit) || 20)) as Array<{
      path: string;
      title: string;
      source: string;
      content: string;
      ts: number;
    }>;
    return rows.map((r) => ({
      id: `dsp-${r.ts}-${r.path}`,
      format: "html" as const,
      title: r.title || r.path.split("/").pop()?.replace(/\.html?$/i, "") || r.path,
      time: timeLabel(Number(r.ts)),
      filePath: r.path,
      content: r.source === "materials" ? "" : r.content, // 共享资料交给客户端保鲜刷新；workspace 页面直接带正文
    }));
  } finally {
    db.close();
  }
}

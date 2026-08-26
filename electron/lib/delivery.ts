/**
 * 跨机课程分发 + 进度查询（ISSUE-041 架构转向，2026-08-25 用户拍板）。
 *
 * 原则：云端只做「消息交换」，不做数据存储/备份。
 * - 分配包（家长→孩子）：只含课程数据 + method 全文，**不含 html/mp4 文件**（资料靠本地 zip 迁移）；
 *   家长端生成包上传 → 云端 sync_deliveries 暂存 → 孩子端拉到后在**本地写库合并** → ack 即删。
 * - 进度摘要（孩子→家长）：孩子端本地汇总 kb.sqlite 成 JSON，仅当家长打「请求刷新」标记时生成上传；
 *   家长端 GET 读摘要，无需孩子在线。
 * - kb.sqlite 永不整包跨机 → 进度覆盖风险从根上消除。
 */
import fs from "fs";
import path from "path";
import { getDataDir, getChildDir } from "./config";
import { apiCall } from "./sync-manager";
import { openParentDb, upsertParentCourse, allocateTopicToChild, listParentTopicCourses, DEFAULT_PARENT_ID } from "./parent-library";
import { openKbDb } from "./kb-sqlite";

// ================= 分配包（数据，不含文件） =================

export interface AllocPackage {
  topicDir: string;
  topicName: string;
  rulesJson: string;
  method: string; // 主题教学方法全文（文本数据，随包投递）
  courses: Array<{
    title: string;
    sortOrder: number;
    material: string;
    sendMaterial: number;
    tags: string;
    lessonMethod: string;
    htmlPath: string; // 家长库相对路径（资料文件本身靠 zip 迁移，此处只是指针）
  }>;
  createdAt: string;
}

/** 家长端：从本地家长库生成分配包（只读，不碰孩子库）。 */
export function buildAllocPackage(topicDir: string): AllocPackage {
  const db = openParentDb(DEFAULT_PARENT_ID);
  try {
    const topic = db
      .prepare("SELECT name, method, rules_json FROM topics WHERE file LIKE ?")
      .get(`%${topicDir}%`) as { name: string; method: string; rules_json: string } | undefined;
    if (!topic) throw new Error(`家长库中未找到主题 ${topicDir}`);
    const courses = listParentTopicCourses(DEFAULT_PARENT_ID, topicDir).map((c) => ({
      title: c.title,
      sortOrder: c.sortOrder,
      material: c.material,
      sendMaterial: Number(c.sendMaterial) || 0,
      tags: c.tags,
      lessonMethod: c.lessonMethod,
      htmlPath: c.htmlPath,
    }));
    return {
      topicDir,
      topicName: topic.name,
      rulesJson: topic.rules_json || "",
      method: topic.method || "",
      courses,
      createdAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}

/** 家长端：上传分配包到云端暂存（等待孩子端取走）。 */
export async function uploadDelivery(childId: string, pkg: AllocPackage): Promise<void> {
  await apiCall(`/api/sync/deliver/${childId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: pkg }),
  });
}

/** 孩子端：应用分配包——① 写入本地家长库（topics.method + courses，供 parent_content 读取）；
 * ② 在自己最新的 kb.sqlite 上合并（allocateTopicToChild 为 DB 级合并：已存在课程只补内容，status/mastery 保留）。 */
export function applyAllocPackage(childId: string, pkg: AllocPackage): { applied: boolean } {
  // ① 家长库落库（本地真源，孩子端从此自包含：method 可读；html 文件需 zip 迁移）
  const parentDb = openParentDb(DEFAULT_PARENT_ID);
  try {
    parentDb
      .prepare(
        "INSERT INTO topics (name, file, method, rules_json) VALUES (?, ?, ?, ?) " +
          "ON CONFLICT(name) DO UPDATE SET file = excluded.file, method = excluded.method, rules_json = excluded.rules_json"
      )
      .run(pkg.topicName, pkg.topicDir, pkg.method, pkg.rulesJson);
  } finally {
    parentDb.close();
  }
  for (const c of pkg.courses) {
    upsertParentCourse(DEFAULT_PARENT_ID, pkg.topicDir, {
      title: c.title,
      sortOrder: c.sortOrder,
      material: c.material,
      sendMaterial: c.sendMaterial,
      tags: c.tags,
      lessonMethod: c.lessonMethod,
      htmlPath: c.htmlPath,
    });
  }
  // ② 孩子库合并（进度安全）
  allocateTopicToChild(DEFAULT_PARENT_ID, childId, pkg.topicDir);
  return { applied: true };
}

/** 孩子端：拉取待处理分配包。 */
export async function pollDeliveries(childId: string): Promise<Array<{ id: string; payload: AllocPackage }>> {
  const resp = await apiCall(`/api/sync/deliver/${childId}`);
  return Array.isArray(resp?.deliveries) ? (resp.deliveries as Array<{ id: string; payload: AllocPackage }>) : [];
}

/** 孩子端：确认已在本地应用 → 云端删除（投递即删）。 */
export async function ackDeliveries(childId: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  await apiCall(`/api/sync/deliver/${childId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
}

// ================= 进度摘要（只传 JSON，不传 kb.sqlite） =================

/** 孩子端：本地汇总 kb.sqlite → 摘要 JSON（主题/课程完成数 + 最近 daily）。 */
export function buildProgressSummary(childId: string): any {
  const childDir = getChildDir(childId);
  if (!fs.existsSync(path.join(childDir, "kb.sqlite"))) return null;
  const db = openKbDb(childDir);
  try {
    const topics = db
      .prepare("SELECT name, file, progress FROM topics ORDER BY file")
      .all() as unknown as Array<{ name: string; file: string; progress: string }>;
    const list = topics.map((t) => {
      const key = t.file.split("/")[0];
      const total = (db.prepare("SELECT COUNT(*) AS c FROM courses WHERE topic = ?").get(key) as any)?.c ?? 0;
      const done =
        (db.prepare("SELECT COUNT(*) AS c FROM courses WHERE topic = ? AND status = '✅'").get(key) as any)?.c ??
        0;
      return { name: t.name, file: t.file, progress: t.progress, courses: total, done };
    });
    let daily: Array<{ date: string; summary: string }> = [];
    try {
      daily = db
        .prepare("SELECT date, summary FROM daily ORDER BY date DESC LIMIT 5")
        .all() as unknown as Array<{ date: string; summary: string }>;
    } catch {
      daily = []; // daily 表未建（无记录）时忽略
    }
    return { generatedAt: new Date().toISOString(), topics: list, daily };
  } finally {
    db.close();
  }
}

/** 孩子端：上传进度摘要（覆盖云端旧摘要，只存一份）。 */
export async function uploadProgressSummary(childId: string, summary: any): Promise<void> {
  await apiCall(`/api/sync/progress/${childId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ summary }),
  });
}

/** 家长端：读进度摘要；request=true 时先打「请求刷新」标记（孩子端轮询后生成新摘要）。 */
export async function fetchProgressSummary(childId: string, request: boolean = false): Promise<any> {
  const qs = request ? "?request=1" : "";
  return apiCall(`/api/sync/progress/${childId}${qs}`);
}

// ================= 孩子端轮询（scheduler / 开会话时调用） =================

const PROGRESS_STATE_FILE = "progress-push-state.json";

function readProgressState(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(path.join(getDataDir(), PROGRESS_STATE_FILE), "utf-8"));
  } catch {
    return {};
  }
}

function saveProgressState(state: Record<string, string>): void {
  fs.writeFileSync(path.join(getDataDir(), PROGRESS_STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

/** 孩子端：若家长打过「请求刷新」标记且本机尚未响应 → 生成摘要上传（仅被请求时，见 ISSUE-041 决策）。 */
export async function pushProgressIfRequested(childId: string): Promise<boolean> {
  try {
    const data = await apiCall(`/api/sync/progress/${childId}`);
    if (!data.requested_at) return false;
    const state = readProgressState();
    if (String(data.requested_at) <= (state[childId] || "")) return false;
    const summary = buildProgressSummary(childId);
    if (!summary) return false; // 本地无 kb.sqlite（孩子未学习过）
    await uploadProgressSummary(childId, summary);
    state[childId] = String(data.requested_at);
    saveProgressState(state);
    return true;
  } catch {
    return false; // 云不可达：静默，等下一轮
  }
}

/** 孩子端：处理一轮云端收件箱——拉分配包 → 本地落库 → ack；顺带响应进度请求。 */
export async function handleCloudInbox(
  childId: string
): Promise<{ applied: number; pushed: boolean; error?: string }> {
  try {
    let applied = 0;
    const deliveries = await pollDeliveries(childId);
    for (const d of deliveries) {
      try {
        applyAllocPackage(childId, d.payload);
        applied++;
      } catch (e) {
        console.error(`apply delivery ${d.id} failed:`, e);
      }
    }
    if (deliveries.length > 0) {
      await ackDeliveries(childId, deliveries.map((d) => d.id));
    }
    const pushed = await pushProgressIfRequested(childId);
    return { applied, pushed };
  } catch (e) {
    return { applied: 0, pushed: false, error: (e as Error).message };
  }
}

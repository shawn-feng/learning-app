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
import { getDataDir } from "./config";
import { apiCall } from "./sync-manager";
import { allocateTopicToChild, DEFAULT_PARENT_ID } from "./parent-library";
import { dbExec, dbQuery } from "./client-data";

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

/** 家长端：从服务端家长库生成分配包（只读，不碰孩子库）。 */
export async function buildAllocPackage(topicDir: string): Promise<AllocPackage> {
  const [topics, courses] = await Promise.all([
    dbQuery<Array<{ name: string; method: string; rules_json: string; topic_key: string }>>(
      "parent_lib.topics.list",
      {}
    ).catch(() => []),
    dbQuery<Array<Record<string, unknown>>>("parent_lib.courses.list", { topic: topicDir }).catch(() => []),
  ]);
  const topic = (topics ?? []).find((t) => t.topic_key === topicDir) || (topics ?? []).find((t) => String(t.topic_key).includes(topicDir));
  if (!topic) throw new Error(`家长库中未找到主题 ${topicDir}`);
  const list = (courses ?? []).map((c) => ({
    title: String(c.title),
    sortOrder: Number(c.sort_order) || 0,
    material: String(c.material ?? ""),
    sendMaterial: Number(c.send_material) || 0,
    tags: String(c.tags ?? ""),
    lessonMethod: String(c.lesson_method ?? ""),
    htmlPath: String(c.html_path ?? ""),
  }));
  return {
    topicDir,
    topicName: topic.name,
    rulesJson: topic.rules_json || "",
    method: topic.method || "",
    courses: list,
    createdAt: new Date().toISOString(),
  };
}

/** 家长端：上传分配包到云端暂存（等待孩子端取走）。 */
export async function uploadDelivery(childId: string, pkg: AllocPackage): Promise<void> {
  await apiCall(`/api/sync/deliver/${childId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ payload: pkg }),
  });
}

/** 孩子端：应用分配包——写入服务端家长库（topics.method + courses，供 parent_content 读取）+ 孩子 kb 合并。 */
export async function applyAllocPackage(childId: string, pkg: AllocPackage): Promise<{ applied: boolean }> {
  // ① 家长库落库（服务端真源；孩子端从此自包含：method 可读；html 文件需 zip 迁移）
  await dbExec("parent_lib.topics.upsert", {
    name: pkg.topicName,
    topic_key: pkg.topicDir,
    method: pkg.method,
    progress: "",
    rules_json: pkg.rulesJson,
  });
  for (const c of pkg.courses) {
    await dbExec("parent_lib.courses.upsert", {
      topic: pkg.topicDir,
      title: c.title,
      sort_order: c.sortOrder,
      status: "⬜",
      mastery: "",
      first_learned: "",
      last_review: "",
      review_count: 0,
      material: c.material,
      send_material: String(c.sendMaterial),
      tags: c.tags,
      lesson_method: c.lessonMethod,
      html_path: c.htmlPath,
      teaching_copy: "",
    });
  }
  // ② 孩子库合并（进度安全）
  await allocateTopicToChild(DEFAULT_PARENT_ID, childId, pkg.topicDir);
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

/** 孩子端：服务端汇总孩子 kb → 摘要 JSON（主题/课程完成数 + 最近 daily）。 */
export async function buildProgressSummary(childId: string): Promise<any> {
  // SPLIT：孩子 kb 在服务端唯一真源，汇总走 kb RPC（不再读本地 kb.sqlite，2026-08-30 修复）
  const [topics, courses] = await Promise.all([
    dbQuery<Array<{ name: string; topic_key: string; progress: string }>>("kb.topics.list", { child_id: childId }).catch(() => []),
    dbQuery<Array<Record<string, unknown>>>("kb.courses.list", { child_id: childId }).catch(() => []),
  ]);
  if (!topics?.length && !courses?.length) return null; // 孩子未学习过
  const byTopic = new Map<string, Array<Record<string, unknown>>>();
  for (const c of courses ?? []) {
    const t = String(c.topic);
    if (!byTopic.has(t)) byTopic.set(t, []);
    byTopic.get(t)!.push(c);
  }
  const list = (topics ?? []).map((t) => {
    const cs = byTopic.get(t.topic_key) ?? [];
    return {
      name: t.name,
      // 注：云端摘要 JSON 字段名沿用 `file`（与 cloud-service API 契约兼容），值取 topic_key（纯拼音主题键）
      file: t.topic_key,
      progress: t.progress || "",
      courses: cs.length,
      done: cs.filter((c) => String(c.status) === "✅").length,
    };
  });
  let daily: Array<{ date: string; summary: string }> = [];
  try {
    const rows = await dbQuery<Array<{ date: string; raw: string }>>("kb.daily_entries.query", { child_id: childId }).catch(() => []);
    const byDate = new Map<string, string[]>();
    for (const r of rows ?? []) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date)!.push(r.raw);
    }
    daily = [...byDate.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 5)
      .map(([date, raws]) => ({ date, summary: raws.join("\n") }));
  } catch {
    daily = []; // daily 表未建（无记录）时忽略
  }
  return { generatedAt: new Date().toISOString(), topics: list, daily };
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
    const summary = await buildProgressSummary(childId);
    if (!summary) return false; // 孩子未学习过
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
        await applyAllocPackage(childId, d.payload);
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

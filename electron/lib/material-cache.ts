/**
 * 材料按需缓存（SPLIT M8-D）：材料唯一真源在服务端，客户端「需要某个 material 文件时」
 * 才检测本地缓存——命中即用（后台异步比对服务端版本，变化则重拉）；未命中拉取落盘。
 *
 * 缓存目录**复用** data/parents/<parentId>/materials/（现有 asset:// 协议按该路径解析资源，
 * 零改动）；本地文件 mtime 即版本（服务端 updated_at 同为文件 mtime，可精确比对）。
 * 断网：本地命中直接返回（读不联网）；未命中且拉取失败 → 明确报错。
 */
import fs from "node:fs";
import path from "node:path";
import { getDataDir, getServerUrl } from "./config";
import { ServerError } from "./server-client";
import { currentSessionToken } from "./client-data";

function materialsCacheRoot(parentId: string): string {
  return path.join(getDataDir(), "parents", parentId, "materials");
}

/** 归一化相对路径（防穿越：剥 . / .. / 空段），posix 形式。 */
function normalizeRel(relPosix: string): string {
  const clean = relPosix
    .split("/")
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  if (!clean) throw new ServerError(400, "非法材料路径");
  return clean;
}

/** 与服务端一致的 material id（base64url(relPath)）。 */
export function encodeMaterialId(relPosix: string): string {
  return Buffer.from(relPosix, "utf-8").toString("base64url");
}

/** 二进制下载（materials/content 返回文件流，非 JSON）。 */
async function serverDownload(urlPath: string): Promise<Buffer> {
  const base = getServerUrl();
  if (!base) throw new ServerError(0, "未配置服务端地址");
  const token = currentSessionToken();
  let res: Response;
  try {
    res = await fetch(`${base}/api/v1${urlPath}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ServerError(0, "无法连接服务端，请检查服务端地址或网络");
  }
  if (!res.ok) {
    let detail = `材料获取失败 (HTTP ${res.status})`;
    try {
      const body: unknown = await res.json();
      if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
        detail = (body as { error: string }).error;
      }
    } catch {
      /* 保留默认 */
    }
    throw new ServerError(res.status, detail);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** 后台比对服务端版本，本地已过期则重拉（fire-and-forget，不阻塞展示）。 */
async function refreshIfChanged(parentId: string, relPosix: string, id: string): Promise<void> {
  try {
    const local = path.join(materialsCacheRoot(parentId), relPosix);
    const localTs = fs.existsSync(local) ? fs.statSync(local).mtime.toISOString() : "";
    const data = await serverFetch<{ updates: Array<{ id: string }> }>("/materials/index", {
      method: "POST",
      body: { client_index: { [id]: localTs } },
      token: currentSessionToken(),
    });
    if ((data.updates ?? []).some((u) => u.id === id)) {
      const buf = await serverDownload(`/materials/content/${id}`);
      fs.writeFileSync(local, buf);
    }
  } catch {
    /* 静默：下次需要该材料时再比对 */
  }
}

export interface MaterialResult {
  ok: boolean;
  path: string;
  error?: string;
}

/**
 * 按需获取材料：本地命中返回路径（后台异步比对版本）；未命中从服务端拉取落盘。
 */
export async function ensureMaterial(parentId: string, relPosix: string): Promise<MaterialResult> {
  let safe: string;
  try {
    safe = normalizeRel(relPosix);
  } catch (err) {
    return { ok: false, path: "", error: err instanceof Error ? err.message : "非法路径" };
  }
  const local = path.join(materialsCacheRoot(parentId), safe);
  const id = encodeMaterialId(safe);

  if (fs.existsSync(local) && fs.statSync(local).isFile()) {
    // 命中缓存：先返回本地路径（读不联网，断网可浏览），版本刷新后台进行
    void refreshIfChanged(parentId, safe, id).catch(() => {});
    return { ok: true, path: local };
  }

  try {
    const buf = await serverDownload(`/materials/content/${id}`);
    fs.mkdirSync(path.dirname(local), { recursive: true });
    fs.writeFileSync(local, buf);
    return { ok: true, path: local };
  } catch (err) {
    return {
      ok: false,
      path: local,
      error: err instanceof Error ? err.message : "材料获取失败",
    };
  }
}

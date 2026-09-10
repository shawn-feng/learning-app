/**
 * 资料文档渲染通道（ISSUE-061 根治 2026-09-08）
 *
 * 背景：孩子端资料 iframe 此前用「渲染层把注入后的 html 以 dataURL/srcDoc 内嵌」加载，
 * 实测在 Electron 沙盒 iframe（app://bundle 父页 + sandbox 无 allow-same-origin）中：
 * head 注入的桥/SDK 能执行（page:ready、page:app-cmd 均可达），但页面 **正文 <script> 不执行**
 * （scene 页的 PiBridge.on('scene.*') 注册永不发生 → scene_command 永远 no handler）。
 * 同一内容在隔离环境（不同父页）三路对照全部执行正常 → 判定为自定义协议父页 + dataURL/srcDoc
 * 内嵌在 Chromium 沙盒下的解析/执行怪癖。
 *
 * 根治：iframe 顶层直接加载 **真实 URL 文档**（asset://local/parent/{parentId}/{topic}/{file}?doc=1）。
 * 真实网络级导航没有 dataURL/srcDoc 的内嵌怪癖，正文脚本随正常文档解析执行。
 * 桥/SDK 注入因此从「渲染层内嵌时注入」下沉到 **协议层**（本模块）：拉原始 html →
 * rewrite（base/相对资源）→ injectBridge（PiBridge SDK + manual 采集 + 字号）→ text/html 返回。
 *
 * 独立模块而非并入 media-protocol：media-protocol ← parent-library（parent-library import media-protocol），
 * 若 media-protocol 反向 import parent-library 会成环；本模块由 main.ts 显式装配为 asset 协议的回调。
 */
import path from "path";
import { fetchMaterialContent } from "./media-protocol";
import { followHtmlRedirectRemote, rewriteMaterialHtmlForRender, DEFAULT_PARENT_ID } from "./parent-library";
import { injectBridge } from "../../src/lib/page-bridge";

/** 判断一个资产 rel 是否 html 文档。 */
function isHtmlRel(rel: string): boolean {
  return /\.(html?|htm)$/i.test(rel);
}

/**
 * 渲染并返回一份「可顶层加载」的资料文档。
 * @param rel 材料相对路径（topic/.../x.html，相对 materials 根）
 * @param url 触发请求的 asset:// URL（用于读取 query：font=字号、doc=1）
 * @returns 注入桥后的完整 html Response；非 html / 无 doc 标记 / 拉取失败返回 null（交给调用方回退）
 */
export async function serveMaterialDocument(
  rel: string,
  url: URL
): Promise<Response | null> {
  if (!isHtmlRel(rel)) return null;
  if (url.searchParams.get("doc") !== "1") return null;
  try {
    // 1) 拉原始 + 跟随 <meta http-equiv=refresh>（与 display_content 相同：占位跳转页需落到真实 html）
    let finalRel = rel;
    let raw = (await fetchMaterialContent(rel)).toString("utf-8");
    if (/http-equiv\s*=\s*["']?refresh/i.test(raw)) {
      const jumped = await followHtmlRedirectRemote(finalRel, raw);
      if (jumped !== finalRel) {
        finalRel = jumped;
        raw = (await fetchMaterialContent(finalRel)).toString("utf-8");
      }
    }
    // 2) rewrite：相对资源 → asset:///media://、注入 <base>（与 parent 端 readParentMaterial / display_content 一致）
    const fileDir = path.posix.dirname(finalRel);
    const rewritten = rewriteMaterialHtmlForRender(raw, DEFAULT_PARENT_ID, fileDir);
    // 3) 注入桥/SDK（PiBridge + manual 采集判定 + 资料字号），页面正文随真实导航执行
    const fontPx = Number.parseInt(url.searchParams.get("font") || "", 10);
    const html = injectBridge(rewritten, Number.isFinite(fontPx) && fontPx >= 8 ? fontPx : undefined);
    const headers = new Headers();
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("Cache-Control", "no-store");
    return new Response(html, { status: 200, headers });
  } catch (err) {
    console.error(`[material-doc] 渲染失败 ${rel}:`, (err as Error)?.message || err);
    return null;
  }
}

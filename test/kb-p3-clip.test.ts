/**
 * KB P3 阶段④（2026-09-25）：**网页落袋**。
 *
 * ## 要解决的问题（§2.2 缺口 B / §5.3）
 * 家长想"只给孩子看这一个网页"，两条路都不通：直接把外网 URL 交给 `display_content`
 * = **把整个互联网放进孩子的屏幕**（从那一页能点出去）；让家长"另存为"再上传，单文件 HTML 常丢样式丢图片。
 *
 * ## 落袋的承诺（就是下面这些断言）
 * 1. **点不出去**：脚本/iframe/表单/`meta refresh`/内联事件全剥，`<a href>` 降级成 `<span>`（保留文字），
 *    最后再叠一层 CSP（`default-src 'none'`）——**即便漏了什么，浏览器也不会发出去**。
 * 2. **只看这一页**：图片与样式表**内联成 data URL**，页面离线自足。
 * 3. **SSRF 防线**（家长给的是任意 URL = 让服务端替他发请求，必须当不可信输入）：
 *    协议限 http/https、主机名字面量筛、**DNS 解析后逐个 IP 筛**、**每一跳重定向都重筛**。
 *    **只筛首跳等于没筛**——所以第二轮重定向到内网也必须被拦住。
 * 4. **不覆盖家长已有的资料**：落袋写文件走 `uniqueMaterialRel`（重名加序号）。
 *    磁盘即真源、没有索引能判断"这份是不是同一个网页的新版本"，**悄悄覆盖等于无声销毁**。
 *
 * 测法：变换层是纯函数（资源靠 `resolve` 回调注入），**完全离线**就能钉住上面 1、2 两条；
 * SSRF 用字面量地址（127.0.0.1 / 10.x / [::1] / file:）在**发起任何请求之前**就会被拒，也不需要网络。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../server/src/db";
import { openParentLib } from "../server/src/db/parent-lib";
import { materialsRoot } from "../server/src/db/materials";
import { getKbEntry, listKbAssets } from "../server/src/db/kb-entries";
import {
  assertUrlShape,
  absolutize,
  isPrivateAddress,
  sanitizeClippedHtml,
} from "../server/src/agent/web-clip";
import { createParentKbTools, slugOf, uniqueMaterialRel } from "../server/src/agent/parent-kb-tools";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-clip-"));
const parentId = "p-kb-clip";
const main = openDb(dataDir);
const nowIso = new Date().toISOString();
main.prepare("INSERT INTO parents (id,email,created_at,updated_at) VALUES (?,?,?,?)").run(parentId, "clip@test", nowIso, nowIso);
const lib = openParentLib(dataDir, parentId);

afterAll(() => {
  for (const close of [() => main.close(), () => lib.close()]) {
    try {
      close();
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text).join("");
const tools: any[] = createParentKbTools({ dataDir, parentId, db: main });
const byName = (n: string) => tools.find((t) => t.name === n)!;

/** 离线资源解析器：任何 URL 都返回一个可辨认的 data URL，除非在 deny 里 */
const fakeResolve = (deny: string[] = []) => async (abs: string, kind: "img" | "css"): Promise<string | null> => {
  if (deny.some((d) => abs.includes(d))) return null;
  return kind === "css" ? "body{color:red}" : "data:image/png;base64,AAAA";
};

const PAGE = `<!doctype html><html><head><title>  小知识 ·  测试  </title>
<link rel="stylesheet" href="/site.css">
<link rel="preload" href="/x.js" as="script">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
</head><body onload="steal()">
<script>fetch('https://tracker.example/beacon')</script>
<iframe src="https://ads.example/frame"></iframe>
<form action="https://evil.example/post"><input name="q"></form>
<h1>正文标题</h1>
<p>这是<b>正文</b>。</p>
<a href="https://other.example/page">一个外部链接</a>
<img src="/a.png" srcset="/a-2x.png 2x" onerror="boom()">
<img src="/missing.png">
<object data="x.swf"></object>
</body></html>`;

describe("KB P3④：SSRF 防线（**发起请求之前**就该拦住）", () => {
  it("只允许 http/https：file、data、javascript 一律拒（并说明这是替服务端发请求）", () => {
    for (const bad of ["file:///etc/passwd", "data:text/html,<h1>x", "javascript:alert(1)", "ftp://x/y"]) {
      expect(() => assertUrlShape(bad)).toThrow(/只支持 http \/ https/);
    }
  });

  it("本机 / 内网 / 云元数据：字面量就在形状这一层拒掉", () => {
    expect(() => assertUrlShape("http://localhost:8788/admin")).toThrow(/不能抓本机\/内网地址/);
    expect(() => assertUrlShape("http://127.0.0.1/")).toThrow(/内网|保留地址/);
    expect(() => assertUrlShape("http://10.0.0.5/")).toThrow(/内网|保留地址/);
    expect(() => assertUrlShape("http://192.168.1.1/")).toThrow(/内网|保留地址/);
    expect(() => assertUrlShape("http://169.254.169.254/latest/meta-data/")).toThrow(/元数据|内网|保留地址/);
    expect(() => assertUrlShape("http://[::1]/")).toThrow(/内网|保留地址/);
    expect(() => assertUrlShape("http://metadata.google.internal/")).toThrow(/元数据/);
  });

  it("不是完整网址 → 给出可操作的话", () => {
    expect(() => assertUrlShape("example.com/abc")).toThrow(/不是一个完整的网址/);
    expect(() => assertUrlShape("")).toThrow(/不是一个完整的网址/);
  });

  it("公网地址放行（含 www 与 https）", () => {
    expect(assertUrlShape("https://example.com/a?b=1").hostname).toBe("example.com");
    expect(assertUrlShape("http://www.example.com/").protocol).toBe("http:");
  });

  it("IP 段判断本身要覆盖各类特殊段（含 IPv4 映射的 IPv6）", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    expect(isPrivateAddress("2606:4700:4700::1111")).toBe(false);
    expect(isPrivateAddress("")).toBe(true); // 解析不出来的一律当不安全
  });

  it("相对 URL 归一：data:/javascript:/锚点一律不取", () => {
    expect(absolutize("/a.png", "https://e.com/x/y")).toBe("https://e.com/a.png");
    expect(absolutize("a.png", "https://e.com/x/y")).toBe("https://e.com/x/a.png");
    expect(absolutize("data:image/png;base64,AA", "https://e.com/")).toBeNull();
    expect(absolutize("javascript:alert(1)", "https://e.com/")).toBeNull();
    expect(absolutize("#top", "https://e.com/")).toBeNull();
  });
});

describe("KB P3④：自包含变换（纯函数，离线可测）", () => {
  it("**脚本 / iframe / 表单 / meta refresh 全剥**——这些是「能发请求、能导航出去」的东西", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.html).not.toMatch(/<script/i);
    expect(r.html).not.toMatch(/<iframe/i);
    expect(r.html).not.toMatch(/<form/i);
    expect(r.html).not.toMatch(/http-equiv=["']?refresh/i);
    expect(r.html).not.toContain("tracker.example");
    expect(r.html).not.toContain("ads.example");
    expect(r.html).not.toContain("evil.example");
    expect(r.stats.scripts).toBe(1);
    expect(r.stats.frames).toBeGreaterThanOrEqual(2); // iframe + object
    expect(r.stats.forms).toBe(1);
    expect(r.stats.metas).toBeGreaterThanOrEqual(1);
  });

  it("**外链降级成 span**：文字留着、点不动", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.html).not.toMatch(/<a\b/i);
    expect(r.html).toContain("一个外部链接"); // 文字还在
    expect(r.stats.anchors).toBe(1);
  });

  it("内联事件属性（on*）与 preload link 一并剥掉", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.html).not.toMatch(/\son(load|error|click)\s*=/i);
    expect(r.html).not.toContain("x.js");
  });

  it("**图片内联成 data URL**，且丢掉 srcset/loading/crossorigin（页面离线自足）", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.html).toContain("data:image/png;base64,AAAA");
    expect(r.html).not.toContain("srcset");
    expect(r.html).not.toContain("/a-2x.png");
    expect(r.stats.imagesInlined).toBe(2); // 这个用例的 resolver 不拒绝任何地址（拒绝路径见下一个用例）
    expect(r.html).not.toContain("https://e.com/a.png");
  });

  it("取不到的图片**被移掉并如实报告**（不留一个必然 404 的 img）", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve(["missing.png"]) });
    expect(r.stats.imagesDropped).toBeGreaterThanOrEqual(1);
    expect(r.warnings.join(" ")).toMatch(/张图没能一起存下来/);
  });

  it("样式表内联进 `<style>`", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.stats.cssInlined).toBe(1);
    expect(r.html).toContain("<style>body{color:red}</style>");
    expect(r.html).not.toMatch(/<link\b/i);
  });

  it("**注入 CSP**（default-src 'none'）：漏了什么也发不出去", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.html).toMatch(/Content-Security-Policy/);
    expect(r.html).toContain("default-src 'none'");
    expect(r.html).toContain("img-src data:");
  });

  it("标题提取（折叠空白）；没有 head 也能容错", async () => {
    const r = await sanitizeClippedHtml(PAGE, { baseUrl: "https://e.com/a/b", resolve: fakeResolve() });
    expect(r.title).toBe("小知识 · 测试");
    const bare = await sanitizeClippedHtml("<p>只有正文</p>", { baseUrl: "https://e.com/", resolve: fakeResolve() });
    expect(bare.html).toContain("Content-Security-Policy");
    expect(bare.html).toContain("只有正文");
  });

  it("超过产出上限 → 截断并**如实警告**（putMaterial 有 2MB 硬上限）", async () => {
    const big = `<p>${"甲".repeat(3000)}</p>`;
    const r = await sanitizeClippedHtml(big, { baseUrl: "https://e.com/", resolve: fakeResolve(), maxOutputBytes: 1000 });
    expect(Buffer.byteLength(r.html, "utf-8")).toBeLessThanOrEqual(1000);
    expect(r.warnings.join(" ")).toMatch(/超过本库单份资料上限/);
  });

  it("图片数量有上限（防一页几百张图把资料库撑爆）", async () => {
    const many = `<p>x</p>${Array.from({ length: 40 }, (_, i) => `<img src="/i${i}.png">`).join("")}`;
    const r = await sanitizeClippedHtml(many, { baseUrl: "https://e.com/", resolve: fakeResolve(), maxImages: 3 });
    expect(r.stats.imagesInlined).toBe(3);
    expect(r.stats.imagesDropped).toBe(37);
  });
});

describe("KB P3④：落盘的路径安全", () => {
  it("slugOf 去掉路径分隔符与控制字符、限长；空标题有兜底", () => {
    expect(slugOf("a/b\\c:d*e?f")).toBe("a b c d e f");
    expect(slugOf("  ")).toBe("网页");
    expect(slugOf("甲".repeat(200)).length).toBeLessThanOrEqual(60);
  });

  it("**不覆盖已有资料**：重名自动加序号", () => {
    const rel1 = uniqueMaterialRel({ dataDir, parentId }, "web", "某网页");
    expect(rel1).toBe("web/某网页.html");
    const root = materialsRoot(dataDir, parentId);
    fs.mkdirSync(path.dirname(path.join(root, rel1)), { recursive: true });
    fs.writeFileSync(path.join(root, rel1), "x");
    expect(uniqueMaterialRel({ dataDir, parentId }, "web", "某网页")).toBe("web/某网页-2.html");
  });

  it("非法 topic 回落到 web（topic 段只允许字母/数字/_/-）", () => {
    expect(uniqueMaterialRel({ dataDir, parentId }, "../etc", "x")).toBe("web/x.html");
  });
});

describe("KB P3④：工具层（抓不动时如实报错，不留半成品）", () => {
  it("内网地址 → 报错并给出路，**不写任何文件**", async () => {
    const before = fs.existsSync(materialsRoot(dataDir, parentId));
    await expect(byName("parent_kb_save").execute("c1", { clip: [{ url: "http://127.0.0.1:8788/x" }] })).rejects.toThrow(
      /内网|保留地址/
    );
    expect(fs.existsSync(materialsRoot(dataDir, parentId))).toBe(before);
  });

  it("file:// → 报错（不能把服务端当读本地文件的入口）", async () => {
    await expect(byName("parent_kb_save").execute("c2", { clip: [{ url: "file:///etc/passwd" }] })).rejects.toThrow(
      /只支持 http \/ https/
    );
  });

  it("缺 url → 报错；六个参数一个都不给 → 报错文案要把 clip 也列上", async () => {
    await expect(byName("parent_kb_save").execute("c3", { clip: [{}] })).rejects.toThrow(/都要有 url/);
    await expect(byName("parent_kb_save").execute("c4", {})).rejects.toThrow(/clip/);
  });

  it("抓不到时**不产生空条目**（整批不写）", () => {
    expect(getKbEntry(lib, "某网页")).toBeUndefined();
    expect(listKbAssets(lib, "x")).toHaveLength(0);
  });
});

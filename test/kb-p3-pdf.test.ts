/**
 * KB P3 阶段⑥（2026-09-25）：**PDF 文本化**。
 *
 * ## 为什么单独测
 * PDF 是阶段②里唯一"要额外能力"的格式。方案 §5.5.3 风险 2 明写"服务端用 `@yao-pkg/pkg` 打单文件
 * `server.cjs`，原生/napi 依赖易踩坑"，所以选了 `pdfjs-dist` 的**纯 JS 路径**，并且用**动态 import**
 * 接进来——PDF 不是核心路径，**缺这个包不该让整个服务起不来**，而且动态 import 才能给出可操作的错。
 *
 * ## 本文件钉住什么
 * 1. 纯函数：`itemsToText` 用 `hasEOL` **还原换行**（一律拼空格会把标题/正文/列表压成一行，分块也废）；
 *    `cleanupPdfText` 折叠碎空白；
 * 2. **端到端提取**：随手写一份"能预期内容"的最小 PDF（自算 xref 偏移），断言提取到的**就是写进去的字**，
 *    且**多页会分开、换行会保留**；
 * 3. **两条失败路径都要说得出下一步**（且互不混同）：
 *    - 文件损坏/加密 → "打不开…换一份或口述要点"；
 *    - **没有文字层**（扫描件/纯图 PDF）→ "把关键页截图传上来（图片那条路是通的），或口述要点"
 *      ——这一类**必须报错而不是返回空串**：对家长来说"这是扫描件"和"提取失败"的下一步完全不同；
 * 4. `pdfjs-dist` 是**可选依赖**：没装时这些用例**跳过**（而不是变红）——CI 上没装包不该等于功能坏了，
 *    真正要守的是"没装时给出可操作的话"，那条在 `loadPdfjs` 里。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPdfText, itemsToText, loadPdfjs, pdfToText } from "../server/src/agent/pdf-text";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kb-pdf-"));

/** 极简 PDF 生成器（自算 xref 偏移）。`pages[i]` 是该页的文本行；传 [] 得到**没有文字层**的一页。 */
function buildPdf(pages: string[][]): Buffer {
  const objs: Record<number, string> = {
    1: "<</Type/Catalog/Pages 3 0 R>>",
    2: "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  };
  const pageIds: number[] = [];
  let n = 4; // 1=Catalog 2=Font 3=Pages，页面/内容从 4 起（**别从 3 起——会和 Pages 撞 id，页树自引用**）
  for (const lines of pages) {
    const pid = n++;
    const cid = n++;
    const stream = lines.length
      ? `BT /F1 20 Tf 40 150 Td ${lines.map((l, i) => `${i ? "0 -30 Td " : ""}(${l}) Tj`).join(" ")} ET\n`
      : "";
    objs[pid] = `<</Type/Page/Parent 3 0 R/MediaBox[0 0 500 220]/Resources<</Font<</F1 2 0 R>>>>/Contents ${cid} 0 R>>`;
    objs[cid] = `<</Length ${stream.length}>>\nstream\n${stream}endstream`;
    pageIds.push(pid);
  }
  objs[3] = `<</Type/Pages/Kids[${pageIds.map((i) => `${i} 0 R`).join(" ")}]/Count ${pageIds.length}>>`;
  let buf = "%PDF-1.4\n";
  const offsets: Record<number, number> = {};
  const maxObj = n - 1;
  for (let i = 1; i <= maxObj; i++) {
    if (!objs[i]) continue;
    offsets[i] = Buffer.byteLength(buf, "latin1");
    buf += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(buf, "latin1");
  buf += `xref\n0 ${maxObj + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxObj; i++) {
    buf += offsets[i] !== undefined ? `${String(offsets[i]).padStart(10, "0")} 00000 n \n` : `0000000000 65535 f \n`;
  }
  buf += `trailer\n<</Size ${maxObj + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(buf, "latin1");
}

function write(name: string, content: Buffer | string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
}

/** pdfjs 是可选依赖：没装就跳过这组用例（真正的守门在 loadPdfjs 的报错话术里） */
const pdfjsAvailable = await loadPdfjs().then(
  () => true,
  () => false
);

describe("KB P3⑥：PDF 文本化的纯函数", () => {
  it("`itemsToText` 用 hasEOL **还原换行**（一律拼空格会把标题/正文压成一行）", () => {
    expect(itemsToText([{ str: "标题" }, { str: "正文", hasEOL: true }, { str: "下一段" }])).toBe("标题 正文\n下一段 ");
    expect(itemsToText([])).toBe("");
    expect(itemsToText([{ str: "" }, { str: "" }])).toBe("");
  });

  it("`cleanupPdfText` 折叠碎空白、去空行、压掉多余换行", () => {
    expect(cleanupPdfText("  a  b \n\n\n\n c   \n")).toBe("a b\nc");
    expect(cleanupPdfText("")).toBe("");
  });
});

describe.skipIf(!pdfjsAvailable)("KB P3⑥：PDF 提取（端到端，用自造的最小 PDF）", () => {
  it("**提取到的就是写进去的字**，且多页分开、换行保留", async () => {
    const p = write("two-pages.pdf", buildPdf([["PAPER DOC 42", "SECOND LINE"], ["PAGE TWO TEXT"]]));
    const r = await pdfToText(p);
    expect(r.pages).toBe(2);
    expect(r.emptyPages).toBe(0);
    expect(r.text).toContain("PAPER DOC 42");
    expect(r.text).toContain("SECOND LINE");
    expect(r.text).toContain("PAGE TWO TEXT");
    // 换行保留：标题与第二行不能粘成一个词
    expect(r.text).toMatch(/PAPER DOC 42\nSECOND LINE/);
    // 两页之间有空行分隔
    expect(r.text).toMatch(/SECOND LINE\n\nPAGE TWO TEXT/);
  });

  it("页数上限生效（防一份 500 页的扫描件把时间与正文预算吃光）", async () => {
    const p = write("three-pages.pdf", buildPdf([["P1"], ["P2"], ["P3"]]));
    const r = await pdfToText(p, { maxPages: 2 });
    expect(r.pages).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("P1");
    expect(r.text).not.toContain("P3");
  });

  it("**没有文字层（扫描件）→ 必须报错并指向图片那条路**，不能返回空串", async () => {
    const p = write("scanned.pdf", buildPdf([[], []]));
    await expect(pdfToText(p)).rejects.toThrow(/没有可提取的文字/);
    await expect(pdfToText(p)).rejects.toThrow(/截图/);
  });

  it("损坏的文件 → 报错并给出路（不抛底层栈）", async () => {
    const p = write("broken.pdf", "%PDF-1.4\n这不是一个合法 PDF");
    await expect(pdfToText(p)).rejects.toThrow(/打不开/);
    await expect(pdfToText(p)).rejects.toThrow(/下一步/);
  });

  it("返回的正文不超过 maxChars", async () => {
    const long = Array.from({ length: 50 }, (_, i) => `LINE ${i} ${"X".repeat(40)}`);
    const p = write("long.pdf", buildPdf([long]));
    const r = await pdfToText(p, { maxChars: 300 });
    expect(r.text.length).toBeLessThanOrEqual(300);
  });
});

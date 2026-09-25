/**
 * KB P3 阶段⑥：**PDF 文本化**（2026-09-25）。
 *
 * ## 为什么单独一个模块
 * PDF 是阶段②里唯一"要额外能力"的格式：仓里原本没有任何 PDF 解析库。
 * 方案 §5.5.3 风险 2 明写"服务端用 `@yao-pkg/pkg` 打单文件 `server.cjs`，原生/napi 依赖易踩坑"，
 * 所以选 **`pdfjs-dist` 的纯 JS 路径**——它没有原生模块，`pkg` 打得动。
 *
 * ## 关键工程决定：**动态 import**
 * `await import("pdfjs-dist")` 而不是顶层 import。两个理由：
 * 1. **没装也必须能跑**：PDF 不是核心路径，缺这个包不该让整个服务起不来；
 * 2. **能给出可操作的错**：顶层 import 失败是模块解析错误（栈里全是路径），
 *    而动态 import 捕获后能说清"这份读不了、下一步怎么办"。
 *
 * ## 提取产物仍然**不是权威**
 * 与 html/md/txt 同一类：正文只进 `body`，只用来让孩子**换个问法也能找到这条**；
 * `summary` 永远只能家长给（§3.4.1）。所以这里**不加**"这是模型生成"的标记——
 * 与图片那条不同：图片是**模型描述**（机器的话），PDF 是**文件自己的字**。
 */

/** 最多读多少页（防一份 500 页的扫描件把时间和正文预算吃光） */
export const PDF_MAX_PAGES = 40;
/** 提取正文上限（与 KB_BODY_MAX 一致的口径，调用方还会再截一次） */
export const PDF_MAX_CHARS = 20000;

/** pdfjs 的文字项（只取我们用的两个字段） */
interface TextItemLike {
  str?: string;
  hasEOL?: boolean;
}

/**
 * 页内文字项 → 文本。**用 `hasEOL` 还原换行**，而不是一律拼空格——
 * 一律拼空格会把"标题\n正文\n列表"压成一行，可读性与后续分块都废。
 */
export function itemsToText(items: TextItemLike[]): string {
  let s = "";
  for (const it of items) {
    const str = String(it?.str ?? "");
    if (!str) continue;
    s += str;
    s += it?.hasEOL ? "\n" : " ";
  }
  return s;
}

/** 清理：折叠行内空白、去空行、压掉 3 个以上换行（PDF 提取常带大量碎空白） */
export function cleanupPdfText(raw: string): string {
  return String(raw ?? "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** 动态加载 pdfjs；**没装时抛一句可操作的话**（而不是模块解析错误） */
export async function loadPdfjs(): Promise<any> {
  try {
    /**
     * ⚠️ **必须用 `legacy` 构建**。实测：现代构建（`pdfjs-dist` 默认入口）在 Node 里会
     * 打印 "Please use the `legacy` build in Node.js environments."，随后内部直接抛
     * `hashOriginal.toHex is not a function`（它依赖浏览器侧的 API）。
     * 包没有 `exports` 字段，所以可以直接指路径。
     */
    return await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch {
    throw new Error(
      "这份是 PDF，而服务端还没装 PDF 解析库（pdfjs-dist），所以读不出文字。\n" +
        "下一步（二选一）：\n" +
        "  1. 让家长把要点**口述成一句说法**——那条才是最权威的；\n" +
        "  2. 把关键页**截图**传上来（图片那条路是通的）。\n" +
        "（管理员装上 `pdfjs-dist` 之后，这条通道会自动生效。）"
    );
  }
}

/**
 * pdfjs 需要知道 `standard_fonts/` 与 `cmaps/` 在哪：
 * - **非嵌入的标准字体**（如 Helvetica）要靠 `standard_fonts` 才能把字节映射成正确字符；
 * - **中文 PDF** 常用预定义 CMap，缺了 `cmaps` 就只能得到乱码。
 * 两者都在包里，指过去即可。拿不到路径就返回空对象（提取仍能跑，只是可能不准）。
 */
async function assetUrls(): Promise<Record<string, unknown>> {
  try {
    const { createRequire } = await import("node:module");
    const path = await import("node:path");
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("pdfjs-dist/package.json");
    const root = path.dirname(pkg);
    /**
     * ⚠️ **要给文件系统路径（正斜杠、且以 `/` 结尾），不能给 `file://` URL**。两个实测坑：
     * ① 给 URL 时 pdfjs 去取 `file:///.../LiberationSans-Regular.ttf`，而 Node 的 `fetch` **不支持 file: 协议**
     *    → 每个标准字体都报 "Unable to load font data"（ASCII 还能靠内置映射兜住，中文就可能出错）；
     * ② 末尾必须是**正斜杠**，Windows 的 `\` 会被拒（"must include trailing slash"）。
     */
    const fwd = (p: string): string => p.replace(/\\/g, "/") + "/";
    return {
      standardFontDataUrl: fwd(path.join(root, "standard_fonts")),
      cMapUrl: fwd(path.join(root, "cmaps")),
      cMapPacked: true,
    };
  } catch {
    return {};
  }
}

export interface PdfTextResult {
  text: string;
  pages: number;
  truncated: boolean;
  /** 有页面提取为空（扫描件/纯图 PDF）——要如实告诉家长"这份没有文字层" */
  emptyPages: number;
}

/**
 * PDF → 文本。**失败一律抛可操作的话**，不返回空文本让上游以为成功了。
 *
 * 两个刻意的取舍：
 * - `isEvalSupported: false`：PDF 里能塞 JS，提取文字用不到 eval，关掉少一个面；
 * - 扫描件（没有文字层）会读出**空**——这时**抛错而不是返回空串**，
 *   因为"这份是图片型 PDF"和"提取失败"对家长来说下一步完全不同（前者该走识图/口述，后者该重试）。
 */
export async function pdfToText(absPath: string, opts?: { maxPages?: number; maxChars?: number }): Promise<PdfTextResult> {
  const pdfjs = await loadPdfjs();
  const maxPages = Math.max(1, Number(opts?.maxPages) || PDF_MAX_PAGES);
  const maxChars = Math.max(200, Number(opts?.maxChars) || PDF_MAX_CHARS);
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(absPath);

  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      // 提取文字用不到字体渲染；关掉能少一堆"缺字体"告警
      disableFontFace: true,
      useSystemFonts: false,
      ...(await assetUrls()),
    }).promise;
  } catch (e) {
    throw new Error(
      `这份 PDF 打不开（可能损坏或加密）：${(e as Error).message}\n` +
        `下一步：让家长换一份文件，或口述要点。`
    );
  }

  const total = Number(doc.numPages) || 0;
  const pages = Math.min(total, maxPages);
  const parts: string[] = [];
  let emptyPages = 0;
  let chars = 0;
  let truncated = pages < total;
  try {
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const text = cleanupPdfText(itemsToText((content?.items ?? []) as TextItemLike[]));
      if (!text) emptyPages++;
      if (text) parts.push(text);
      chars += text.length;
      if (chars >= maxChars) {
        truncated = true;
        break;
      }
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* 释放失败无所谓 */
    }
  }

  const text = parts.join("\n\n").slice(0, maxChars);
  if (!text.trim()) {
    throw new Error(
      `这份 PDF 里**没有可提取的文字**（${emptyPages} 页都是空的）——多半是扫描件或纯图 PDF。\n` +
        `下一步（二选一）：把关键页**截图**传上来（图片那条路是通的，能识图），或让家长口述要点。`
    );
  }
  return { text, pages, truncated, emptyPages };
}

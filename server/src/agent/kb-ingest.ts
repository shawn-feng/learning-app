/**
 * KB P3 阶段②：**入库管道的文本化**（2026-09-25）。
 *
 * ## 一句话职责
 * 把家长放进资料库的文件**变成可以检索的正文**，灌进条目的 `body`。
 *
 * ## 最重要的一条边界：提取产物**永远不是权威**
 * `body` 不是"家长认过的话"。方案 §3.4.1 的结论很硬：**LLM/提取只能产出「描述」，产不出「指令」**
 * ——所以提取结果**只能进 `body`**，`summary` 永远留给家长口述（见 `docs/知识库-完整方案-2026-09-26.md` §3.3.5、
 * §3.4.1）。`kb_lookup` 也**从不返回 `body`**：没经家长逐字看过的文本不能当依据。
 * 那 `body` 有什么用？**给向量召回提供匹配面**（"孩子换个问法也能找到这条条目"），
 * 以及让家长在条目里看到"这份资料讲的是什么"。
 *
 * ## 为什么是同步函数、不定 worker
 * html/md/txt 的文本化是**纯本地、毫秒级**的，做成队列只会让"家长说一句、等半天"。
 * 方案 §5.1 写的是"入库管道（worker）"——真正的 worker 化留给**重活**（PDF 解析、图片 OCR、
 * 网页抓取），这三样才值得排队。**别为了对齐文档措辞把一件快事做成异步。**
 *
 * ## 支持范围（P3 阶段②）
 * `html/htm`、`md`、`txt`。**PDF 与图片暂不支持**：PDF 要引纯 JS 解析依赖（方案 §5.5.3 风险 2 明写
 * "打包阶段实测"），图片要走视觉模型；两者都单独做增量，不在这里偷偷降级成"提取了个空"。
 * 遇到不支持的类型**如实报错并给出下一步**，不返回空正文让上游以为成功了。
 */

/** 正文上限：`body` 不参与提示词，但要防"一份 10MB 的 html 把库撑爆" */
export const KB_BODY_MAX = 20000;

export type IngestKind = "html" | "md" | "txt";

export interface IngestResult {
  kind: IngestKind;
  text: string;
  chars: number;
  truncated: boolean;
}

/** 扩展名 → 能否文本化（`null` = 不支持，调用方给可操作的话） */
export function ingestKindOf(relPath: string): IngestKind | null {
  const ext = String(relPath ?? "").toLowerCase().split(".").pop() ?? "";
  if (ext === "html" || ext === "htm") return "html";
  if (ext === "md" || ext === "markdown") return "md";
  if (ext === "txt") return "txt";
  return null;
}

const ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  middot: "·",
  times: "×",
  copy: "©",
  deg: "°",
};

export function decodeEntities(s: string): string {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => {
      const n = Number.parseInt(h, 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&#(\d+);/g, (_m, d) => {
      const n = Number.parseInt(d, 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : "";
    })
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[String(name).toLowerCase()] ?? m);
}

/**
 * HTML → 纯文本。
 *
 * 三条取舍：
 * 1. **先删 `script`/`style`/注释**，再剥标签——反过来会把 js 源码当正文灌进 `body`，
 *    向量会被一堆变量名污染（实测过的经典坑）。
 * 2. **块级标签换成换行**（`</p>`/`<br>`/`</li>`/`</h1>`…），否则整页挤成一行，可读性与分块都废。
 * 3. **不解析表格结构**：`<td>` 之间补一个制表位即可，别指望还原成表格——这一层只服务检索与"讲的是什么"。
 */
export function htmlToText(html: string): string {
  let s = String(html ?? "");
  s = s.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  // 块级边界 → 换行
  s = s.replace(/<\s*(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<\/\s*(p|div|section|article|header|footer|li|ul|ol|tr|h[1-6]|blockquote|pre|table)\s*>/gi, "\n");
  // 单元格之间给个分隔，别把两列粘成一个词（后面会统一折叠成单个空格）
  s = s.replace(/<\/\s*(td|th)\s*>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // 行内空白折叠，行保留（最多留一个空行）
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 文本化入口。`raw` 由调用方读盘（本模块**不做 IO**，便于单测，也避免在 db 层引 fs 语义）。
 * 超长截断到 `KB_BODY_MAX` 并在 `truncated` 里标出来（上游要如实告诉家长"只收了前 2 万字"）。
 */
export function textify(raw: string, relPath: string, maxChars = KB_BODY_MAX): IngestResult {
  const kind = ingestKindOf(relPath);
  if (!kind) {
    throw new Error(
      `这份资料的格式还不能自动读成文字：${relPath}\n` +
        `（现在支持 .html/.htm、.md、.txt；PDF 与图片要单独做，还没上）\n` +
        `下一步：要么让家长把要点**口述成一句说法**（那条才是最权威的），要么先把它作为"只有资料"的条目挂上去——孩子问到时放给她看。`
    );
  }
  const body = kind === "html" ? htmlToText(raw) : String(raw ?? "").trim();
  const truncated = body.length > maxChars;
  return {
    kind,
    text: truncated ? body.slice(0, maxChars) : body,
    chars: Math.min(body.length, maxChars),
    truncated,
  };
}

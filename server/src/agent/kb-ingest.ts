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

// ==================== 阶段③：长正文分块 ====================

/** 每块目标字数（中文按字符计）。太小会碎、太大会稀释主题——400 是"一段话"的量级。 */
export const KB_CHUNK_SIZE = 400;
/** 同一段落被切开时，相邻块之间的重叠字数（跨块的句子不至于两边都够不着） */
export const KB_CHUNK_OVERLAP = 60;
/** 一份正文最多切多少块（防一份 2 万字资料产生上百次嵌入调用） */
export const KB_CHUNK_MAX = 64;

/** 按句末标点切句，**保留标点**（丢了标点，块读起来会像断句错误） */
function sentencesOf(para: string): string[] {
  return para
    .split(/(?<=[。！？；!?;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `body` → 块（**确定性**：同一份 body 永远切出同一批块）。
 *
 * 为什么确定性这么重要：块要当**向量旁表的主键载体**（`row_pk = [entry_id, seq]`）。
 * 切法一变，同一个 `seq` 就指向了不同的文本——所以"确定性"是这套索引能自洽的前提，
 * 也让"任何时候都能由 body 完整重建"这条正确性判据成立（见 `replaceKbChunks`）。
 *
 * 切法（三条，按优先级）：
 * 1. **段落优先**：按空行切；够短的段落尽量合并到一块（凑到 `size` 附近），别切成一堆碎块；
 * 2. **超长段落按句切**，块间带 `overlap` 重叠（同一段被切开时，跨块的句子两边都够得着）；
 * 3. **去掉重复块**（页眉页脚/重复小标题常切出完全一样的块，留着只会污染向量）。
 */
export function chunkText(
  text: string,
  opts?: { size?: number; overlap?: number; maxChunks?: number }
): string[] {
  const size = Math.max(80, Number(opts?.size) || KB_CHUNK_SIZE);
  const overlap = Math.max(0, Math.min(Number(opts?.overlap ?? KB_CHUNK_OVERLAP) || 0, Math.floor(size / 2)));
  const maxChunks = Math.max(1, Number(opts?.maxChunks) || KB_CHUNK_MAX);
  const norm = String(text ?? "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!norm) return [];

  const out: string[] = [];
  const push = (s: string): void => {
    const t = s.trim();
    if (t) out.push(t);
  };
  let pending = "";
  for (const raw of norm.split(/\n{2,}/)) {
    const para = raw.trim();
    if (!para) continue;
    if (para.length <= size) {
      // 短段落：能并就并，别把"一句话的段落"切成独立块
      if (pending && pending.length + para.length + 1 <= size) pending = `${pending}\n${para}`;
      else {
        push(pending);
        pending = para;
      }
      continue;
    }
    // 超长段落：先冲掉 pending，再按句切，块间带重叠
    push(pending);
    pending = "";
    let buf = "";
    for (const sent of sentencesOf(para)) {
      // 单句本身超长（无标点的长串）→ 硬切
      if (sent.length > size) {
        push(buf);
        buf = "";
        for (let i = 0; i < sent.length; i += size - overlap) {
          // 尾巴已被前一块覆盖就别再吐一块：`step = size - overlap` 意味着前一块的右边
          // 伸到了 `i + overlap`，剩下的若不超过 overlap，就是纯冗余（会切出「。」这种 1 字块）。
          if (i > 0 && sent.length - i <= overlap) break;
          push(sent.slice(i, i + size));
        }
        continue;
      }
      if (buf && buf.length + sent.length > size) {
        push(buf);
        buf = buf.slice(-overlap) + sent;
      } else {
        buf += sent;
      }
    }
    pending = buf;
  }
  push(pending);

  // 去重（保持首次出现的顺序）+ 上限
  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const c of out) {
    if (seen.has(c)) continue;
    seen.add(c);
    uniq.push(c);
  }
  return uniq.slice(0, maxChunks);
}


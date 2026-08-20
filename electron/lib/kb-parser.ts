/**
 * 知识库 markdown 结构解析器（纯函数，无 IO，可单测）。
 *
 * 依据 LEARNING-DATA-SPEC.md 5.3：kb_read / kb_patch / kb_append 共用。
 *
 * 结构约定（SPEC 第三章）：
 * - frontmatter：文件头 `---\n…\n---`（YAML）
 * - 区块（block）：`## 标题`，到下一个 `##` 或文件尾
 * - 条目（item）：`### 标题`，到下一个 `###` 或下一个 `##` 或文件尾
 * - 字段两种格式（每行独立检测，行首 `- ` → A 格式，否则 B 格式）：
 *   A（daily/索引）：`- 键：值`（键与值之间全角「：」或半角 ":"）
 *   B（进度条目）：`键:: 值`（双冒号 + 空格）
 *
 * 定位可靠性：靠标题层级结构锚点（区块/条目标题、序号），不依赖行号缓存与文本唯一性
 * （SPEC 5.3「实现要求」：先整体解析验证再写回，不做部分写入）。
 */

export interface Block {
  /** `## ` 之后的标题文本（trim） */
  title: string;
  /** 区块起始行号（含 ## 标题行，0-based） */
  start: number;
  /** 区块结束行号（不含，即下一区块起始或文件行数） */
  end: number;
  /** 该区块全部行（含 ## 标题行） */
  lines: string[];
}

export interface Item {
  /** `### ` 之后的标题文本（trim） */
  title: string;
  /** 条目起始行号（含 ### 标题行，0-based） */
  start: number;
  /** 条目结束行号（不含） */
  end: number;
  /** 该条目全部行（含 ### 标题行） */
  lines: string[];
}

export type FieldSep = "dash-colon" | "dcolon";

export interface FieldHit {
  key: string;
  value: string;
  /** 字段行在所属 lines 数组中的行号（0-based） */
  lineIndex: number;
  sep: FieldSep;
}

const BLOCK_RE = /^##\s+(.+)$/;
const ITEM_RE = /^###\s+(.+)$/;
/** B 格式：`键:: 值`（键不含冒号，避免与 `a: b:: c` 混淆） */
const DCOLON_RE = /^([^：:]+)::\s*(.*)$/;
/** A 格式：`- 键：值`（键不含冒号；分隔符为全角「：」或半角 ":"） */
const DASH_COLON_RE = /^-\s*([^：:]+?)\s*[：:]\s*(.*)$/;

/** 提取文件头 frontmatter；无则返回 null。返回 { data, body }（body 不含 frontmatter 块）。 */
export function extractFrontmatter(text: string): { data: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return null;
  return { data: m[1], body: text.slice(m[0].length) };
}

/** 按行切区块（`## 标题` → 下一个 `##` 或行尾）。返回空数组表示无区块。 */
export function splitBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let start = -1;
  let title = "";
  for (let i = 0; i <= lines.length; i++) {
    const line = i < lines.length ? lines[i] : "";
    const isBlockHead = i < lines.length && BLOCK_RE.test(line);
    if (isBlockHead) {
      if (start >= 0) {
        blocks.push({ title, start, end: i, lines: lines.slice(start, i) });
      }
      start = i;
      title = line.replace(BLOCK_RE, "$1").trim();
    } else if (start >= 0 && i === lines.length) {
      blocks.push({ title, start, end: i, lines: lines.slice(start, i) });
    }
  }
  return blocks;
}

/**
 * 定位区块：字符串 → 标题精确匹配；数字 → 1-based 序号。
 * 同标题取第一个（recording 规范保证区块标题在单文件内唯一）。
 */
export function findBlock(blocks: Block[], target: string | number): Block | null {
  if (typeof target === "number") {
    return target >= 1 && target <= blocks.length ? blocks[target - 1] : null;
  }
  return blocks.find((b) => b.title === target) ?? null;
}

/** 在区块内按行切条目（`### 标题` → 下一个 `###`/`##`/行尾）。 */
export function splitItems(blockLines: string[]): Item[] {
  const items: Item[] = [];
  let start = -1;
  let title = "";
  for (let i = 0; i <= blockLines.length; i++) {
    const line = i < blockLines.length ? blockLines[i] : "";
    const isItemHead = i < blockLines.length && ITEM_RE.test(line);
    const isNextBlock = i < blockLines.length && BLOCK_RE.test(line);
    if (isItemHead) {
      if (start >= 0) {
        items.push({ title, start, end: i, lines: blockLines.slice(start, i) });
      }
      start = i;
      title = line.replace(ITEM_RE, "$1").trim();
    } else if (start >= 0 && (isNextBlock || i === blockLines.length)) {
      items.push({ title, start, end: i, lines: blockLines.slice(start, i) });
      start = -1;
    }
  }
  return items;
}

/**
 * 定位条目：字符串 → 标题精确匹配；数字 → 区块内 1-based 序号。
 * 同标题取第一个。
 */
export function findItem(items: Item[], target: string | number): Item | null {
  if (typeof target === "number") {
    return target >= 1 && target <= items.length ? items[target - 1] : null;
  }
  return items.find((it) => it.title === target) ?? null;
}

/** 解析单行字段。行首 `- ` → A 格式；否则尝试 B 格式。非字段行返回 null。
 *  键支持 markdown 加粗修饰（`**键：** 值`，渲染用），解析时剥离星号；值若以闭合星号开头（`** `）同样剥离。 */
export function parseFieldLine(line: string): FieldHit | null {
  const stripBold = (s: string) => s.replace(/^\*\*/, "").replace(/\*\*$/, "");
  if (/^-\s/.test(line)) {
    const m = DASH_COLON_RE.exec(line);
    if (!m) return null;
    let value = m[2].trim();
    if (value.startsWith("**")) value = value.replace(/^\*\*/, "").trim();
    return { key: stripBold(m[1].trim()), value, lineIndex: -1, sep: "dash-colon" };
  }
  const m = DCOLON_RE.exec(line);
  if (!m) return null;
  return { key: stripBold(m[1].trim()), value: m[2].trim(), lineIndex: -1, sep: "dcolon" };
}

/** 在条目内定位字段（键精确匹配，取第一个）。 */
export function findField(item: Item, field: string): FieldHit | null {
  for (let i = 0; i < item.lines.length; i++) {
    const hit = parseFieldLine(item.lines[i]);
    if (hit && hit.key === field) {
      return { ...hit, lineIndex: i };
    }
  }
  return null;
}

/** 从整段文本中列出指定区块内全部条目标题（供 month 聚合 / listOnly 使用）。 */
export function listItemTitles(text: string, blockTitle?: string): { block: string; items: string[] }[] {
  const lines = text.split(/\r?\n/);
  const blocks = splitBlocks(lines);
  return blocks
    .filter((b) => !blockTitle || b.title === blockTitle)
    .map((b) => ({
      block: b.title,
      items: splitItems(b.lines).map((it) => it.title),
    }));
}

/**
 * 替换条目内某字段行的值（按结构定位，保留原分隔符与行尾）。返回替换后的行数组。
 * 字段不存在时返回 { hit: null, lines }（由调用方决定报错）。
 */
export function updateFieldValue(lines: string[], field: string, newValue: string): { lines: string[]; hit: FieldHit | null } {
  for (let i = 0; i < lines.length; i++) {
    const hit = parseFieldLine(lines[i]);
    if (hit && hit.key === field) {
      const prefix = lines[i].slice(0, lines[i].length - hit.value.length);
      const updated = [...lines];
      updated[i] = prefix + newValue;
      return { lines: updated, hit: { ...hit, lineIndex: i } };
    }
  }
  return { lines, hit: null };
}

/**
 * 在区块内追加条目（`### 标题 + 字段行`），追加到区块尾（最后一个 ### 条目之后、区块结束之前）。
 * 区块不存在返回 null。
 */
export function appendItemToBlock(lines: string[], blockTitle: string, content: string): { lines: string[]; block: Block | null } {
  const blocks = splitBlocks(lines);
  const block = findBlock(blocks, blockTitle);
  if (!block) return { lines, block: null };
  const insertAt = block.end; // 区块结束处（下一区块起始或文件尾）
  // 若文件尾/区块边界前有空白行，插入点前移，避免重复空行
  let at = insertAt;
  while (at > block.start && lines[at - 1].trim() === "") at--;
  const chunk = content.split(/\r?\n/);
  const updated = [...lines.slice(0, at), ...chunk, "", ...lines.slice(at)];
  return { lines: updated, block };
}

/** 校验文本是否为合法条目块（以 `### ` 开头，且非空）。 */
export function isItemChunk(content: string): boolean {
  const lines = content.split(/\r?\n/);
  return lines.length > 0 && ITEM_RE.test(lines[0]);
}

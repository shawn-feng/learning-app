/**
 * 知识库数据格式校验（lint）核心——确定性脚本，不靠 AI 判断。
 *
 * 依据 LEARNING-DATA-SPEC.md 5.5。校验规则：
 * 1. 目录结构：daily/learning/life/inquiries/tasks/tags/outputs 存在
 * 2. daily 文件名：YYYY-MM-DD.md
 * 3. 字段白名单：daily 各区块字段 ⊂ kb-schema 白名单；进度条目字段 ⊂ PROGRESS_FIELDS
 * 4. 格式一致性：daily/索引用 `- 键：值`，进度条目用 `键:: 值`（不混用）
 * 5. 取值约束：`状态::` ∈ {⬜,✅}；`tags::` 值 ∈ taxonomy 词表
 * 6. 索引指针三级校验：文件存在 → ## 区块存在 → 同标题 ### 条目存在（同名约束 3.6/3.7）
 * 7. frontmatter 可解析：topics.md 有 topics、rules.md 有 rules
 *
 * 纯 node（无 electron 依赖），CLI（scripts/kb-lint.mjs）与主进程共用。
 */

import fs from "fs";
import path from "path";
import { extractFrontmatter, parseFieldLine, splitBlocks, splitItems } from "./kb-parser.ts";
import {
  DAILY_BLOCKS,
  DAILY_FIELDS,
  PROGRESS_FIELDS,
  PROGRESS_FRONTMATTER,
  PROGRESS_STATUS_VALUES,
} from "./kb-schema.ts";

export type LintKind =
  | "structure"
  | "filename"
  | "field"
  | "format"
  | "value"
  | "pointer"
  | "frontmatter";

export interface LintIssue {
  file: string;
  line?: number;
  kind: LintKind;
  /** 缺省 error（结构性破坏）；字段不在白名单 = warning（历史基线/字段变体，供人工判断） */
  severity?: "error" | "warning";
  message: string;
}

const DAILY_NAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const REQUIRED_DIRS = ["daily", "learning", "life", "inquiries", "tasks", "tags", "outputs"];

/** 从 taxonomy.md 提取合法标签集合（正文 `- 标签名：释义` 行）。 */
function loadTaxonomyTags(childDir: string): Set<string> {
  const tags = new Set<string>();
  const p = path.join(childDir, "tags", "taxonomy.md");
  if (!fs.existsSync(p)) return tags;
  const text = fs.readFileSync(p, "utf-8");
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s*([^：:]+?)\s*[：:]/.exec(line.trim());
    if (m) tags.add(m[1].trim());
  }
  return tags;
}

/** 校验 daily/ 下所有文件。 */
function lintDaily(childDir: string, issues: LintIssue[]) {
  const dir = path.join(childDir, "daily");
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const rel = `daily/${f}`;
    if (!DAILY_NAME_RE.test(f)) {
      issues.push({ file: rel, kind: "filename", message: `文件名应为 YYYY-MM-DD.md（实际: ${f}）` });
      continue;
    }
    const text = fs.readFileSync(path.join(dir, f), "utf-8");
    const fm = extractFrontmatter(text);
    const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
    const blocks = splitBlocks(bodyLines);
    for (const block of blocks) {
      // daily 允许附加「内容型」## 区块（如 study-tracker 的评估区块），
      // 不检查其内部字段；仅对 4 个结构化区块做字段/格式校验
      if (!(DAILY_BLOCKS as readonly string[]).includes(block.title)) continue;
      const legal = DAILY_FIELDS[block.title];
      const items = splitItems(block.lines);
      for (const item of items) {
        for (let i = 0; i < item.lines.length; i++) {
          const line = item.lines[i];
          const hit = parseFieldLine(line);
          if (!hit) continue;
          if (hit.sep !== "dash-colon") {
            issues.push({
              file: rel,
              line: block.start + item.start + i + 1,
              kind: "format",
              message: `「${block.title}」区块字段应用 \`- 键：值\` 格式（实际: ${line.trim()}）`,
            });
          }
          if (!legal.includes(hit.key)) {
            issues.push({
              file: rel,
              line: block.start + item.start + i + 1,
              kind: "field",
              severity: "warning",
              message: `「${block.title}」区块字段「${hit.key}」不在白名单（合法: ${legal.join("/")}；历史基线/字段变体可人工判断）`,
            });
          }
        }
      }
    }
  }
}

/** 校验 learning/{topic}/{topic}.md 进度文件。 */
function lintProgress(childDir: string, issues: LintIssue[], taxonomy: Set<string>) {
  const learningDir = path.join(childDir, "learning");
  if (!fs.existsSync(learningDir)) return;
  for (const topic of fs.readdirSync(learningDir)) {
    const progressFile = path.join(learningDir, topic, `${topic}.md`);
    if (!fs.existsSync(progressFile)) continue;
    const rel = `learning/${topic}/${topic}.md`;
    const text = fs.readFileSync(progressFile, "utf-8");
    const fm = extractFrontmatter(text);
    if (fm) {
      for (const line of fm.data.split(/\r?\n/)) {
        const m = /^([A-Za-z_][\w]*):/.exec(line);
        if (m && !(PROGRESS_FRONTMATTER as readonly string[]).includes(m[1])) {
          issues.push({ file: rel, kind: "frontmatter", message: `frontmatter 非法键「${m[1]}」（合法: ${PROGRESS_FRONTMATTER.join("/")}）` });
        }
      }
    }
    const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
    const items = splitItems(bodyLines); // 进度文件无 ## 区块，全文件按条目切
    for (const item of items) {
      for (let i = 0; i < item.lines.length; i++) {
        const line = item.lines[i];
        const hit = parseFieldLine(line);
        if (!hit) continue;
        if (hit.sep !== "dcolon") {
          issues.push({
            file: rel,
            line: (fm ? fm.data.split(/\r?\n/).length + 2 : 0) + item.start + i + 1,
            kind: "format",
            message: `进度条目字段应用 \`键:: 值\` 格式（实际: ${line.trim()}）`,
          });
        }
        if (!(PROGRESS_FIELDS as readonly string[]).includes(hit.key)) {
          issues.push({
            file: rel,
            kind: "field",
            severity: "warning",
            message: `进度条目字段「${hit.key}」不在白名单（合法: ${PROGRESS_FIELDS.join("/")}；历史基线/字段变体可人工判断）`,
          });
        }
        if (hit.key === "状态" && !(PROGRESS_STATUS_VALUES as readonly string[]).includes(hit.value)) {
          issues.push({ file: rel, kind: "value", message: `状态:: 取值非法「${hit.value}」（合法: ${PROGRESS_STATUS_VALUES.join("/")}）` });
        }
        if (hit.key === "tags" && hit.value) {
          const inside = hit.value.replace(/^\[|\]$/g, "");
          for (const t of inside.split(/[,\s]+/).filter(Boolean)) {
            const clean = t.trim();
            if (clean && !taxonomy.has(clean)) {
              issues.push({ file: rel, kind: "value", message: `tags:: 含非词表标签「${clean}」（见 tags/taxonomy.md）` });
            }
          }
        }
      }
    }
  }
}

/** 索引指针三级校验：①文件存在 ②## 区块存在 ③同标题 ### 条目存在（同名约束）。 */
function checkPointer(childDir: string, issues: LintIssue[], indexFile: string, title: string, pointer: string, lineNo: number) {
  const m = /^daily\/(\d{4}-\d{2}-\d{2}\.md)#(\S+)$/.exec(pointer.trim());
  if (!m) {
    issues.push({ file: indexFile, line: lineNo, kind: "pointer", message: `关联指针格式非法: ${pointer}` });
    return;
  }
  const dailyFile = path.join(childDir, "daily", m[1]);
  if (!fs.existsSync(dailyFile)) {
    issues.push({ file: indexFile, line: lineNo, kind: "pointer", message: `指针目标文件不存在: daily/${m[1]}` });
    return;
  }
  const text = fs.readFileSync(dailyFile, "utf-8");
  const fm = extractFrontmatter(text);
  const bodyLines = (fm ? fm.body : text).split(/\r?\n/);
  const blocks = splitBlocks(bodyLines);
  const block = blocks.find((b) => b.title === m[2]);
  if (!block) {
    issues.push({ file: indexFile, line: lineNo, kind: "pointer", message: `daily/${m[1]} 无 ## 区块「${m[2]}」` });
    return;
  }
  const items = splitItems(block.lines);
  if (title && !items.some((it) => it.title === title)) {
    issues.push({
      file: indexFile,
      line: lineNo,
      kind: "pointer",
      message: `同名约束违反：索引标题「${title}」在 daily/${m[1]} 的「${m[2]}」区块无同名 ### 条目（可选: ${items.map((i) => i.title).join("、") || "无"}）`,
    });
  }
}

/** 校验 life/ inquiries/ tasks/ 月索引。 */
function lintIndexes(childDir: string, issues: LintIssue[]) {
  for (const kind of ["life", "inquiries", "tasks"]) {
    const dir = path.join(childDir, kind);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const rel = `${kind}/${f}`;
      const lines = fs.readFileSync(path.join(dir, f), "utf-8").split(/\r?\n/);
      let currentTitle = "";
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const titleM = /^##\s+(.+)$/.exec(line);
        if (titleM) {
          currentTitle = titleM[1].trim();
          continue;
        }
        const ptrM = /关联\s*[:：]\s*(daily\/\S+)/.exec(line);
        if (ptrM) {
          checkPointer(childDir, issues, rel, currentTitle, ptrM[1], i + 1);
        }
      }
    }
  }
}

/** 校验 topics.md / rules.md frontmatter 关键键存在。 */
function lintTopicsRules(childDir: string, issues: LintIssue[]) {
  for (const [rel, key] of [
    ["learning/topics.md", "topics"],
    ["learning/rules.md", "rules"],
  ] as const) {
    const p = path.join(childDir, rel);
    if (!fs.existsSync(p)) {
      issues.push({ file: rel, kind: "frontmatter", message: "文件缺失" });
      continue;
    }
    const text = fs.readFileSync(p, "utf-8");
    const fm = extractFrontmatter(text);
    if (!fm) {
      issues.push({ file: rel, kind: "frontmatter", message: "缺少 YAML frontmatter" });
    } else if (!new RegExp(`^${key}\\s*:`, "m").test(fm.data)) {
      issues.push({ file: rel, kind: "frontmatter", message: `frontmatter 缺少「${key}:」键` });
    }
  }
}

/** 校验单个孩子目录，返回全部违规。 */
export function lintChildDir(childDir: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const base = path.basename(childDir);

  // 1. 目录结构
  for (const d of REQUIRED_DIRS) {
    if (!fs.existsSync(path.join(childDir, d))) {
      issues.push({ file: `${d}/`, kind: "structure", message: `必需目录缺失: ${d}/` });
    }
  }

  // 2-4. daily
  lintDaily(childDir, issues);

  // 3-5. 进度文件 + tags 词表
  const taxonomy = loadTaxonomyTags(childDir);
  lintProgress(childDir, issues, taxonomy);

  // 6. 索引指针三级校验
  lintIndexes(childDir, issues);

  // 7. topics/rules frontmatter
  lintTopicsRules(childDir, issues);

  return issues.map((it) => ({ ...it, file: `${base}/${it.file}` }));
}

/** 遍历 children 目录下所有孩子执行 lint，并把报告写到各孩子目录 lint-report.md。返回违规总数。 */
export function lintAllChildren(dataDir: string): { childId: string; issues: LintIssue[] }[] {
  const childrenDir = path.join(dataDir, "children");
  const results: { childId: string; issues: LintIssue[] }[] = [];
  if (!fs.existsSync(childrenDir)) return results;
  for (const childId of fs.readdirSync(childrenDir)) {
    const childDir = path.join(childrenDir, childId);
    if (!fs.statSync(childDir).isDirectory()) continue;
    // 只检查真实孩子（有 profile.json）；跳过测试残留/空目录（ans-*/cont-* 等）
    if (!fs.existsSync(path.join(childDir, "profile.json"))) continue;
    const issues = lintChildDir(childDir);
    results.push({ childId, issues });
    writeReport(childDir, childId, issues);
  }
  return results;
}

/** 写 lint-report.md 到孩子目录（无违规时写「无违规」）。error 与 warning 分列。 */
export function writeReport(childDir: string, childId: string, issues: LintIssue[]): void {
  const errors = issues.filter((i) => (i.severity ?? "error") === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const lines: string[] = [
    `# 数据格式检查报告（${childId}）`,
    "",
    `> 生成时间: ${new Date().toISOString()} | error: ${errors.length} | warning: ${warnings.length}`,
    "",
  ];
  if (issues.length === 0) {
    lines.push("✅ 未发现违规。");
  } else {
    if (errors.length) {
      lines.push(`## error（${errors.length}）`, "");
      for (const it of errors) {
        lines.push(`- [${it.kind}] ${it.file}${it.line ? `:${it.line}` : ""} — ${it.message}`);
      }
      lines.push("");
    }
    if (warnings.length) {
      lines.push(`## warning（${warnings.length}）`, "");
      for (const it of warnings) {
        lines.push(`- [${it.kind}] ${it.file}${it.line ? `:${it.line}` : ""} — ${it.message}`);
      }
    }
  }
  fs.writeFileSync(path.join(childDir, "lint-report.md"), lines.join("\n") + "\n", "utf-8");
}

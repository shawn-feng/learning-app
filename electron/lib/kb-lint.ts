/**
 * 知识库数据格式校验（lint）核心——确定性脚本，不靠 AI 判断。
 *
 * 依据 LEARNING-DATA-SPEC.md 5.5 与 ISSUE-023 P2（SQLite 唯一真源）：
 * 数据已全部存 `data/children/<childId>/kb.sqlite`，lint 校验 **SQLite 数据**而非 markdown。
 *
 * 校验规则（SQLite 版，v4）：
 * 1. 结构：kb.sqlite 存在；必需目录（daily/learning/life/inquiries/tasks/tags/outputs）存在
 * 2. courses 状态取值（⬜/✅，值域约束；字段名不做白名单——字段由 method 灵活设定，2026-08-21）
 * 3. 标签合规：daily.tags / courses.tags 的每个标签 ∈ tags 定义表（词表纪律）
 * 4. topics 非空（有主题时）
 * 5. method.md 内 kb 工具引用规范性（ISSUE-022，保留 markdown 内容文件校验）
 *
 * 纯 node（无 electron 依赖），CLI（scripts/kb-lint.mjs）与主进程共用。
 */

import fs from "fs";
import path from "path";
import { openKbDb, queryDaily, queryTags, queryTopicProgress } from "./kb-sqlite.ts";
import {
  PROGRESS_STATUS_VALUES,
  KB_DATA_TOOLS,
  KB_AUX_TOOLS,
  KB_TOOL_REQUIRED,
} from "./kb-schema.ts";

export type LintKind =
  | "structure"
  | "field"
  | "value"
  | "pointer"
  | "frontmatter"
  | "format";

export interface LintIssue {
  file: string;
  line?: number;
  kind: LintKind;
  /** 缺省 error（结构性破坏）；字段不在白名单 = warning（历史基线/字段变体，供人工判断） */
  severity?: "error" | "warning";
  message: string;
}

const REQUIRED_DIRS = ["daily", "learning", "life", "inquiries", "tasks", "tags", "outputs"];

/** 从 tags 定义表提取合法标签集合（SQLite 真源，替代 taxonomy.md 解析）。 */
function loadTagDefSet(childDir: string): Set<string> {
  const tags = new Set<string>();
  for (const d of queryTags(childDir)) tags.add(d.tag);
  return tags;
}

/** 校验 courses 状态取值（⬜/✅；字段名不做白名单——字段由 method 灵活设定）。 */
function lintSqliteProgress(childDir: string, issues: LintIssue[]) {
  const progress = queryTopicProgress(childDir);
  for (const p of progress) {
    for (const it of p.items) {
      if (it.status && !(PROGRESS_STATUS_VALUES as readonly string[]).includes(it.status)) {
        issues.push({
          file: `courses:${p.topic}`,
          kind: "value",
          message: `「${it.title}」状态取值非法「${it.status}」（合法: ${PROGRESS_STATUS_VALUES.join("/")}）`,
        });
      }
    }
  }
}

/** 校验标签合规：daily.tags / courses.tags 的每个标签 ∈ tags 定义表（词表纪律，v4）。 */
function lintSqliteTagCompliance(childDir: string, issues: LintIssue[]) {
  const defs = loadTagDefSet(childDir);
  const check = (where: string, tagsRaw: string, title: string) => {
    if (!tagsRaw) return;
    for (const t of tagsRaw.split(/[,，、\s]+/).filter(Boolean)) {
      const clean = t.trim().replace(/^\[|\]$/g, "");
      if (clean && !defs.has(clean)) {
        issues.push({ file: where, kind: "value", message: `「${title}」含非词表标签「${clean}」（标签只能从 tags 定义表选择）` });
      }
    }
  };
  for (const e of queryDaily(childDir, {})) check(`daily_entries:${e.date}`, e.tags, e.title);
  for (const p of queryTopicProgress(childDir)) {
    for (const it of p.items) check(`courses:${p.topic}`, it.tags, it.title);
  }
}

/** 校验 topics / rules（learning/topics.md / rules.md 的存在性对应；rules 已并入 topics 表）。 */
function lintSqliteTopicsRules(childDir: string, issues: LintIssue[]) {
  const topicsFile = path.join(childDir, "learning", "topics.md");
  const rulesFile = path.join(childDir, "learning", "rules.md");
  if (!fs.existsSync(topicsFile)) {
    issues.push({ file: "topics", kind: "frontmatter", message: "learning/topics.md 缺失（主题清单未配置）" });
  }
  if (!fs.existsSync(rulesFile)) {
    issues.push({ file: "rules", kind: "frontmatter", message: "learning/rules.md 缺失（每日目标未配置）" });
  }
}

/**
 * 校验 learning/{topic}/method.md 内对 kb 工具引用的规范性（ISSUE-022）。
 * 仅检测「代码语境」（``` 围栏代码块 + 行内反引号），避免误伤「禁止 write/edit 裸写」这类教学文案。
 * 三类问题：
 *  1. 引用了不存在/过时的 kb 工具名（如 kb_write / kb_append 等 SQLite 化前旧名）；
 *  2. kb 工具调用示例缺少必需参数；
 *  3. 对数据文件使用裸 write/edit 调用（应走 kb 工具）。
 */
export function lintMethodKbRefs(childDir: string, issues: LintIssue[]) {
  const learningDir = path.join(childDir, "learning");
  if (!fs.existsSync(learningDir)) return;
  for (const topic of fs.readdirSync(learningDir)) {
    const methodFile = path.join(learningDir, topic, "method.md");
    if (!fs.existsSync(methodFile)) continue;
    const rel = `learning/${topic}/method.md`;
    const lines = fs.readFileSync(methodFile, "utf-8").split(/\r?\n/);

    // 规则1：全文扫描 kb_ 工具名合法性（无论是否在代码块，工具名本身应规范）
    const legalKbNames = [
      ...KB_DATA_TOOLS,
      ...KB_AUX_TOOLS.filter((t) => t.startsWith("kb_")),
    ];
    for (let i = 0; i < lines.length; i++) {
      const re = /\bkb_([a-zA-Z_]\w*)\b/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(lines[i]))) {
        const name = "kb_" + m[1];
        if (!(legalKbNames as readonly string[]).includes(name)) {
          issues.push({
            file: rel,
            line: i + 1,
            kind: "field",
            severity: "warning",
            message: `引用了非标准/过时 kb 工具名「${name}」（合法: ${legalKbNames.join("/")}）`,
          });
        }
      }
    }

    // 提取代码语境：``` 围栏块 + 行内反引号
    const codeSegments: { text: string; line: number }[] = [];
    let inFence = false;
    let fenceBuf: string[] = [];
    let fenceStart = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*```/.test(line)) {
        if (inFence) {
          codeSegments.push({ text: fenceBuf.join("\n"), line: fenceStart });
          inFence = false;
          fenceBuf = [];
        } else {
          inFence = true;
          fenceStart = i + 1;
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(line);
      } else {
        const inline = line.match(/`([^`]+)`/g);
        if (inline) for (const seg of inline) codeSegments.push({ text: seg.slice(1, -1), line: i + 1 });
      }
    }

    for (const seg of codeSegments) {
      // 规则2：kb 数据工具调用参数检查（仅当工具名后跟 { 视为调用）
      for (const tool of KB_DATA_TOOLS) {
        const callRe = new RegExp("\\b" + tool + "\\s*\\{", "g");
        let cm: RegExpExecArray | null;
        while ((cm = callRe.exec(seg.text))) {
          const obj = extractBalancedBraces(seg.text, cm.index + cm[0].length - 1);
          const body = obj ?? "";
          const missing = (KB_TOOL_REQUIRED[tool] ?? []).filter(
            (r) => !new RegExp("\\b" + r + "\\b").test(body)
          );
          if (missing.length) {
            issues.push({
              file: rel,
              line: seg.line,
              kind: "format",
              severity: "warning",
              message: `${tool} 调用示例缺少必需参数: ${missing.join("/")}`,
            });
          }
        }
      }
      // 规则3：数据文件裸 write/edit 调用（应走 kb 工具）
      const dataPathRe = /\b(daily\/|learning\/[^\s"`]+?\/[^\s"`]+\.md|life\/|inquiries\/|tasks\/|tags\/)/;
      const writeCallRe = /\b(?:write|edit)\s*\(/;
      if (dataPathRe.test(seg.text) && writeCallRe.test(seg.text)) {
        issues.push({
          file: rel,
          line: seg.line,
          kind: "format",
          severity: "warning",
          message: `数据文件不应裸 write/edit，应走 kb 工具（kb_query / kb_insert / kb_update）`,
        });
      }
    }
  }
}

/** 从文本指定位置提取平衡括号包裹的对象体（text[startIdx] 应为 '{'）。 */
function extractBalancedBraces(text: string, startIdx: number): string | null {
  let depth = 0;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return null;
}

/** 校验单个孩子目录，返回全部违规。 */
export function lintChildDir(childDir: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const base = path.basename(childDir);

  // 1. 结构：kb.sqlite 存在 + 必需目录存在
  if (!fs.existsSync(path.join(childDir, "kb.sqlite"))) {
    issues.push({ file: "kb.sqlite", kind: "structure", message: "kb.sqlite 不存在（数据未迁移到 SQLite）" });
  } else {
    for (const d of REQUIRED_DIRS) {
      if (!fs.existsSync(path.join(childDir, d))) {
        issues.push({ file: `${d}/`, kind: "structure", message: `必需目录缺失: ${d}/` });
      }
    }
  }

  // 2. SQLite 数据校验
  lintSqliteProgress(childDir, issues);
  lintSqliteTagCompliance(childDir, issues);
  lintSqliteTopicsRules(childDir, issues);

  // 3. method.md 内 kb 工具引用规范性（ISSUE-022）
  lintMethodKbRefs(childDir, issues);

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

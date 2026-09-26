import { describe, it, expect, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// 纯 node 环境没有 electron：打桩。
vi.mock("electron", () => ({ app: undefined, protocol: undefined }));

const mockTmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "assess-guide-"));
vi.mock("../electron/lib/config", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../electron/lib/config")>();
  return {
    ...mod,
    getDataDir: () => mockTmpRoot,
    getLicensePath: () => path.join(mockTmpRoot, "license.json"),
    getChildrenDir: () => path.join(mockTmpRoot, "children"),
    getSharedDir: () => path.join(mockTmpRoot, "shared"),
  };
});

import {
  COURSE_ASSESS_GUIDE_MD,
  ASSESS_GUIDE_FILENAME,
  ensureAssessGuideFile,
} from "../electron/lib/assess-guide";

/**
 * 从文档的「整课保存示例」段里抽出那份 JSON（agent 会照着抄，所以它必须始终可 parse）。
 * 示例是**跨多行**的（`{"items":[` … `]}`），所以按花括号配平取整块，并正确跳过字符串里的引号/转义
 * （示例里的 `scoring` 正是"JSON 字符串"，满是 `\"`）。
 */
function extractExampleJson(md: string): any {
  const at = md.indexOf('{"items"');
  if (at < 0) throw new Error("文档里找不到整课保存示例 JSON");
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = at; i < md.length; i++) {
    const ch = md[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(md.slice(at, i + 1));
    }
  }
  throw new Error("整课保存示例 JSON 没有闭合");
}

describe("ISSUE-066 assess-guide：考核内容编写规范文档", () => {
  it("ensureAssessGuideFile 幂等写到 data/.pi/agent/<文件名> 且内容为内置文档", () => {
    const p = ensureAssessGuideFile();
    expect(p.endsWith(path.join(".pi", "agent", ASSESS_GUIDE_FILENAME))).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    expect(fs.readFileSync(p, "utf-8")).toBe(COURSE_ASSESS_GUIDE_MD);
    // 幂等：二次调用不抛错、不改变内容
    ensureAssessGuideFile();
    expect(fs.readFileSync(p, "utf-8")).toBe(COURSE_ASSESS_GUIDE_MD);
  });

  // 2026-09-25 修正：原「原文背诵：…“原文”」正则契约测试已失效——那是**三段 markdown 考核要点**
  // 时代的格式，引擎侧的 RECITATION_MARK_RE 已随知识点制删除（`courses.assess_rubric` 也废弃了）。
  // 现在这份文档是**知识点制**（knowledgePoint + detail → questions，题级 behavior）的编写规范，
  // 于是改钉两件对当下真正要紧的事：① 示例 JSON 必须可 parse、结构符合文档承诺（模型会照抄）；
  // ② 关键契约（工具名/字段名/废弃声明）必须在文档里写明。
  it("「整课保存示例」是可 parse 的 JSON，且结构与文档承诺一致（模型会照抄它）", () => {
    const payload = extractExampleJson(COURSE_ASSESS_GUIDE_MD);
    expect(Array.isArray(payload.items)).toBe(true);
    expect(payload.items.length).toBeGreaterThan(0);
    for (const item of payload.items) {
      expect(typeof item.knowledgePoint).toBe("string");
      expect(item.knowledgePoint.length).toBeGreaterThan(0);
      // detail（考核要点）是知识点制的地基：文档明写"务必详细"，示例不能是空的
      expect(typeof item.detail).toBe("string");
      expect(item.detail.length).toBeGreaterThan(0);
      expect(Array.isArray(item.questions)).toBe(true);
      for (const q of item.questions) {
        expect(typeof q.stem).toBe("string");
        expect(typeof q.answer).toBe("string");
      }
    }
    // 背诵题示例：题级 behavior 显式给 speech_recite，answer 是逐字原文（发音评测 refText）
    const recite = payload.items.flatMap((i: any) => i.questions).find((q: any) => q.behavior === "speech_recite");
    expect(recite).toBeTruthy();
    expect(recite.answer).toContain("学而时习之");
    // 口述题示例的 scoring 是**JSON 字符串**（文档要求的那种双重转义写法）——它也得能 parse
    const generic = payload.items.flatMap((i: any) => i.questions).find((q: any) => q.scoring);
    expect(generic).toBeTruthy();
    const scoring = JSON.parse(generic.scoring);
    expect(Array.isArray(scoring.dims)).toBe(true);
  });

  it("文档含知识点制的关键契约（工具名 / 字段名 / 旧 rubric 已废弃 / 不编造）", () => {
    const md = COURSE_ASSESS_GUIDE_MD;
    // 工具面：主入口 + 方法设置 + 写前核对
    for (const t of ["assess_content_save", "assess_method_set", "assess_knowledge_points_list", "assess_course_get"]) {
      expect(md).toContain(t);
    }
    // 字段契约
    for (const k of ["knowledgePoint", "detail", "behavior", "speech_recite", "speech_read", "requireText"]) {
      expect(md).toContain(k);
    }
    // 旧字段已废弃（防止文档又把模型带回去写三段 markdown）
    expect(md).toContain("assess_rubric");
    expect(md).toMatch(/已废弃/);
    // 写作纪律：不许编造原文
    expect(md).toMatch(/不编造原文与知识点/);
  });
});

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
    getSkillsDir: () => path.join(mockTmpRoot, "shared", "skills"),
  };
});

import {
  COURSE_ASSESS_GUIDE_MD,
  ASSESS_GUIDE_FILENAME,
  ensureAssessGuideFile,
} from "../electron/lib/assess-guide";

// 与 exam-engine.ts L42 RECITATION_MARK_RE 保持一致（契约测试：若引擎正则改动此处需同步）。
const RECITATION_MARK_RE = /原文背诵[^“”"\n]*?[：:][^\n]*?[“"]([^”"\n]+)[”"]/g;

function extractRefs(md: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  RECITATION_MARK_RE.lastIndex = 0;
  while ((m = RECITATION_MARK_RE.exec(md)) !== null) out.push(m[1]);
  return out;
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

  it("文档背诵示例的「- 原文背诵：…“原文”」能被引擎同款正则提取标准原文", () => {
    const refs = extractRefs(COURSE_ASSESS_GUIDE_MD);
    expect(refs.length).toBeGreaterThan(0);
    // 文档句法讲解含占位示例（“<要背的原文>”），真实示例行应能提取到论语原文
    const real = refs.find((r) => r.includes("学而时习之"));
    expect(real).toBeTruthy();
    expect(real).not.toMatch(/[“”"]$/); // 提取结果不含引号本身
    // 任一提取项都来自引号内（不带“原文背诵”提示词前缀）
    for (const r of refs) expect(r).not.toContain("原文背诵");
  });

  it("文档含三部分骨架与关键约束（弯引号/不考背诵/对准真实资料）", () => {
    expect(COURSE_ASSESS_GUIDE_MD).toContain("一、考核知识点");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("二、现成题目");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("三、评分标准");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("原文必须放在中文弯引号");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("不要编造原文");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("assessMethod");
    expect(COURSE_ASSESS_GUIDE_MD).toContain("assessRubric");
  });
});

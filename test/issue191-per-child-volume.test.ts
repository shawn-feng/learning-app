/**
 * ISSUE-191：录音音量阈值改为「按孩子单独设置」。
 *
 * 覆盖四层：
 * 1) 服务端配置模型——每孩子覆盖表的解析/夹取、某孩子实际阈值的解析（有单独设置优先，否则回退默认线）、
 *    加密落库往返、合并式更新（旧客户端/局部保存不丢其他孩子的值）。
 * 2) 客户端纯函数——`resolveVolumeThreshold` 同语义；没有 childId（家长端聊天/试音）返回 0（不检测）。
 * 3) 接线守卫——考核下发、服务端评测兜底、孩子端聊天/检测弹框都按孩子取；
 *    家长端聊天（owner="parent"）跳过音量门且不显示实时音量条。
 * 4) 设置页——按孩子列出滑条并随保存提交 minVolumeNormByChild。
 *
 * 阈值本身的口径/门判定仍由 ISSUE-183/189 的测试覆盖，本文件只测「按孩子」这一层。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyAssessmentConfigPatch,
  getMaskedAssessmentConfig,
  loadAssessmentConfig,
  parseVolumeNormByChild,
  resolveMinVolumeNorm,
} from "../server/src/assessment/config";
import { openDb } from "../server/src/db";
import {
  DEFAULT_MIN_VOLUME_NORM,
  resolveVolumeThreshold,
} from "../src/lib/audio-volume";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const dataDirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "issue191-vol-"));
  dataDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dataDirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows 句柄可能延迟释放，忽略 */
    }
  }
});

describe("ISSUE-191 服务端：每孩子阈值配置", () => {
  it("parseVolumeNormByChild：只收合法条目，0-100 夹取，非法/空 key 丢弃", () => {
    expect(parseVolumeNormByChild({ a: 60, b: "35", c: 120, d: -5, e: "abc", "": 50 })).toEqual({
      a: 60,
      b: 35,
      c: 100,
      d: 0,
    });
    expect(parseVolumeNormByChild(null)).toEqual({});
    expect(parseVolumeNormByChild([1, 2])).toEqual({});
    expect(parseVolumeNormByChild("x")).toEqual({});
  });

  it("resolveMinVolumeNorm：单独设置优先（含 0=该孩子关闭），否则回退默认线", () => {
    const cfg = { minVolumeNorm: 42, minVolumeNormByChild: { c1: 60, c2: 0 } };
    expect(resolveMinVolumeNorm(cfg, "c1")).toBe(60);
    expect(resolveMinVolumeNorm(cfg, "c2")).toBe(0); // 显式关闭，不会回退 42
    expect(resolveMinVolumeNorm(cfg, "c3")).toBe(42); // 未单独设置 → 默认线
    expect(resolveMinVolumeNorm(cfg, "")).toBe(42); // 无孩子上下文 → 默认线（由调用方决定是否用）
  });

  it("加密落库往返：每孩子阈值原样读回，打码回显包含该表", () => {
    const dataDir = tempDir();
    const db = openDb(dataDir);
    try {
      const saved = applyAssessmentConfigPatch(db, "p191", dataDir, {
        enabled: true,
        minVolumeNorm: 42,
        minVolumeNormByChild: { c1: 60, c2: 0 },
      });
      expect(saved.minVolumeNormByChild).toEqual({ c1: 60, c2: 0 });
      const loaded = loadAssessmentConfig(db, "p191", dataDir);
      expect(loaded.minVolumeNormByChild).toEqual({ c1: 60, c2: 0 });
      const masked = getMaskedAssessmentConfig(loaded);
      expect(masked.minVolumeNormByChild).toEqual({ c1: 60, c2: 0 });
    } finally {
      db.close();
    }
  });

  it("合并式更新：改一个孩子不动其他孩子；旧客户端不传该字段时整表保留", () => {
    const dataDir = tempDir();
    const db = openDb(dataDir);
    try {
      applyAssessmentConfigPatch(db, "p191b", dataDir, {
        enabled: true,
        minVolumeNorm: 42,
        minVolumeNormByChild: { c1: 60, c2: 0 },
      });
      // 设置页第二次保存：只改了 c1
      applyAssessmentConfigPatch(db, "p191b", dataDir, {
        enabled: true,
        minVolumeNorm: 42,
        minVolumeNormByChild: { c1: 75 },
      });
      let loaded = loadAssessmentConfig(db, "p191b", dataDir);
      expect(loaded.minVolumeNormByChild).toEqual({ c1: 75, c2: 0 });

      // 设置页「用默认」= 传 null → 删除该孩子的覆盖，回到默认线
      applyAssessmentConfigPatch(db, "p191b", dataDir, {
        enabled: true,
        minVolumeNormByChild: { c2: null },
      });
      loaded = loadAssessmentConfig(db, "p191b", dataDir);
      expect(loaded.minVolumeNormByChild).toEqual({ c1: 75 });

      // 旧客户端（0.1.32 及以前）保存配置时不带 minVolumeNormByChild → 不能把整表清空
      applyAssessmentConfigPatch(db, "p191b", dataDir, { enabled: true, minVolumeNorm: 50 });
      loaded = loadAssessmentConfig(db, "p191b", dataDir);
      expect(loaded.minVolumeNorm).toBe(50);
      expect(loaded.minVolumeNormByChild).toEqual({ c1: 75 });

      // 旧配置（无该字段）→ 空表 + 默认线
      const legacy = loadAssessmentConfig(db, "p191-legacy", dataDir);
      expect(legacy.minVolumeNormByChild).toEqual({});
      expect(resolveMinVolumeNorm(legacy, "c1")).toBe(DEFAULT_MIN_VOLUME_NORM);
    } finally {
      db.close();
    }
  });
});

describe("ISSUE-191 客户端：按孩子解析阈值（与服务器同语义）", () => {
  it("单独设置优先、未设置回退默认线、显式 0 关闭", () => {
    const cfg = { minVolumeNorm: 42, minVolumeNormByChild: { c1: 60, c2: 0 } };
    expect(resolveVolumeThreshold(cfg, "c1")).toBe(60);
    expect(resolveVolumeThreshold(cfg, "c2")).toBe(0);
    expect(resolveVolumeThreshold(cfg, "c3")).toBe(42);
  });

  it("没有 childId（家长端聊天/家长试音）→ 0，不做音量检测", () => {
    const cfg = { minVolumeNorm: 42, minVolumeNormByChild: { c1: 60 } };
    expect(resolveVolumeThreshold(cfg, undefined)).toBe(0);
    expect(resolveVolumeThreshold(cfg, "")).toBe(0);
  });

  it("缺配置/旧服务端不回字段 → 回退默认 42", () => {
    expect(resolveVolumeThreshold(null, "c1")).toBe(DEFAULT_MIN_VOLUME_NORM);
    expect(resolveVolumeThreshold({}, "c1")).toBe(DEFAULT_MIN_VOLUME_NORM);
    expect(resolveVolumeThreshold({ minVolumeNormByChild: null }, "c1")).toBe(DEFAULT_MIN_VOLUME_NORM);
  });
});

describe("ISSUE-191 接线守卫", () => {
  it("考核下发按孩子解析（exam/config/:childId）", () => {
    const src = read("server/src/routes/exam.ts");
    expect(src).toContain("resolveMinVolumeNorm(assessCfg, childId)");
  });

  it("服务端评测兜底按孩子取；家长试音（无 childId）不做音量校验", () => {
    const src = read("server/src/routes/assessment.ts");
    expect(src).toContain("resolveMinVolumeNorm");
    expect(src).toContain("childId ? resolveMinVolumeNorm(assessCfg, childId) : 0");
    expect(src).toContain("minVolumeNormByChild");
  });

  it("孩子端聊天按孩子取阈值；家长端聊天跳过测量且不显示实时音量条", () => {
    const src = read("src/components/ChatWindow.tsx");
    expect(src).toContain("useVolumeThreshold(isParent ? undefined : childId)");
    // 两个录音入口（按住说话 / 附件转写）家长端都跳过解码测量
    expect(src.match(/isParent \? null : await measureBlobVolumeNorm/g)?.length).toBe(2);
    expect(src).toContain("recording && !isParent");
    expect(src).toContain("if (isParent) return;");
  });

  it("孩子端「声音检测」弹框按孩子取阈值，Learn 传 childId", () => {
    const modal = read("src/components/VolumeCheckModal.tsx");
    expect(modal).toContain("useVolumeThreshold(childId)");
    expect(modal).toContain("childId: string");
    expect(read("src/pages/Learn.tsx")).toContain("VolumeCheckModal childId={child.childId}");
  });

  it("hook 按 childId 分键缓存，无 childId 直接返回 0", () => {
    const hook = read("src/hooks/useVolumeThreshold.ts");
    expect(hook).toContain("resolveVolumeThreshold");
    expect(hook).toContain("cache.get(key)");
    expect(hook).toContain("if (!childId)");
  });

  it("设置页按孩子列滑条，并把 minVolumeNormByChild 随保存提交", () => {
    const src = read("src/components/AssessmentSettings.tsx");
    expect(src).toContain("每个孩子的录音阈值");
    expect(src).toContain("minVolumeNormByChild: childNorm");
    expect(src).toContain("childList");
  });
});

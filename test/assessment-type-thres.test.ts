/**
 * 声希打分松紧 typeThres（家长可调）：档位解析 + 打码回显。
 * 0 = 不传参、保持引擎默认；1 严格 / 2 宽松 / 3 非常严格 / 4 非常宽松。
 */
import { describe, expect, it } from "vitest";
import { getMaskedAssessmentConfig, parseTypeThres, type AssessmentConfig } from "../server/src/assessment/config";

describe("typeThres 档位解析", () => {
  it("接受 0-4 的整数（含数字字符串）", () => {
    expect(parseTypeThres(0, 9)).toBe(0);
    expect(parseTypeThres(2, 9)).toBe(2);
    expect(parseTypeThres("4", 9)).toBe(4);
    expect(parseTypeThres(1.4, 9)).toBe(1);
  });

  it("越界/非法 → 回退原值（不会把 0 误判成非法）", () => {
    expect(parseTypeThres(5, 2)).toBe(2);
    expect(parseTypeThres(-1, 2)).toBe(2);
    expect(parseTypeThres(undefined, 0)).toBe(0);
    expect(parseTypeThres(null, 3)).toBe(3);
    expect(parseTypeThres(Number.NaN, 1)).toBe(1);
  });
});

describe("打码配置回显 typeThres", () => {
  it("旧配置缺省为 0；设置后按原值回显", () => {
    const base: AssessmentConfig = {
      enabled: true,
      provider: "aliyun-ssecp",
      providers: { "tencent-soe": {}, "aliyun-ssecp": { appKey: "ak-1234567890", appSecret: "sk-1234567890" } },
      minVolumeNorm: 42,
      minVolumeNormByChild: { "child-a": 60 },
      recitePassDefault: 90,
      typeThres: 2,
    };
    const masked = getMaskedAssessmentConfig(base);
    expect(masked.typeThres).toBe(2);
    // ISSUE-191：每孩子阈值不是密钥，原样回显
    expect(masked.minVolumeNormByChild).toEqual({ "child-a": 60 });
    // 顺带确认密钥仍打码（typeThres 不应影响打码逻辑）
    expect(masked.providers["aliyun-ssecp"].appSecret).toContain("****");
  });
});

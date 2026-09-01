import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// 发音评测模块测试：
//  - 配置读写/打码/补丁（临时目录隔离，PI_TEST_DATA_DIR 指向 mkdtemp）
//  - 智聆签名（HmacSha1+base64、字典序、URL 编码）
//  - 两服务结果解析映射（统一 AssessmentResult）

let tmpRoot = "";
const OLD_TEST_DIR = process.env.PI_TEST_DATA_DIR;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-assessment-test-"));
  process.env.PI_TEST_DATA_DIR = tmpRoot;
  vi.resetModules();
});

afterAll(() => {
  if (OLD_TEST_DIR === undefined) delete process.env.PI_TEST_DATA_DIR;
  else process.env.PI_TEST_DATA_DIR = OLD_TEST_DIR;
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("assessment-config: 读写/打码/补丁", () => {
  it("默认配置：未启用，默认服务 tencent-soe，字段为空", async () => {
    const { loadAssessmentConfig } = await import("../electron/lib/assessment");
    const cfg = loadAssessmentConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.provider).toBe("tencent-soe");
    expect(cfg.providers["tencent-soe"].secretId).toBe("");
    expect(cfg.providers["aliyun-kid"].appKey).toBe("");
  });

  it("保存后能读回", async () => {
    const mod = await import("../electron/lib/assessment");
    mod.saveAssessmentConfig({
      enabled: true,
      provider: "aliyun-kid",
      providers: {
        "tencent-soe": { appId: "1306", secretId: "AKIDx", secretKey: "sk" },
        "aliyun-kid": { appKey: "a148", appSecret: "sec", userId: "u1" },
      },
    });
    const cfg = mod.loadAssessmentConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe("aliyun-kid");
    expect(cfg.providers["aliyun-kid"].appKey).toBe("a148");
  });

  it("getMasked 打码密钥（不返回明文）", async () => {
    const mod = await import("../electron/lib/assessment");
    mod.saveAssessmentConfig({
      enabled: true,
      provider: "tencent-soe",
      providers: {
        "tencent-soe": { appId: "1306", secretId: "REPLACE_WITH_YOUR_TENCENT_SOE_SECRET_ID", secretKey: "s3cretKeyValue123" },
        "aliyun-kid": { appKey: "", appSecret: "", userId: "" },
      },
    });
    const masked = mod.getMaskedAssessmentConfig();
    const sid = masked.providers["tencent-soe"].secretId;
    expect(sid).toContain("*");
    expect(sid).not.toContain("abcdefghijklmnop");
  });

  it("applyPatch：空值与含 * 字段跳过（保留原值），新值写入", async () => {
    const mod = await import("../electron/lib/assessment");
    mod.saveAssessmentConfig({
      enabled: false,
      provider: "tencent-soe",
      providers: {
        "tencent-soe": { appId: "1306", secretId: "AKIDold", secretKey: "oldsk" },
        "aliyun-kid": { appKey: "", appSecret: "", userId: "" },
      },
    });
    const cfg = mod.applyAssessmentConfigPatch({
      enabled: true,
      provider: "tencent-soe",
      providers: {
        "tencent-soe": { appId: "9999", secretId: "", secretKey: "***k", },
      },
    });
    // 空值跳过（保留 AKIDold）、含 * 跳过（保留 oldsk）、appId 新值生效
    expect(cfg.providers["tencent-soe"].appId).toBe("9999");
    expect(cfg.providers["tencent-soe"].secretId).toBe("AKIDold");
    expect(cfg.providers["tencent-soe"].secretKey).toBe("oldsk");
    expect(cfg.enabled).toBe(true);
  });

  it("isAssessmentConfigured 校验必填字段", async () => {
    const mod = await import("../electron/lib/assessment");
    mod.saveAssessmentConfig({
      enabled: true,
      provider: "tencent-soe",
      providers: {
        "tencent-soe": { appId: "1306", secretId: "AKIDx", secretKey: "sk" },
        "aliyun-kid": { appKey: "a148", appSecret: "sec", userId: "" },
      },
    });
    const cfg = mod.loadAssessmentConfig();
    expect(mod.isAssessmentConfigured(cfg, "tencent-soe")).toBe(true);
    expect(mod.isAssessmentConfigured(cfg, "aliyun-kid")).toBe(true);
  });
});

describe("tencent-soe: 握手签名与结果解析", () => {
  it("buildSoeUrl 生成字典序签名原文 + HmacSha1 base64 签名", async () => {
    const { buildSoeUrl } = await import("../electron/lib/assessment/providers/tencent-soe");
    const { url, signPlain, signature } = buildSoeUrl(
      { appId: "1306123456", secretId: "AKIDSeCrEt", secretKey: "SeCrEtKeY" },
      "hello"
    );
    // 签名原文：以 host/appid 开头，参数按 key 字典序（a<b<c...）
    expect(signPlain).toMatch(/^soe\.cloud\.tencent\.com\/soe\/api\/1306123456\?/);
    const params = signPlain.split("?")[1].split("&").map((kv) => kv.split("=")[0]);
    const sortedParams = [...params].sort();
    expect(params).toEqual(sortedParams);
    // HmacSha1 base64 为 28 字符（无 padding 可能）
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    // 自洽：用同样原文+密钥重算，必须一致
    const re = crypto.createHmac("sha1", "SeCrEtKeY").update(signPlain, "utf-8").digest("base64");
    expect(signature).toBe(re);
    // URL 含签名参数且值已编码
    expect(url).toContain("signature=");
    expect(url.startsWith("wss://soe.cloud.tencent.com/soe/api/1306123456?")).toBe(true);
    // ref_text 参数值必须存在
    expect(url).toContain("ref_text=hello");
    expect(url).toContain("score_coeff=1");
  });

  it("parseSoeResult 映射总分/准确度/词/音素", async () => {
    const { parseSoeResult } = await import("../electron/lib/assessment/providers/tencent-soe");
    const r = parseSoeResult({
      SuggestedScore: 87.5,
      PronAccuracy: 90,
      PronFluency: 80.2,
      PronCompletion: 99,
      Words: [
        {
          Word: "hello",
          ReferenceWord: "hello",
          PronAccuracy: 91.2,
          MatchTag: 0,
          PhoneInfo: [
            { Phone: "hh", ReferencePhone: "hh", PronAccuracy: 95 },
            { Phone: "eh", ReferencePhone: "eh", PronAccuracy: 88 },
          ],
        },
      ],
    });
    expect(r.provider).toBe("tencent-soe");
    expect(r.score).toBe(88);
    expect(r.accuracy).toBe(90);
    expect(r.fluency).toBe(80);
    expect(r.completeness).toBe(99);
    expect(r.words).toHaveLength(1);
    expect(r.words[0].word).toBe("hello");
    expect(r.words[0].score).toBe(91);
    expect(r.words[0].phones?.[1].phone).toBe("eh");
    expect(r.words[0].phones?.[1].score).toBe(88);
  });
});

describe("aliyun-kid: 结果解析", () => {
  it("parseKidResult 映射总分与词/音素得分", async () => {
    const { parseKidResult } = await import("../electron/lib/assessment/providers/aliyun-kid");
    const r = parseKidResult(
      {
        overall: 98,
        pron: 96,
        details: [
          {
            char: "egg",
            score: 98,
            phone: [
              { char: "e", score: 96, start: 1220, end: 1460 },
              { char: "g", score: 100, start: 1460, end: 1740 },
            ],
          },
        ],
      },
      "a148"
    );
    expect(r.provider).toBe("aliyun-kid");
    expect(r.score).toBe(98);
    expect(r.words).toHaveLength(1);
    expect(r.words[0].word).toBe("egg");
    expect(r.words[0].phones?.[0].phone).toBe("e");
    expect(r.words[0].phones?.[0].score).toBe(96);
    expect(r.words[0].phones?.[0].startMs).toBe(1220);
  });

  it("parseKidResult 空 details 兜底", async () => {
    const { parseKidResult } = await import("../electron/lib/assessment/providers/aliyun-kid");
    const r = parseKidResult({ overall: 0 }, "a148");
    expect(r.score).toBe(0);
    expect(r.words).toEqual([]);
  });
});

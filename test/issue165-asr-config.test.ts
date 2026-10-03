/**
 * ISSUE-165 回归测试：ASR 配置真源（settings `<parentId>:asr_config`，AES-256-GCM）。
 * 内存库 + settings 表（与 server/src/db.ts 同口径），验证：
 *  1. 写入落库为密文（明文 key 不出现在 value_json），读回解密还原
 *  2. 补丁语义：apiKey「空值或含 *」视为未修改（打码回显原样 PUT 不丢 key）
 *  3. GET 打码：前 6 + **** + 后 4，绝不回明文；endpoint 非凭证明文保留
 *  4. 兜底语义上收：通道 apiKey 留空 → 回退读同家长 auth 封套
 *     （qwen→auth.qwen / qwen-tokenplan→auth["qwen-tokenplan"]，按 endpoint 是否含 token-plan 选段）
 *  5. 候选顺序：默认服务在前，其余已配置通道按固定顺序在后；未配置的通道不进候选
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  readAsrConfig,
  writeAsrConfig,
  applyAsrConfigPatch,
  maskAsrConfig,
  getAuthEnvelopeKey,
  getTranscribeCandidates,
  defaultAsrConfig,
  type AsrConfig,
} from "../server/src/asr/config";
import { encryptJson } from "../server/src/crypto";

const SECRET = Buffer.alloc(32, 7); // 测试密钥（getServerSecret 也是 32 字节）
const PARENT = "p1";

function openTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL DEFAULT '{}', updated TEXT NOT NULL)`);
  return db;
}

function seedAuthEnvelope(db: DatabaseSync, auth: Record<string, unknown>): void {
  db.prepare("INSERT INTO settings (key, value_json, updated) VALUES (?,?,?)").run(
    `${PARENT}:auth`,
    encryptJson(SECRET, auth),
    new Date().toISOString()
  );
}

describe("ASR 配置真源（ISSUE-165）", () => {
  it("写入落库为密文，读回还原；无存储 → 默认配置 stored=false", () => {
    const db = openTestDb();
    expect(readAsrConfig(db, SECRET, PARENT)).toEqual({ cfg: defaultAsrConfig(), stored: false });

    const cfg: AsrConfig = defaultAsrConfig();
    cfg.enabled = true;
    cfg.providers.qwen.apiKey = "sk-plain-secret-0001";
    writeAsrConfig(db, SECRET, PARENT, cfg);

    const raw = db.prepare("SELECT value_json FROM settings WHERE key = ?").get(`${PARENT}:asr_config`) as {
      value_json: string;
    };
    expect(raw.value_json).not.toContain("sk-plain-secret-0001"); // 明文不落盘

    const { cfg: back, stored } = readAsrConfig(db, SECRET, PARENT);
    expect(stored).toBe(true);
    expect(back.enabled).toBe(true);
    expect(back.providers.qwen.apiKey).toBe("sk-plain-secret-0001");
  });

  it("补丁语义：apiKey 空值或含 * 视为未修改；endpoint 新值覆盖", () => {
    const cfg: AsrConfig = defaultAsrConfig();
    cfg.providers.qwen.apiKey = "sk-keep-me-1234567890";
    cfg.providers["qwen-tokenplan"].apiKey = "sk-real-tp-key-9999";
    applyAsrConfigPatch(cfg, {
      enabled: true,
      provider: "qwen-tokenplan",
      providers: {
        qwen: { apiKey: "" }, // 空 → 保留
        // 打码回显原样 PUT（用户没改 key）→ 跳过，保留原值
        "qwen-tokenplan": { apiKey: "sk-real-****9999" },
        mimo: { apiKey: "sk-new-real-key-0099" }, // 新值 → 覆盖
      },
    });
    expect(cfg.providers.qwen.apiKey).toBe("sk-keep-me-1234567890");
    expect(cfg.providers["qwen-tokenplan"].apiKey).toBe("sk-real-tp-key-9999");
    expect(cfg.providers.mimo.apiKey).toBe("sk-new-real-key-0099");
    expect(cfg.provider).toBe("qwen-tokenplan");
  });

  it("打码：key 前 6 + **** + 后 4，endpoint 明文保留，绝不回明文", () => {
    const cfg: AsrConfig = defaultAsrConfig();
    cfg.providers.qwen.apiKey = "sk-0123456789abcdef";
    cfg.providers["qwen-tokenplan"].endpoint = "https://token-plan.example.com/x";
    const masked = maskAsrConfig(cfg);
    expect(masked.providers.qwen.apiKey).toBe("sk-012****cdef");
    expect(masked.providers.qwen.apiKey).not.toContain("sk-0123456789abcdef");
    expect(masked.providers["qwen-tokenplan"].endpoint).toBe("https://token-plan.example.com/x");
  });

  it("兜底上收：通道 key 留空 → auth 封套按 token-plan/按量选段回退", () => {
    const db = openTestDb();
    seedAuthEnvelope(db, {
      qwen: { type: "api_key", key: "sk-payg-key" },
      "qwen-tokenplan": { type: "api_key", key: "sk-tp-key" },
    });
    expect(getAuthEnvelopeKey(db, SECRET, PARENT, "qwen", false)).toBe("sk-payg-key");
    expect(getAuthEnvelopeKey(db, SECRET, PARENT, "qwen", true)).toBe("sk-tp-key");
    expect(getAuthEnvelopeKey(db, SECRET, PARENT, "mimo", false)).toBe("");
  });

  it("候选顺序：默认服务在前；通道可用 = 自身 key 或 auth 封套兜底任一存在", () => {
    const db = openTestDb();
    seedAuthEnvelope(db, { qwen: { type: "api_key", key: "sk-payg-key" } });

    const cfg: AsrConfig = defaultAsrConfig();
    cfg.provider = "qwen";
    cfg.providers["mimo-tokenplan"].apiKey = "sk-mimo-tp"; // 非默认但自身有 key
    // qwen：key 留空但有封套兜底 → 可用；qwen-tokenplan/mimo：无 key 无兜底 → 不可用
    const candidates = getTranscribeCandidates(db, SECRET, PARENT, cfg);
    expect(candidates.map((c) => c.id)).toEqual(["qwen", "mimo-tokenplan"]);
  });
});

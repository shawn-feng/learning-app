/**
 * 静态加密（方案B 任务5）：settings 中按家长隔离的模型密钥（key="auth"）落盘前
 * 用 AES-256-GCM 加密，读取时解密。密钥 = SERVER_SECRET 环境变量（sha256 派生）或
 * 首启生成的 <dataDir>/.secret（随机 32 字节 hex）。
 * 注：传输层仍为明文（LAN HTTP），完整保护需 HTTPS/RSA；此处先消除「明文落盘」。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;

export function getServerSecret(dataDir: string): Buffer {
  const env = process.env.SERVER_SECRET;
  if (env && env.length >= 16) {
    return crypto.createHash("sha256").update(env).digest();
  }
  const p = path.join(dataDir, ".secret");
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, "utf-8").trim();
      if (raw) return Buffer.from(raw, "hex");
    } catch {
      /* 读失败则重新生成 */
    }
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(p, key.toString("hex"), "utf-8");
  return key;
}

/** 加密任意 JSON 值，返回封套字符串（{v,iv,tag,data} base64）。 */
export function encryptJson(secret: Buffer, value: unknown): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, secret, iv);
  const plain = Buffer.from(JSON.stringify(value ?? null), "utf-8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: enc.toString("base64"),
  });
}

/** 解密封套；失败（非加密格式/密钥不符）返回 null，调用方回退原样。 */
export function decryptJson(secret: Buffer, enc: string): unknown | null {
  try {
    const obj = JSON.parse(enc) as { v?: number; iv?: string; tag?: string; data?: string };
    if (!obj?.iv || !obj.tag || !obj.data) return null;
    const decipher = crypto.createDecipheriv(ALGO, secret, Buffer.from(obj.iv, "base64"));
    decipher.setAuthTag(Buffer.from(obj.tag, "base64"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(obj.data, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plain.toString("utf-8"));
  } catch {
    return null;
  }
}

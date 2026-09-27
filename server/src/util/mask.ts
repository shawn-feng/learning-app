/**
 * 密钥打码（ISSUE-163）：对外回显统一「前 6 + **** + 后 4」，
 * 只露首尾共 10 字符、中间必含 ****，绝不回明文。
 * 前 6 位满足「知道用的哪把 key」；补后 4 位是因为 sk-/tp- 类统一前缀无区分度。
 */

export function maskSecret(v: string): string {
  if (!v) return "";
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 6)}****${v.slice(-4)}`;
}

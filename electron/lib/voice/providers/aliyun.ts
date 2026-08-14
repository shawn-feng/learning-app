import { RPCClient } from "@alicloud/pop-core";

// NLS Token 缓存（有效期约 60s，提前 10s 刷新）
let cachedToken: string | null = null;
let cachedAt = 0;

async function getToken(accessKeyId: string, accessKeySecret: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && now - cachedAt < 50000) {
    return cachedToken;
  }
  const client = new RPCClient({
    accessKeyId,
    accessKeySecret,
    endpoint: "http://nls-meta.cn-shanghai.aliyuncs.com",
    apiVersion: "2019-02-28",
  });
  const result: any = await client.request("CreateToken", {});
  const id = result?.Token?.Id;
  if (!id) throw new Error("获取阿里云 NLS Token 失败");
  cachedToken = id;
  cachedAt = now;
  return id;
}

// 阿里云 NLS 一句话识别（RESTful）：POST wav → /stream/v1/asr
export async function transcribe(wav: Buffer, creds: Record<string, string>): Promise<string> {
  if (!creds.appKey || !creds.accessKeyId || !creds.accessKeySecret) {
    throw new Error("阿里云语音配置不完整（appKey / accessKeyId / accessKeySecret）");
  }
  const token = await getToken(creds.accessKeyId, creds.accessKeySecret);
  const url =
    `http://nls-gateway-cn-shanghai.aliyuncs.com/stream/v1/asr` +
    `?appkey=${encodeURIComponent(creds.appKey)}` +
    `&enable_punctuation_prediction=true` +
    `&enable_inverse_text_normalization=true`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-NLS-Token": token,
      "Content-Type": "application/octet-stream",
    },
    body: wav as any,
  });

  const json: any = await res.json();
  if (json.status === 20000000 && json.result) {
    return json.result;
  }
  throw new Error(`阿里云识别失败: ${json.message || `status=${json.status}`}`);
}

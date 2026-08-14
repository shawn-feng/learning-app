// 腾讯云一句话识别（SentenceRecognition）
export async function transcribe(wav: Buffer, creds: Record<string, string>): Promise<string> {
  if (!creds.secretId || !creds.secretKey) {
    throw new Error("腾讯云语音配置不完整（secretId / secretKey）");
  }

  // 动态导入，避免打包时强依赖 CJS SDK
  const tencentcloud: any = await import("tencentcloud-sdk-nodejs-asr");
  const AsrClient = tencentcloud.asr.v20190614.Client;

  const client = new AsrClient({
    credential: {
      secretId: creds.secretId,
      secretKey: creds.secretKey,
    },
    region: "ap-guangzhou",
    profile: {
      httpProfile: { endpoint: "asr.tencentcloudapi.com" },
    },
  });

  const params = {
    ProjectId: 0,
    SubServiceType: 2, // 一句话识别
    EngSerViceType: "16k_zh", // 16k 中文普通话
    SourceType: 1, // 音频数据（base64）
    VoiceFormat: "wav",
    Data: wav.toString("base64"),
    DataLen: wav.length,
  };

  const res: any = await client.SentenceRecognition(params);
  if (res.Result) return res.Result;
  throw new Error(`腾讯云识别失败: ${res.Error?.Message || "未返回结果"}`);
}

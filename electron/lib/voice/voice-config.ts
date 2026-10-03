/**
 * ASR 配置真源已上收服务端（ISSUE-165，2026-09-28）：settings 表 `<parentId>:asr_config`
 * （AES-256-GCM 加密，GET /asr/config 打码回显、PUT 保存、POST /asr/transcribe 转录）。
 *
 * 本模块只保留旧「本机 voice-config.json」的一次性迁移：服务端无落库配置（stored=false）
 * 时把本机文件导入服务端，成功后本机文件改名退役——旧残留不再生效，多设备配置以服务端
 * 为唯一真源。此前在此的 loadVoiceConfig/saveVoiceConfig/getMaskedConfig 等本机读写
 * 已随迁移删除（转录 provider 同步迁移至 server/src/asr/providers.ts）。
 */
import fs from "fs";
import { serverFetch } from "../server-client";
import { getSharedDir } from "../config";
import path from "path";

export function getVoiceConfigPath(): string {
  return path.join(getSharedDir(), "voice-config.json");
}

/** 读取旧本机配置（文件不存在/解析失败/缺 providers → null，视为无可导入内容）。 */
function readLegacyVoiceConfig(): { enabled: boolean; provider: string; providers: Record<string, Record<string, string>> } | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(getVoiceConfigPath(), "utf-8"));
    if (!parsed || typeof parsed !== "object" || !parsed.providers) return null;
    return {
      enabled: !!parsed.enabled,
      provider: String(parsed.provider || "qwen"),
      providers: parsed.providers,
    };
  } catch {
    return null;
  }
}

/** 本机文件改名退役（voice-config.json → voice-config.json.retired-<时间戳>），失败静默。 */
function retireLegacyVoiceConfigFile(): void {
  try {
    const p = getVoiceConfigPath();
    if (fs.existsSync(p)) fs.renameSync(p, `${p}.retired-${Date.now()}`);
  } catch {
    /* 退役失败不阻断：本机文件已不再被读取，仅影响目录整洁 */
  }
}

/**
 * 一次性导入：本机 voice-config.json → 服务端（PUT /asr/config 全量补丁）。
 * 仅应在服务端 GET /asr/config 返回 stored=false 时调用。导入成功返回服务端打码配置，
 * 无可导入内容返回 null；服务端失败抛错（导入保持待重试，本机文件不退役）。
 */
export async function importLegacyVoiceConfigToServer(token: string): Promise<unknown | null> {
  const legacy = readLegacyVoiceConfig();
  if (!legacy) return null;
  const data = await serverFetch<{ config: unknown }>("/asr/config", {
    method: "PUT",
    body: legacy,
    token,
    timeoutMs: 15000,
  });
  retireLegacyVoiceConfigFile();
  return data.config;
}

/**
 * ISSUE-189 回归：所有录音环节的 ASR 前置音量门（客户端统一口径）。
 *
 * 覆盖三层：
 * 1) 纯函数口径——RMS→归一分公式锚点（与服务端 / 考核 iframe 同一公式）、门判定、结论文案、
 *    解码后 AudioBuffer 平均音量（真 ArrayBuffer 形状的假 AudioBuffer，node 环境可跑）。
 *    阈值**不是写死 42**：家长端「录音最低平均音量」（assessment_config.minVolumeNorm）可配，
 *    42 只是读不到配置时的兜底默认（本文件用 50/40 验证门随配置变化）。
 * 2) 接线守卫——ChatWindow 的每一次 voiceTranscribe 调用前必须先过 isVolumeTooLow（防后人把门删了），
 *    且阈值走 useVolumeThreshold（家长配置）而不是常量；考核 iframe 不再只对口语题校音量
 *    （ISSUE-183 的 `q.questionType && volMin > 0` 已改全题）。
 * 3) 孩子端入口——Learn.tsx 左侧图标栏有「声音检测」入口且挂 VolumeCheckModal；
 *    家长端设置页仍保留阈值滑条且文案说明对语音输入/音频转写同样生效。
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_MIN_VOLUME_NORM,
  MIN_ASR_VOLUME_NORM,
  averageVolumeNormOfBuffer,
  isVolumeGateEnabled,
  isVolumeTooLow,
  measureBlobVolumeNorm,
  parseVolumeThreshold,
  rmsToVolumeNorm,
  volumeBarColor,
  volumeVerdict,
} from "../src/lib/audio-volume";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/** 假 AudioBuffer：恒定振幅（RMS = amplitude），只为验算「多声道按样本平均」与公式接线。 */
function fakeBuffer(amplitude: number, opts: { seconds?: number; sampleRate?: number; channels?: number } = {}) {
  const seconds = opts.seconds ?? 1;
  const sampleRate = opts.sampleRate ?? 16000;
  const channels = opts.channels ?? 1;
  const length = Math.round(seconds * sampleRate);
  return {
    numberOfChannels: channels,
    length,
    sampleRate,
    duration: seconds,
    getChannelData: () => {
      const data = new Float32Array(length);
      data.fill(amplitude);
      return data;
    },
  } as unknown as AudioBuffer;
}

const expectedNorm = (db: number) => Math.min(100, Math.max(0, Math.round(((db + 60) * 100) / 60)));

describe("ISSUE-189 音量口径（与服务端 assessment/volume.ts 同公式）", () => {
  it("锚点：静音→0、0dBFS→100、-35dBFS→42（考核默认阈值）", () => {
    expect(rmsToVolumeNorm(0)).toBe(0);
    expect(rmsToVolumeNorm(-1)).toBe(0);
    expect(rmsToVolumeNorm(1)).toBe(100);
    expect(rmsToVolumeNorm(Math.pow(10, -35 / 20))).toBe(42);
    expect(rmsToVolumeNorm(10)).toBe(100); // 超过满刻度也不超出 100
  });

  it("默认值：ASR 前置线 = 考核默认线 = 42", () => {
    expect(DEFAULT_MIN_VOLUME_NORM).toBe(42);
    expect(MIN_ASR_VOLUME_NORM).toBe(DEFAULT_MIN_VOLUME_NORM);
  });

  it("AudioBuffer 全程 RMS：恒定振幅 0.2 → 77 分；双声道与单声道同值", () => {
    expect(averageVolumeNormOfBuffer(fakeBuffer(0.2))).toBe(expectedNorm(20 * Math.log10(0.2)));
    expect(averageVolumeNormOfBuffer(fakeBuffer(0.2, { channels: 2 }))).toBe(expectedNorm(20 * Math.log10(0.2)));
    expect(averageVolumeNormOfBuffer(fakeBuffer(0))).toBe(0);
  });

  it("阈值解析：非法回退、越界夹取（0=关闭）", () => {
    expect(parseVolumeThreshold("50", 42)).toBe(50);
    expect(parseVolumeThreshold(120, 42)).toBe(100);
    expect(parseVolumeThreshold(-3, 42)).toBe(0);
    expect(parseVolumeThreshold("abc", 42)).toBe(42);
    expect(parseVolumeThreshold(undefined, 42)).toBe(42);
  });
});

describe("ISSUE-189 ASR 前置音量门", () => {
  it("isVolumeGateEnabled：0/负数/非法 = 关闭", () => {
    expect(isVolumeGateEnabled(0)).toBe(false);
    expect(isVolumeGateEnabled(-5)).toBe(false);
    expect(isVolumeGateEnabled(Number.NaN)).toBe(false);
    expect(isVolumeGateEnabled(42)).toBe(true);
  });

  it("isVolumeTooLow：低于线拦、达标放行、测不出放行、关闭放行", () => {
    expect(isVolumeTooLow(18, 42)).toBe(true);
    expect(isVolumeTooLow(41, 42)).toBe(true);
    expect(isVolumeTooLow(42, 42)).toBe(false);
    expect(isVolumeTooLow(90, 42)).toBe(false);
    // 家长把线调高/调低后，门随之变化（不是写死 42）
    expect(isVolumeTooLow(45, 50)).toBe(true);
    expect(isVolumeTooLow(45, 40)).toBe(false);
    expect(isVolumeTooLow(null, 42)).toBe(false); // 解码失败不卡孩子
    expect(isVolumeTooLow(18, 0)).toBe(false); // 家长关闭校验
  });

  it("结论文案：太小 / 还差一点点 / 刚刚好（与考核页同口径，带本次与达标线）", () => {
    const low = volumeVerdict(18, 42);
    expect(low.level).toBe("low");
    expect(low.text).toContain("太小了听不清");
    expect(low.text).toContain("18");
    expect(low.text).toContain("42");

    const close = volumeVerdict(38, 42);
    expect(close.level).toBe("close");
    expect(close.text).toContain("还差一点点");

    const ok = volumeVerdict(62, 42);
    expect(ok.level).toBe("ok");
    expect(ok.text).toContain("刚刚好");

    // 阈值为 0（关闭）时任何音量都算达标
    expect(volumeVerdict(5, 0).level).toBe("ok");
  });

  it("音量条着色：达标绿 / 偏轻黄（差≤12）/ 太小红", () => {
    expect(volumeBarColor(62, 42)).toBe("#58a700");
    expect(volumeBarColor(42, 42)).toBe("#58a700");
    expect(volumeBarColor(38, 42)).toBe("#e6a23c");
    expect(volumeBarColor(30, 42)).toBe("#e6a23c");
    expect(volumeBarColor(18, 42)).toBe("#ff4b4b");
  });

  it("measureBlobVolumeNorm 在无 AudioContext 的环境（node）返回 null 而不抛错", async () => {
    await expect(measureBlobVolumeNorm(new Blob([new Uint8Array([1, 2, 3])]))).resolves.toBeNull();
  });
});

describe("ISSUE-189 接线守卫（防后人把音量门删掉）", () => {
  it("ChatWindow 每一次 voiceTranscribe 调用前都有 isVolumeTooLow 音量门", () => {
    const src = read("src/components/ChatWindow.tsx");
    const calls = [...src.matchAll(/voiceTranscribe\(/g)].map((m) => m.index ?? -1);
    expect(calls.length).toBeGreaterThanOrEqual(2); // 语音输入 + 附件手动转写
    for (const idx of calls) {
      const before = src.slice(Math.max(0, idx - 900), idx);
      expect(before).toContain("isVolumeTooLow");
      expect(before).toContain("measureBlobVolumeNorm");
    }
  });

  it("ChatWindow 录音中显示实时音量条，且阈值来自家长配置（不再写死 42）", () => {
    const src = read("src/components/ChatWindow.tsx");
    expect(src).toContain("createVolumeMeter");
    expect(src).toContain("voice-live-meter");
    // 阈值唯一来源：useVolumeThreshold（家长 assessment_config.minVolumeNorm）
    expect(src).toContain("useVolumeThreshold");
    expect(src).not.toContain("MIN_ASR_VOLUME_NORM");
  });

  it("音量检测弹框同样读家长配置；家长设 0（关闭）时不做达标判定", () => {
    const modal = read("src/components/VolumeCheckModal.tsx");
    expect(modal).toContain("useVolumeThreshold");
    expect(modal).toContain("minNorm === 0");
    expect(modal).toContain("家长没有设置达标线");
  });

  it("家长端阈值设置仍在，且文案已说明对语音输入/转写同样生效", () => {
    const settings = read("src/components/AssessmentSettings.tsx");
    expect(settings).toContain("minVolumeNorm");
    expect(settings).toContain("录音最低平均音量");
    expect(settings).toContain("语音输入");
    expect(settings).toContain("音频转写");
  });

  it("阈值读取走 assessmentConfigGet，失败回退默认 42", () => {
    const hook = read("src/hooks/useVolumeThreshold.ts");
    expect(hook).toContain("assessmentConfigGet");
    expect(hook).toContain("DEFAULT_MIN_VOLUME_NORM");
    expect(hook).toContain("parseVolumeThreshold");
  });

  it("考核 iframe：音量门改为全题型（不再只对口语题校），文字题 ASR 前同样拦", () => {
    const tpl = read("src/lib/exam-template.ts");
    expect(tpl).not.toContain("q.questionType && volMin > 0");
    expect(tpl).toContain("if(volMin > 0){");
    // 文字题仍走 exam:asr（门只在测量不达标时 return，不改变达标后的识别链路）
    expect(tpl).toContain('type:"exam:asr"');
  });

  it("孩子端左侧图标栏有「声音检测」入口，并挂 VolumeCheckModal", () => {
    const learn = read("src/pages/Learn.tsx");
    expect(learn).toContain("VolumeCheckModal");
    expect(learn).toContain("sidebar-icon-btn-voice");
    expect(learn).toContain("showVolumeCheck");
  });
});

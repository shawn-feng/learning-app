/**
 * 发音评测逐字展示（SpeechText）回归：
 * 1) 服务端解析：SSECP 的两种 details 形状（嵌套 snt_details / 平铺）都要能摊平成带
 *    score/dp_type/tone/tonescore/is_pause/start/end 的字词序列（颜色标注与点读都靠它）；
 * 2) 前端纯逻辑：原文与 words 的对齐、着色分档、标点不消耗 words。
 */
import { describe, expect, it } from "vitest";
import { parseSsecpResult } from "../server/src/assessment/providers/aliyun-ssecp";
import {
  buildSpeechTokens,
  classifySpeechWord,
  describeSpeechWord,
  stripToWordChars,
  summarizeSpeechWords,
} from "../src/lib/speech-text";

describe("SSECP 解析：中文篇章（details → 句子 → snt_details）", () => {
  const parsed = {
    result: {
      overall: 68,
      pron: 70,
      accuracy: 70,
      integrity: 90,
      fluency: 80,
      info: { tipId: 10004, snr: 12.5, clip: 0, volume: 40 },
      details: [
        {
          text: "山不在高，",
          score: 64,
          fluency: { pause: 0, overall: 97, speed: 1 },
          snt_details: [
            { chn_char: "山", char: "shan", tone: 1, tonescore: 99, score: 91, start: 900, end: 1260, dur: 360 },
            { chn_char: "高，", char: "gao", tone: 1, tonescore: 34, score: 34, start: 1680, end: 2020, dur: 340, is_pause: 1 },
          ],
        },
        {
          text: "有仙则名。",
          score: 80,
          fluency: { pause: 1, overall: 95, speed: 1 },
          snt_details: [
            { chn_char: "惟", char: "wei", tone: 2, tonescore: 0, score: 0, dp_type: 1, start: 0, end: 0, dur: 0 },
          ],
        },
      ],
    },
  };

  it("逐字字段齐全：拼音声调/声调分/停顿/时间戳/句序", () => {
    const r = parseSsecpResult(parsed, "cn.pred.score");
    expect(r.words).toHaveLength(3);
    const gao = r.words[1]!;
    expect(gao.word).toBe("高，"); // 中文可能带标点，展示层再剥离
    expect(gao.score).toBe(34);
    expect(gao.tone).toBe(1);
    expect(gao.toneScore).toBe(34);
    expect(gao.isPause).toBe(true);
    expect(gao.startMs).toBe(1680);
    expect(gao.endMs).toBe(2020);
    expect(gao.sentenceIndex).toBe(0);

    const wei = r.words[2]!;
    expect(wei.dpType).toBe(1); // 漏读
    expect(wei.sentenceIndex).toBe(1);
  });

  it("句子级摘要与音频质量也带回来", () => {
    const r = parseSsecpResult(parsed, "cn.pred.score");
    expect(r.sentences).toHaveLength(2);
    expect(r.sentences![0]).toMatchObject({ text: "山不在高，", score: 64, pause: 0 });
    expect(r.audioQuality).toMatchObject({ tipId: 10004, snr: 12.5 });
  });

  it("最终分仍是维度平均（准确/流利/完整）", () => {
    expect(parseSsecpResult(parsed, "cn.pred.score").score).toBe(80);
  });
});

describe("SSECP 解析：平铺 details（中文背诵 / 英文句子）", () => {
  it("中文背诵：details[] 直接是单字", () => {
    const r = parseSsecpResult(
      {
        result: {
          pron: 69,
          integrity: 75,
          fluency: 65,
          details: [
            { chn_char: "床", char: "chuang", tone: 2, tonescore: 82, score: 82, start: 210, end: 1170, dur: 960 },
            { chn_char: "疑", char: "ni", tone: 3, tonescore: 0, score: 0, dp_type: 1, start: 0, end: 0, dur: 0 },
          ],
        },
      },
      "cn.recite.score"
    );
    expect(r.words.map((w) => w.word)).toEqual(["床", "疑"]);
    expect(r.words[1]!.dpType).toBe(1);
    expect(r.words[0]!.toneScore).toBe(82);
    expect(r.sentences).toBeUndefined();
  });

  it("英文句子：音素明细映射，升降调 tonescore 不冒充声调分", () => {
    const r = parseSsecpResult(
      {
        result: {
          accuracy: 73,
          fluency: { overall: 94, pause: 0, speed: 1 },
          integrity: 90,
          details: [
            {
              char: "play",
              score: 42,
              dp_type: 2,
              is_pause: 1,
              tonescore: 1,
              start: 1580,
              end: 1820,
              dur: 240,
              phone: [{ char: "p", score: 0, start: 1580, end: 1640, pherr: 1 }],
            },
          ],
        },
      },
      "en.sent.score"
    );
    const w = r.words[0]!;
    expect(w.word).toBe("play");
    expect(w.dpType).toBe(2);
    expect(w.isPause).toBe(true);
    expect(w.tone).toBeUndefined();
    expect(w.toneScore).toBeUndefined();
    expect(w.phones).toEqual([{ phone: "p", score: 0, startMs: 1580, endMs: 1640 }]);
  });

  it("英文段落：同样按 snt_details 摊平", () => {
    const r = parseSsecpResult(
      {
        result: {
          pron: 77,
          accuracy: 77,
          integrity: 81,
          details: [
            { text: "Learning another language", score: 57, fluency: { pause: 2, overall: 71, speed: 2 }, snt_details: [{ char: "Learning", score: 42 }] },
          ],
        },
      },
      "en.pred.score"
    );
    expect(r.words).toHaveLength(1);
    expect(r.words[0]).toMatchObject({ word: "Learning", score: 42, sentenceIndex: 0 });
    expect(r.sentences![0]).toMatchObject({ score: 57, pause: 2, speed: 2 });
  });
});

describe("逐字着色：对齐与分档", () => {
  it("标点/空白不消耗 words，汉字逐字对齐", () => {
    const tokens = buildSpeechTokens("山不在高，", [
      { word: "山", score: 91 },
      { word: "不", score: 55 },
      { word: "在", score: 75 },
      { word: "高，", score: 34, toneScore: 34 },
    ]);
    expect(tokens.map((t) => t.text)).toEqual(["山", "不", "在", "高", "，"]);
    expect(tokens[0]!.tone).toBe("ok");
    expect(tokens[1]!.tone).toBe("bad");
    expect(tokens[2]!.tone).toBe("mid");
    expect(tokens[3]!.tone).toBe("bad"); // score 34 优先于声调分
    expect(tokens[4]!.word).toBeUndefined();
    expect(tokens[4]!.tone).toBe("plain");
  });

  it("漏读/重读按 dp_type 优先，声调差单独标黄", () => {
    const tokens = buildSpeechTokens("读得好", [
      { word: "读", score: 0, dpType: 1 },
      { word: "得", score: 85, dpType: 2 },
      { word: "好", score: 90, toneScore: 40 },
    ]);
    expect(tokens.map((t) => t.tone)).toEqual(["missing", "repeat", "tone"]);
  });

  it("智聆 dp_type=3 算错读（声希 3 是注释字不评分）", () => {
    expect(classifySpeechWord({ word: "x", score: 90, dpType: 3 }, "tencent-soe")).toBe("bad");
    expect(classifySpeechWord({ word: "x", score: 90, dpType: 3 }, "aliyun-ssecp")).toBe("note");
    expect(describeSpeechWord({ word: "x", score: 90, dpType: 3 }, "tencent-soe")).toBe("读错 · 90 分");
    expect(buildSpeechTokens("x", [{ word: "x", score: 90, dpType: 3 }], "tencent-soe")[0]!.tone).toBe("bad");
  });

  it("英文按词对齐，空格不消耗 words", () => {
    const tokens = buildSpeechTokens("let us play", [
      { word: "let", score: 90, startMs: 620, endMs: 1140 },
      { word: "us", score: 90 },
      { word: "play", score: 42 },
    ]);
    expect(tokens.filter((t) => t.word).map((t) => t.word!.word)).toEqual(["let", "us", "play"]);
    expect(tokens[0]!.playable).toBe(true);
    expect(tokens[2]!.playable).toBe(false);
    expect(tokens[1]!.text).toBe(" ");
  });

  it("没有 words 时全部按普通文本（旧数据/其它 provider 兜底）", () => {
    const tokens = buildSpeechTokens("你好", undefined);
    expect(tokens.every((t) => t.tone === "plain")).toBe(true);
  });

  it("hover 文案与统计", () => {
    expect(describeSpeechWord({ word: "高", score: 34, toneScore: 34 })).toBe("读错 · 34 分 · 声调 34");
    expect(describeSpeechWord({ word: "惟", score: 0, dpType: 1 })).toBe("漏读 · 0 分");
    const summary = summarizeSpeechWords([
      { word: "山", score: 91 },
      { word: "不", score: 55 },
      { word: "惟", score: 0, dpType: 1 },
    ]);
    expect(summary).toMatchObject({ ok: 1, bad: 1, missing: 1 });
  });

  it("stripToWordChars 去掉标点空白", () => {
    expect(stripToWordChars("高，")).toBe("高");
    expect(stripToWordChars("  ")).toBe("");
    expect(classifySpeechWord(undefined)).toBe("plain");
  });
});

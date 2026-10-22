import { useEffect, useState } from "react";
import IconButton from "./IconButton";
import SpeechText from "./SpeechText";
import { Save } from "lucide-react";
import { useAudioRecorder } from "../hooks/useAudioRecorder";
import type { SpeechAssessment } from "../../electron/lib/exam";

interface AssessmentProviderDef {
  id: string;
  name: string;
  desc: string;
  fields: { key: string; label: string; placeholder?: string }[];
}

// 发音评测供应商：腾讯云智聆（WebSocket）/ 阿里 SSECP 声希（HTTP POST API，客户端直连）。
// 智聆：AppID + SecretId + SecretKey（腾讯云 API 密钥 + AppID，控制台「智聆口语评测」开通）。
// 阿里声希：appKey + appSecret（阿里云「智能科教内容生成平台 SSECP」控制台获取，即声希凭证）；
//         评测在 app 客户端完成，无需阿里云 AccessKey；中文背诵与英文均支持。
const ASSESSMENT_PROVIDERS: AssessmentProviderDef[] = [
  {
    id: "tencent-soe",
    name: "腾讯云智聆",
    desc: "口语评测（新版）WebSocket 流式，音素级反馈，儿童苛刻度自动最低档；中文背诵与英文均支持",
    fields: [
      { key: "appId", label: "AppID", placeholder: "腾讯云 AppID（数字）" },
      { key: "secretId", label: "SecretId", placeholder: "腾讯云 API 密钥 SecretId" },
      { key: "secretKey", label: "SecretKey", placeholder: "腾讯云 API 密钥 SecretKey" },
    ],
  },
  {
    id: "aliyun-ssecp",
    name: "阿里云·声希",
    desc: "SSECP 口语评测（声希 HTTP POST API），评测在客户端完成，无需阿里云 AccessKey；中文背诵与英文均支持",
    fields: [
      { key: "appKey", label: "appKey", placeholder: "声希 appKey（SSECP 控制台）" },
      { key: "appSecret", label: "appSecret", placeholder: "声希 appSecret（SSECP 控制台）" },
      { key: "userId", label: "User ID（可选）", placeholder: "留空默认 pi-child" },
    ],
  },
];

/** 阿里声希 typeThres 档位（0=不传，保持引擎默认松紧；1/3 更严，2/4 更松） */
const TYPE_THRES_CHOICES = [
  { value: 0, label: "默认" },
  { value: 1, label: "严格" },
  { value: 2, label: "宽松" },
  { value: 3, label: "非常严格" },
  { value: 4, label: "非常宽松" },
];
const TYPE_THRES_LABEL: Record<number, string> = {
  0: "默认（不启用）",
  1: "严格",
  2: "宽松",
  3: "非常严格",
  4: "非常宽松",
};

export default function AssessmentSettings() {
  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState("tencent-soe"); // 当前正在编辑的服务
  const [defaultProvider, setDefaultProvider] = useState("tencent-soe"); // 默认评测服务
  const [fields, setFields] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const [testing, setTesting] = useState(false);
  // 试评结果（"hello"）：用于直观看逐词着色是否正常（不落库）
  const [testSpeech, setTestSpeech] = useState<SpeechAssessment | null>(null);
  // ISSUE-183：考核朗读/背诵规则——录音最低平均音量（0-100 归一分，0=不校验）+ 通过线家长默认值
  // ISSUE-191：minVolumeNorm 降为「默认线」；每个孩子可单独设置（childNorm），未设置的孩子用默认线
  const [minVolumeNorm, setMinVolumeNorm] = useState(42);
  // 只存「单独设置的孩子」；null = 明确回到默认线（保存时让服务端删除该孩子覆盖）
  const [childNorm, setChildNorm] = useState<Record<string, number | null>>({});
  const [children, setChildren] = useState<Array<{ childId: string; name: string; avatar?: string; age?: number }>>([]);
  const [recitePassDefault, setRecitePassDefault] = useState(90);
  // 声希打分松紧：0 默认（不传）/ 1 严格 / 2 宽松 / 3 非常严格 / 4 非常宽松（腾讯智聆无此参数）
  const [typeThres, setTypeThres] = useState(0);
  const { recording, start, stop } = useAudioRecorder();

  useEffect(() => {
    let alive = true;
    (async () => {
      const [r, cr] = await Promise.all([
        window.api.assessmentConfigGet().catch(() => null),
        Promise.resolve((window.api as any).childList?.()).catch(() => null),
      ]);
      if (!alive) return;
      // 孩子列表（ISSUE-191：按孩子展示阈值滑条）
      const list = Array.isArray(cr?.children) ? cr.children : [];
      setChildren(list);
      if (r?.success) {
        setEnabled(r.config.enabled);
        setProvider(r.config.provider);
        setDefaultProvider(r.config.provider);
        setFields(r.config.providers[r.config.provider] || {});
        // 服务端 loadAssessmentConfig 已带默认值兜底；再兜一层防旧服务端不回字段
        const mv = Number(r.config.minVolumeNorm);
        const rp = Number(r.config.recitePassDefault);
        const globalNorm = Number.isFinite(mv) && mv >= 0 ? Math.min(100, Math.round(mv)) : 42;
        if (Number.isFinite(mv) && mv >= 0) setMinVolumeNorm(globalNorm);
        if (Number.isFinite(rp) && rp > 0) setRecitePassDefault(Math.min(100, Math.round(rp)));
        const tt = Number(r.config.typeThres);
        if (Number.isInteger(tt) && tt >= 0 && tt <= 4) setTypeThres(tt);
        // 每个孩子：只收「单独设置」的条目；没有条目的孩子显示默认线并保持继承（不写成显式值）
        const map = (r.config.minVolumeNormByChild || {}) as Record<string, unknown>;
        const seeded: Record<string, number> = {};
        for (const [childId, raw] of Object.entries(map)) {
          const per = Number(raw);
          if (Number.isFinite(per) && per >= 0) seeded[childId] = Math.min(100, Math.round(per));
        }
        setChildNorm(seeded);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const currentProvider = ASSESSMENT_PROVIDERS.find((p) => p.id === provider)!;

  async function switchProvider(id: string) {
    setProvider(id);
    setStatus("");
    const r = await window.api.assessmentConfigGet();
    if (r?.success) setFields(r.config.providers[id] || {});
  }

  function setField(key: string, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setStatus("");
    const providers: Record<string, Record<string, string>> = {};
    providers[provider] = fields;
    const r = await window.api.assessmentConfigSet({
      enabled,
      provider: defaultProvider,
      providers,
      minVolumeNorm,
      minVolumeNormByChild: childNorm,
      recitePassDefault,
      typeThres,
    });
    if (r?.success) {
      setStatus("已保存");
      setFields(r.config.providers[provider] || {});
    } else {
      setStatus(`保存失败: ${r?.error || ""}`);
    }
  }

  async function setDefault() {
    setStatus("");
    const r = await window.api.assessmentConfigSet({
      enabled,
      provider,
      providers: {},
      minVolumeNorm,
      minVolumeNormByChild: childNorm,
      recitePassDefault,
      typeThres,
    });
    if (r?.success) {
      setDefaultProvider(r.config.provider);
      setStatus(`已将「${currentProvider.name}」设为默认评测服务`);
    } else {
      setStatus(`保存失败: ${r?.error || ""}`);
    }
  }

  // 测试：录音 → 评测固定单词 "hello"，验证凭证与链路
  async function handleTest() {
    setStatus("");
    if (recording) {
      const blob = await stop();
      if (!blob) return;
      if (blob.size < 2000) {
        setStatus("录音太短，请按住说完整的一句话再松手");
        return;
      }
      setTesting(true);
      try {
        const buf = await blob.arrayBuffer();
        const r = await window.api.assessmentTest(buf, provider, "hello");
        if (r.success) {
          const res = r.result as SpeechAssessment;
          // SpeechAssessment 契约：总分权威字段是 pron（非 score），流利度是 {overall} 对象（非数字），
          // 完整度字段名是 integrity（非 completeness）。下方读取严格对齐，避免 undefined / [object Object]。
          const score = res.pron ?? res.overall; // 总分：优先 pron
          const fluency = res.fluency?.overall; // 流利度：取对象中的数字
          const integrity = res.integrity; // 完整度
          const wordCount = res.words?.length ?? 0;
          setTestSpeech(res);
          setStatus(
            `评测成功：总分 ${score ?? "未返回"} 分` +
              (res.accuracy !== undefined ? `，准确度 ${res.accuracy}` : "") +
              (fluency !== undefined ? `，流利度 ${fluency}` : "") +
              (integrity !== undefined ? `，完整度 ${integrity}` : "") +
              `（${wordCount} 个词）`
          );
        } else {
          setStatus(`评测失败: ${r.error}`);
        }
      } catch (e: any) {
        setStatus(`评测失败: ${e.message}`);
      } finally {
        setTesting(false);
      }
    } else {
      try {
        await start();
        setStatus("录音中… 说「hello」，再点一次「测试评测」结束");
      } catch (e: any) {
        setStatus(`无法访问麦克风: ${e.message}`);
      }
    }
  }

  return (
    <div className="settings-section">
      <h3>发音评测</h3>
      <p className="desc">
        英语口语发音评测服务（英语角模式下，孩子每条语音自动评测发音并指出问题）。
        可配置多个服务，其中一个是默认服务——评测时优先用默认服务，未配置或失败时自动切换到其他已配置服务。
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: 14, fontWeight: 500 }}>启用发音评测</label>
        <button
          onClick={() => setEnabled((v) => !v)}
          style={{
            padding: "6px 16px",
            borderRadius: 16,
            border: "none",
            cursor: "pointer",
            background: enabled ? "#58cc02" : "#e5e5e5",
            color: enabled ? "white" : "#777777",
          }}
        >
          {enabled ? "已开启" : "已关闭"}
        </button>
      </div>

      <div style={{ marginBottom: 8, fontSize: 13, color: "#777777" }}>
        选择服务编辑凭证；点「设为默认」把它设为评测时的首选服务：
      </div>
      <div className="provider-list">
        {ASSESSMENT_PROVIDERS.map((p) => (
          <div
            key={p.id}
            className={`provider-chip ${provider === p.id ? "active" : ""}`}
            onClick={() => switchProvider(p.id)}
            style={{ position: "relative" }}
          >
            {p.name}
            {defaultProvider === p.id && (
              <span
                style={{
                  position: "absolute",
                  top: -8,
                  right: -8,
                  background: "#f6ad55",
                  color: "white",
                  fontSize: 10,
                  borderRadius: 8,
                  padding: "0 5px",
                  lineHeight: "16px",
                }}
              >
                默认
              </span>
            )}
          </div>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "#afafaf", margin: "8px 0 12px" }}>{currentProvider.desc}</p>

      {currentProvider.fields.map((f) => (
        <div key={f.key} style={{ marginBottom: 12 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4 }}>{f.label}</label>
          <input
            type="password"
            value={fields[f.key] || ""}
            onChange={(e) => setField(f.key, e.target.value)}
            placeholder={f.placeholder}
            style={{ width: "100%", padding: 10, border: "1px solid #e5e5e5", borderRadius: 8 }}
          />
        </div>
      ))}

      {/* ISSUE-183/189/191：录音音量校验（考核 + 孩子端语音输入通用；每个孩子单独可配；随「保存」一起提交） */}
      <div style={{ marginTop: 24, borderTop: "1px solid #e5e5e5", paddingTop: 16 }}>
        <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>录音音量与朗读评分</h3>
        <p className="desc" style={{ marginBottom: 14 }}>
          录音音量不达标时：考核里的朗读/背诵题算没答、要求重录；孩子端聊天语音输入与音频转写不送识别、提示重说——
          让孩子大声说，减轻声音小导致的评分/识别误差。评分改用各维度（准确度/流利度/完整度）平均分。
          家长端聊天不做音量检测。
        </p>

        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
            默认录音最低平均音量：<b>{minVolumeNorm > 0 ? minVolumeNorm : "不校验（关闭）"}</b>
          </label>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={minVolumeNorm}
              onChange={(e) => setMinVolumeNorm(Number(e.target.value))}
              style={{ flex: 1, maxWidth: 320 }}
            />
            <span style={{ fontSize: 12, color: "#afafaf" }}>0 = 不校验</span>
          </div>
          <p style={{ fontSize: 12, color: "#afafaf", margin: "4px 0 0" }}>
            未单独设置的孩子（含以后新加的孩子）用这条默认线。录音平均音量低于此值（0-100 归一分）时，
            孩子端所有录音（考核朗读/背诵、聊天按住说话、音频转写）都会提示重说、不送识别/不算答；
            服务端对考核提交的录音再校一次。默认 42（约 -35dBFS）。
          </p>
        </div>

        {/* ISSUE-191：每个孩子单独的音量阈值——设备麦克风灵敏度 / 年龄 / 说话音量各不相同 */}
        <div style={{ marginBottom: 14 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
            每个孩子的录音阈值
          </label>
          <p style={{ fontSize: 12, color: "#afafaf", margin: "0 0 8px" }}>
            每个孩子的设备麦克风、年龄和说话音量不同，可单独调整；单独设置优先于上面的默认线。
            0 = 该孩子不校验。
          </p>
          {children.length === 0 ? (
            <p style={{ fontSize: 12, color: "#afafaf", margin: 0 }}>暂无孩子</p>
          ) : (
            children.map((c) => {
              const override = childNorm[c.childId];
              const value = override == null ? minVolumeNorm : override;
              const following = override == null;
              return (
                <div
                  key={c.childId}
                  style={{ display: "flex", alignItems: "center", gap: 10, margin: "6px 0" }}
                >
                  <span style={{ width: 96, fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={c.name}>
                    {c.avatar ? `${c.avatar} ` : ""}
                    {c.name}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={value}
                    onChange={(e) =>
                      setChildNorm((prev) => ({ ...prev, [c.childId]: Number(e.target.value) }))
                    }
                    style={{ flex: 1, maxWidth: 260 }}
                  />
                  <b style={{ width: 76, fontSize: 13 }}>{value > 0 ? value : "不校验"}</b>
                  <button
                    onClick={() => setChildNorm((prev) => ({ ...prev, [c.childId]: null }))}
                    disabled={following}
                    title="把该孩子恢复为跟随上面的默认线"
                    style={{
                      padding: "4px 10px",
                      borderRadius: 12,
                      border: "1px solid #dde3ea",
                      background: "#fff",
                      color: following ? "#c8c8c8" : "#1cb0f6",
                      fontSize: 12,
                      cursor: following ? "default" : "pointer",
                    }}
                  >
                    用默认
                  </button>
                </div>
              );
            })
          )}
        </div>

        <div style={{ marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 4, fontWeight: 500 }}>
            朗读/背诵通过线：<b>{recitePassDefault}</b> 分
          </label>
          <input
            type="number"
            min={0}
            max={100}
            value={recitePassDefault}
            onChange={(e) => setRecitePassDefault(Math.min(100, Math.max(0, Math.round(Number(e.target.value) || 0))))}
            style={{ width: 100, padding: "8px 10px", border: "1px solid #e5e5e5", borderRadius: 8 }}
          />
          <p style={{ fontSize: 12, color: "#afafaf", margin: "4px 0 0" }}>
            评分改为各维度平均后分数会变，达不到线的题目判不通过。题目/考核方法自带通过线的以自带为准，未设的用这里的默认值。
          </p>
        </div>

        <div style={{ marginTop: 14, marginBottom: 8 }}>
          <label style={{ display: "block", fontSize: 13, marginBottom: 6, fontWeight: 500 }}>
            打分松紧（阿里声希）：<b>{TYPE_THRES_LABEL[typeThres] || "默认"}</b>
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {TYPE_THRES_CHOICES.map((c) => (
              <button
                key={c.value}
                onClick={() => setTypeThres(c.value)}
                style={{
                  padding: "6px 14px",
                  borderRadius: 16,
                  border: typeThres === c.value ? "1px solid #58cc02" : "1px solid #dde3ea",
                  background: typeThres === c.value ? "#f7f7f7" : "#fff",
                  color: typeThres === c.value ? "#1cb0f6" : "#4b4b4b",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "#afafaf", margin: "6px 0 0" }}>
            只对「阿里 SSECP / 声希」生效，腾讯智聆没有这个参数。默认档不传参、沿用引擎自带松紧；
            孩子发音还不稳、评测显得偏严时可选「宽松」，想更严格可选「严格」。
          </p>
        </div>
      </div>

      <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
        <IconButton
          icon={Save}
          title="保存"
          onClick={handleSave}
          style={{ padding: "10px 20px", background: "#58cc02", color: "white", border: "none", borderRadius: 8, cursor: "pointer" }}
        />        <button
          onClick={setDefault}
          style={{
            padding: "10px 20px",
            background: defaultProvider === provider ? "#edf2f7" : "#e9f9dc",
            color: defaultProvider === provider ? "#718096" : "#58cc02",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {defaultProvider === provider ? "✓ 当前默认" : "设为默认"}
        </button>
        <button
          onClick={handleTest}
          disabled={testing}
          style={{
            padding: "10px 20px",
            background: recording ? "#ff4b4b" : "#e9f9dc",
            color: recording ? "white" : "#58cc02",
            border: "none",
            borderRadius: 8,
            cursor: "pointer",
          }}
        >
          {testing ? "评测中…" : recording ? "停止并评测" : "测试评测 🎤"}
        </button>
      </div>

      {status && (
        <p
          style={{
            fontSize: 13,
            color: /失败|无法|错误/.test(status) ? "#ff4b4b" : "#58cc02",
            marginTop: 16,
            whiteSpace: "pre-wrap",
          }}
        >
          {status}
        </p>
      )}

      {testSpeech?.words?.length ? (
        <div style={{ marginTop: 12, background: "#fbfaf6", border: "1px solid #eee6d2", borderRadius: 10, padding: "10px 12px" }}>
          <div style={{ fontSize: 12, color: "#777777", marginBottom: 4 }}>试评「hello」逐词得分</div>
          <SpeechText refText="hello" words={testSpeech.words} provider={testSpeech.provider} showSummary fontSize={16} />
        </div>
      ) : null}
    </div>
  );
}

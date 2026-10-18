import { useEffect, useState } from "react";
import { DEFAULT_MIN_VOLUME_NORM, parseVolumeThreshold } from "../lib/audio-volume";

/**
 * ISSUE-189：录音音量达标线的**唯一来源**——家长端「设置 → 发音评测 → 录音最低平均音量」。
 *
 * - 存储：家长级 `assessment_config.minVolumeNorm`（AES 加密，`server/src/routes/assessment.ts` 的
 *   GET/POST `/assessment/config`）；**0 = 不校验**。
 * - 子端为什么能读：孩子进入学习页使用的仍是家长会话（选孩子不换 token），
 *   `assessmentConfigGet` 与家长设置页是同一个服务端接口，拿到的就是家长配的那条线。
 * - 与考核 iframe 同源：考核走 `GET /exam/config` 下发的 `examRules.minVolumeNorm`
 *   （`server/src/routes/exam.ts`），值与本 hook 相同，不会出现"考核一条线、聊天另一条线"。
 * - 读不到（离线 / 接口失败 / 环境无此通道）回退默认 42（ISSUE-183 默认档），不因取不到配置卡住孩子。
 * - 模块级 60s 缓存：聊天窗/检测弹框各自挂载不会连着打接口；家长改完设置，最迟下一次
 *   重新打开检测弹框（或 60s 后重挂载）即生效。
 */
const TTL_MS = 60_000;
let cached: { value: number; at: number } | null = null;

export function useVolumeThreshold(): number {
  const [minNorm, setMinNorm] = useState<number>(cached?.value ?? DEFAULT_MIN_VOLUME_NORM);

  useEffect(() => {
    let alive = true;
    const apply = (value: number) => {
      cached = { value, at: Date.now() };
      if (alive) setMinNorm(value);
    };
    const load = async () => {
      const getConfig = (window as any).api?.assessmentConfigGet;
      if (typeof getConfig !== "function") return;
      try {
        const r: any = await getConfig();
        if (r?.success) {
          apply(parseVolumeThreshold(r.config?.minVolumeNorm, DEFAULT_MIN_VOLUME_NORM));
        } else {
          // 接口失败：保留上次值（没有则用默认），下次挂载再试
          if (alive) setMinNorm(cached?.value ?? DEFAULT_MIN_VOLUME_NORM);
        }
      } catch {
        /* 离线/失败保持默认或上次值 */
      }
    };
    if (!cached || Date.now() - cached.at > TTL_MS) void load();
    else setMinNorm(cached.value);
    return () => {
      alive = false;
    };
  }, []);

  return minNorm;
}

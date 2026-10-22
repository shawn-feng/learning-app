import { useEffect, useState } from "react";
import { DEFAULT_MIN_VOLUME_NORM, resolveVolumeThreshold } from "../lib/audio-volume";

/**
 * ISSUE-189 / ISSUE-191：录音音量达标线的**唯一来源**——家长端「设置 → 发音评测」。
 *
 * - 存储：家长级 `assessment_config`（AES 加密，`server/src/routes/assessment.ts` 的
 *   GET/POST `/assessment/config`）：
 *   - `minVolumeNormByChild[childId]` = 该孩子单独阈值（ISSUE-191，优先）；
 *   - `minVolumeNorm` = 家长默认线（未单独设置的孩子 / 新孩子回退用）；
 *   - **0 = 不校验**。
 * - 子端为什么能读：孩子进入学习页使用的仍是家长会话（选孩子不换 token），
 *   `assessmentConfigGet` 与家长设置页是同一个服务端接口，拿到的就是家长配置。
 * - 与考核 iframe 同源：考核走 `GET /exam/config/:childId` 下发的 `examRules.minVolumeNorm`
 *   （服务端按同一个孩子解析），不会出现"考核一条线、聊天另一条线"。
 * - **不传 childId = 家长端上下文**（家长聊天 / 家长试音）：返回 0，不做音量检测。
 * - 读不到（离线 / 接口失败 / 环境无此通道）回退默认 42（ISSUE-183 默认档），不因取不到配置卡住孩子。
 * - 模块级 60s 缓存（按 childId 分键）：聊天窗/检测弹框各自挂载不会连着打接口；
 *   家长改完设置，最迟 60s 后（或重新打开检测弹框）生效。
 */
const TTL_MS = 60_000;
const cache = new Map<string, { value: number; at: number }>();

export function useVolumeThreshold(childId?: string): number {
  const key = childId || "";
  const [minNorm, setMinNorm] = useState<number>(() =>
    childId ? cache.get(key)?.value ?? DEFAULT_MIN_VOLUME_NORM : 0
  );

  useEffect(() => {
    // 家长端上下文（没有 childId）：不需要音量阈值检测，直接 0（关闭）
    if (!childId) {
      setMinNorm(0);
      return;
    }
    let alive = true;
    const apply = (value: number) => {
      cache.set(key, { value, at: Date.now() });
      if (alive) setMinNorm(value);
    };
    const load = async () => {
      const getConfig = (window as any).api?.assessmentConfigGet;
      if (typeof getConfig !== "function") return;
      try {
        const r: any = await getConfig();
        if (r?.success) {
          apply(resolveVolumeThreshold(r.config, childId));
        } else {
          // 接口失败：保留上次值（没有则用默认），下次挂载再试
          if (alive) setMinNorm(cache.get(key)?.value ?? DEFAULT_MIN_VOLUME_NORM);
        }
      } catch {
        /* 离线/失败保持默认或上次值 */
      }
    };
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at > TTL_MS) void load();
    else setMinNorm(hit.value);
    return () => {
      alive = false;
    };
  }, [childId, key]);

  return minNorm;
}

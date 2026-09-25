/**
 * KB P2.1（2026-09-25）：**撤回要说得出，也要收得回**。
 *
 * ## 为什么需要这个扩展（实测缺陷）
 * `kb_lookup` 的门控是**读时**判的，所以撤回对"下一次查询"立刻生效。但孩子的会话**带着历史**：
 * 实测里家长撤回「恐龙是怎么没的」之后，**同一个会话里再问，孩子仍然说得出家里那句专属说法**
 * （`天上掉石头那一回`）——那一轮**没有任何 `kb_lookup` 调用**，答案是模型从对话历史里复述的。
 * 也就是说：**门控管得住"查得到查不到"，管不住"还记得不记得"。**
 * 而家长的预期是"这条先别给她看" = **从现在起别再讲**。
 *
 * ## 修法
 * 用 `before_agent_start`（`packages/agent-core/src/guard/learning-guard.ts` 注入日期用的同一机制）
 * 做两件事，**强度不同、触发条件也不同**：
 *
 * 1. **每一轮**往 system prompt 追一段复核纪律（只要库里还有"收回过"的条目）——
 *    成本是一段固定文本，稳定性足够（不会每轮都变，`learning-guard` 注释里那条
 *    "system prompt 是前缀缓存公共前缀"的教训仍然成立）。
 * 2. **撤回指纹一变**（`withdrawStamp`）就**额外往会话里插一条消息**（每个指纹一次，不重复）。
 *    这条是关键：实测证明**只靠 system prompt 后缀压不住**——模型在会话里刚说过
 *    "我的答案不会变哦"，下一轮照样复述，连 `kb_lookup` 都不调。注入的消息落在用户提问**之后**，
 *    是注意力最近的位置，且会被存进会话（后续轮次里它仍在历史中，只是不再重复添加）。
 *
 * ## 为什么不直接把"被撤回的条目名"注入进去（那样更硬）
 * **会凭空扩大暴露面**。撤回的条目里包含「教师用书上怎么说的」这种**家长根本不想让这个孩子知道存在**的东西；
 * 把标题写进孩子的上下文，等于告诉模型"有这么一条"，它可能顺口说出来。
 * 相比之下，"复核纪律"不泄漏任何标题，且**用既有门控工具当执行点**——门控只有一处真源这条不变式不破。
 *
 * ## 一条工程约束
 * **绝不因为这件事挡住一轮对话**：读库失败/无表一律静默跳过。
 */
import { openParentLib } from "../db/parent-lib.js";
import { countWithdrawn, withdrawStamp } from "../db/kb-entries.js";

export interface KbWithdrawNoticeDeps {
  dataDir: string;
  parentId: string;
  /** 回溯窗口（天）：更早撤回的条目，孩子不可能还在当前会话里提过（会话按天新建） */
  sinceDays?: number;
}

const NOTE = `

## ⚠️ 家长可能刚撤回过说法（硬规则，优先于对话历史）
家长**随时**可以撤回或改写知识库里的说法。**撤回的意思就是「从现在起不要再讲」**——
哪怕你上一轮刚讲过，哪怕孩子说"你刚才不是说了吗"。
- 孩子问到的事，如果你之前引用过「爸爸妈妈给你准备的说法」，**先用 kb_lookup 重新核对**；
- 核对不到（被撤回或退回草稿）→ **连一个字的原文都不许再重复**，也不许说「还是那句」「我的答案不变」
  「咱们家管它叫……」这类换壳复述；直接说「这个我记不清了，得去问问爸爸妈妈」，然后把话题带走；
- **"我记得"不是可以继续讲的理由**——你记得的内容可能已经作废了。`;

/** 往会话里插的那条消息（位置在用户提问之后 → 注意力最近） */
const MESSAGE = `【系统提醒 · 家长调整过知识库】
家长**最近撤回过**（或删除过）知识库里的说法。如果本次对话里你引用过「爸爸妈妈准备的说法」：
1. **不要再重复它**——包括"还是那句""我的答案不变""咱们家管它叫……"这类换壳说法；
2. 孩子再问到同一件事，**先 kb_lookup 核对**；核对不到就如实说「这个我记不清了，得去问问爸爸妈妈」，并换话题；
3. 不要提"家长撤回了"这件事，自然地把话题带走。`;

export function createKbWithdrawNoticeExtension(deps: KbWithdrawNoticeDeps) {
  // 每个会话一份闭包（工厂由 createCoreSession 按会话构造），记的是"这个会话提醒过哪个撤回指纹"。
  // 服务重启会重置它 → 最多多提醒一次（措辞用"最近撤回过"，两种情形都成立）。
  let lastStamp: string | null = null;

  return function kbWithdrawNotice(pi: any) {
    pi.on("before_agent_start", async (event: any) => {
      let n = 0;
      let stamp = "";
      try {
        const lib = openParentLib(deps.dataDir, deps.parentId);
        try {
          n = countWithdrawn(lib, deps.sinceDays ?? 14);
          stamp = withdrawStamp(lib, deps.sinceDays ?? 14);
        } finally {
          lib.close();
        }
      } catch {
        return; // 库读不到就不注入，不阻塞对话（这条纪律是"加分项"，不是前置条件）
      }
      if (n <= 0) return;

      const out: Record<string, unknown> = { systemPrompt: (event?.systemPrompt ?? "") + NOTE };
      // 指纹没变 = 这一轮之前已经提醒过，不必每轮重复（免得把会话撑满、也免得模型把提醒当背景噪音）。
      if (lastStamp !== stamp) {
        lastStamp = stamp;
        out.message = { customType: "kb-withdraw-notice", content: MESSAGE, display: false };
      }
      return out;
    });
  };
}

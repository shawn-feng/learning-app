/**
 * 孩子 agent 的知识库检索工具（KB P1，2026-09-27）。
 *
 * ## 只有一把
 * `kb_lookup` 是孩子侧**唯一**的检索入口。刻意**没有**：
 * - 任何"列出全部条目"的工具（上下文灾难）；
 * - 读 `materials/` 的 `read` / `ls`（`fs-tools.ts` 的边界不动）；
 * - `parent_list_materials`（本来就是家长工具）；
 * - 通用数据库通道（ISSUE-142 已撤）。
 *
 * 好处：**门控只有一处要守，验收也只需测一处**。
 *
 * ## 检索与展示是两跳
 * `kb_lookup` 只检索、只把「可展示」的路径**说出来**；真展示由孩子自己决定调 `display_content`。
 * 分开的理由：孩子正专心听时弹图会打断，而且展示是"孩子端开面板"的副作用，
 * 不该由一次查询顺带触发。
 *
 * ## 安全边界
 * 连接不经参数：`parentId`/`childId` 来自会话绑定，孩子物理上只能查到
 * `status='published' AND visibility='child' AND (share='all' OR share=<自己>)` 的条目——
 * 过滤在 SQL 里（`db/kb-entries.ts` 的 `GATED_WHERE`），**不靠提示词**。
 */
import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import { defineTool } from "./tool-kit.js";
import { openParentLib } from "../db/parent-lib.js";
import {
  KB_MATCH_LIMIT,
  KB_VECTOR_THRESHOLD,
  getGatedEntry,
  judgeHighRisk,
  recordKbGap,
  searchKbForChild,
  zhAssetKind,
  type KbHit,
} from "../db/kb-entries.js";
// KB P3：精确未命中 → 向量 top-K 兜底（复用既有 embeddings 设施）
import {
  KB_ENTRY_TEXT_COLUMN,
  embedTexts,
  parentLibCacheKey,
  resolveEmbedding,
  topVectorRows,
  vectorThreshold,
} from "./embeddings.js";

export interface ChildKbToolDeps {
  dataDir: string;
  parentId: string;
  childId: string;
  /** 主库（读家长 settings 取 embedding 凭证用）。缺省则**不做**向量兜底，行为退回 P1 */
  db?: DatabaseSync;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

/**
 * 每条命中的块。`authoritative` 区分**精确命中**与**语义候选**——
 * 两者的「依据」那一行必须不同：前者可以直接引用，后者**必须先确认是同一件事**。
 * （只在外层写"先判断"是不够的：模型会把块内那行「可直接引用」也当成指令，两处说法打架。）
 */
function hitBlocks(hits: KbHit[], opts?: { authoritative?: boolean }): string {
  const authoritative = opts?.authoritative !== false;
  return hits
    .map((h) => {
      const basis = authoritative
        ? "依据：家长口径（可直接引用）"
        : "依据：家长口径（**先确认说的确实是这件事**再引用）";
      const head = `${h.title} ｜ 出处：家长知识库 ｜ ${basis}`;
      const lines = [`- ${head}`];
      const summary = String(h.summary ?? "").trim();
      if (summary) {
        lines.push(summary.split("\n").map((l) => `  ${l}`).join("\n"));
      }
      if (String(h.usage ?? "").trim()) lines.push(`  用法：${String(h.usage).trim()}`);
      if (h.assets.length) {
        lines.push(
          `  可展示（用 display_content 放给孩子看，一次一份）：` +
            h.assets.map((a) => `${a.title ? `「${a.title}」` : ""}${a.path}（${zhAssetKind(a.path)}）`).join("；")
        );
      }
      if (!summary && h.assets.length) {
        lines.push(`  这条**没有给说法**，只有资料：不要替这段资料加解说；先问她要不要看，再决定放不放。`);
      }
      lines.push(
        summary
          ? `  注意：以上是这条口径的全部内容——超出这些的具体数字、人名、引文一律不要补。`
          : `  注意：这条只提供资料，不要凭自己的了解补充它没说的内容。`
      );
      return lines.join("\n");
    })
    .join("\n");
}

export function formatHits(hits: KbHit[]): string {
  return (
    `命中 ${hits.length} 条（${hits.map((h) => h.via).join("；")}）：\n${hitBlocks(hits)}\n\n` +
    `**怎么用**：上面「依据：家长口径」的部分**直接照着说**，以它为准（哪怕你的一般了解不一样），并说得出这是爸爸妈妈给你准备的；` +
    `有「可展示」的资料时，问她想不想看，再调 display_content。`
  );
}

/**
 * **语义命中的回话（与精确命中刻意不同）**：只作**候选提示**，不写成"依据：家长口径（可直接引用）"。
 *
 * 为什么必须区分：精确命中是"孩子问的词与条目对上了"，语义命中是"意思接近"——
 * 后者可能是同一件事，也可能只是**话题相邻**（问"恐龙"命中"考古"，问"月亮"命中"太阳"）。
 * 把相似当成就是，等于让一句**家长为一个别的问题认过的话**冒充这个问题的权威口径，
 * 比"没答上来"更糟。所以这里把判断权交给 agent，并要求它给不确认的情况一个退路（去问爸爸妈妈）。
 *
 * 这与仓库既有约定同源：向量候选「**只提示不代入**」（`embeddings.ts` 的 `formatCandidates`）。
 */
export function formatSemanticHits(hits: KbHit[]): string {
  return (
    `**精确没命中**（孩子问的词，库里没有）。以下是**语义上最接近**的条目——注意它们**不是原词命中**，\n` +
    `**你要先判断「是不是同一件事」**：\n\n${hitBlocks(hits, { authoritative: false })}\n\n` +
    `**怎么用（重要，别跳过）**：\n` +
    `- **确认是同一件事** → 可以按那条的说法讲（那是家长认过的），并说得出这是爸爸妈妈给你准备的；\n` +
    `- **不确定，或明显只是话题相邻** → **当没命中处理**：普通常识可按你自己的一般了解答（开头说明那是你自己的了解），\n` +
    `  属神/宗教/生死/身体/家里规矩/钱/同伴关系这类话题就去问爸爸妈妈；\n` +
    `- **不要把「相似」当成「就是」**——家长的说法只在**说的确实是这件事**时才算数。`
  );
}

export function createChildKbTools(deps: ChildKbToolDeps) {
  /**
   * KB P3 语义兜底：精确一条没命中时，用向量找"问法不同但说的是同一件事"的**条目**。
   *
   * 三条硬约束（都在这里，不在别处）：
   * 1. **向量只排序，内容回表按当前状态重读**（`getGatedEntry`）——旁表里的向量是写入那一刻的快照，
   *    家长后来可能撤回了或改回草稿了；**门控只有一处真源**，不因为换了一条召回路径就再写一遍。
   * 2. **只在精确零命中时才走**（省一次嵌入调用，且精确命中的可信度天然更高）。
   * 3. **任何失败都静默降级回"没命中"**：没配 embedding、服务超时、库读不到——都只是退回 P1 行为，
   *    **绝不让检索失败变成"拦住孩子提问"**。
   *
   * 返回值里的 `semantic: true` 会让回话多一句提醒：这是**语义匹配**（不是原词命中），
   * 因为"意思接近"和"就是这件事"之间确有差别——口径答错比答不上更糟。
   */
  async function semanticHits(lib: DatabaseSync, childId: string, query: string): Promise<KbHit[]> {
    if (!deps.db) return [];
    try {
      const { readParentSettings } = await import("../worker/scheduler.js");
      const settings = await readParentSettings(deps.db, deps.dataDir, deps.parentId);
      const resolved = resolveEmbedding(settings.auth);
      if (!resolved) return [];
      const [qv] = await embedTexts(resolved, [query]);
      const rows = topVectorRows(lib, "kb_entries", KB_ENTRY_TEXT_COLUMN, qv, {
        topK: KB_MATCH_LIMIT,
        // 阈值：家长显式配了就用家长的，否则用 KB 专用默认（0.45，理由见 KB_VECTOR_THRESHOLD）
        threshold: vectorThreshold(settings.appSettings, KB_VECTOR_THRESHOLD),
        cacheKey: parentLibCacheKey(deps.dataDir, deps.parentId),
      });
      const out: KbHit[] = [];
      for (const r of rows) {
        let id = "";
        try {
          id = String((JSON.parse(r.rowPk) as unknown[])[0] ?? "");
        } catch {
          continue;
        }
        if (!id) continue;
        const hit = getGatedEntry(lib, childId, id, `语义匹配 ${r.score.toFixed(2)}`);
        if (hit) out.push(hit);
      }
      return out;
    } catch {
      return []; // 静默降级：检索失败 ≠ 拦住提问
    }
  }

  const lookupTool = defineTool({
    name: "kb_lookup",
    label: "查爸爸妈妈给你准备的说法和资料",
    description:
      "查一条知识条目：爸爸妈妈有没有为这件事预先准备好「该怎么说」和「该给她看什么」。\n\n" +
      "**何时调用**：孩子问知识类问题（历史、科学、成语、某件事怎么回事）**之前**，先查一次。传孩子问的**原话**或关键词都行。\n" +
      "**命中**就按库里的说（库里为准、说得出出处）；**没命中**：普通常识可以答但要说明「这是我自己的一般了解」，\n" +
      "涉及神/宗教/生死/身体/家里规矩/钱/同伴关系这类话题**不要给结论**，告诉他你会先去问爸爸妈妈。\n" +
      "**判定不了要不要算「需要家长口径」时传 `high_risk: true`**——宁可多记一条让家长划掉，也不要硬答。",
    parameters: Type.Object({
      query: Type.String({ description: "孩子问的原话（「人是女娲造的吗」），或关键词（「甲骨文」）" }),
      high_risk: Type.Optional(
        Type.Boolean({ description: "true = 这是需要家长口径的话题（神/宗教/生死/身体/家里规矩/钱/同伴关系）" })
      ),
    }),
    execute: async (_id: string, params: { query?: string; high_risk?: boolean }) => {
      const query = String(params?.query ?? "").trim();
      if (!query) throw new Error("kb_lookup 需要 query（孩子问的原话或关键词）");

      let lib: ReturnType<typeof openParentLib>;
      try {
        lib = openParentLib(deps.dataDir, deps.parentId);
      } catch (err) {
        // 读不到库时**不放行自由发挥**：不知道有没有家长口径，就不能当成"没有"
        return ok(
          `知识库暂时读不到（${(err as Error).message}）。如果这是需要家长口径的话题（神/宗教/生死/身体/家里规矩/钱/同伴关系），` +
            `**先不要给结论**，告诉孩子你会先去问爸爸妈妈；普通常识可以按你的一般了解答，但要说清这是你自己的了解。`
        );
      }
      try {
        const hits = searchKbForChild(lib, deps.childId, query, KB_MATCH_LIMIT);
        if (hits.length) return ok(formatHits(hits));

        // P3：精确零命中 → 语义兜底（问法不同但可能同一件事；**只作候选提示，不直接当权威口径**）
        const semantic = await semanticHits(lib, deps.childId, query);
        if (semantic.length) return ok(formatSemanticHits(semantic));

        const risk = judgeHighRisk(lib, query, params?.high_risk === true);
        if (risk.high) {
          const rec = recordKbGap(lib, deps.childId, query, true, hits);
          return ok(
            `库里没有命中，而且这属于**需要家长口径**的话题` +
              (risk.source === "floor" || risk.source === "configured" ? `（命中词表：「${risk.matched}」）` : "") +
              `。\n` +
              `⚠️ **不要给结论、不要编**。请告诉孩子：这个问题要先去问爸爸妈妈，你记下来了` +
              `（已记入家长的待补充清单${rec.count > 1 ? `，这是第 ${rec.count} 次问了` : ""}）。\n` +
              `可以做的事：陪她把问题本身说清楚（"你是想问……对吗？"），或者先聊她已经知道的部分——但**不要替爸爸妈妈回答**。`
          );
        }
        return ok(
          `库里没有命中「${query}」，这看起来是**一般常识类**问题。\n` +
            `可以按你自己的一般了解回答，但**开头必须先说清**「这是我自己的一般了解，不是你爸爸妈妈给你准备的说法」；` +
            `并且**不许编具体数字、人名、引文**，也不要跟家长已经定过的任何说法相抵触。`
        );
      } finally {
        lib.close();
      }
    },
  });

  return [lookupTool];
}

/** 孩子会话装配的知识库工具名（只有这一把） */
export const CHILD_KB_TOOL_NAMES = ["kb_lookup"];

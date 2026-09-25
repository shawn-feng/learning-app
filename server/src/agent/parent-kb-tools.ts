/**
 * 家长 agent 的知识库工具（KB P1 三把 + P2 第四把，2026-09-27）。
 *
 * 四把工具，覆盖「定说法 / 挂资料 / 发布 / 挂到课上 / 看缺口 / 管风险词表」：
 * - `parent_kb_save`   ：落草稿（条目 + 资产 + 风险词表增删）
 * - `parent_kb_list`   ：列条目 / 列待补充 / 列建议清单 / 列风险词表
 * - `parent_kb_publish`：发布（给孩子看）或撤回
 * - `parent_kb_bind`   ：挂到某节课上 / 从课上摘下（**P2**：绑了才有注入通道，P1 故意不注册）
 *
 * ## 三条必须由**代码**保证、不靠模型自觉的性质
 * 1. 新建条目**恒为** `draft` + `visibility = 'parent'`（草稿门 + 默认不给这个孩子看）；
 * 2. 改写已发布条目的 `summary` → **退回草稿**（不许悄悄换掉正在生效的家长口径）；
 * 3. 只能把**已发布 + 给她看**的条目挂到课上（见 `db/kb-entries.ts` 的 `bindEntryToCourse`）——
 *    绑定是一条注入通道，能进课堂的和能进 `kb_lookup` 的必须是同一批。
 * 三条都在 `db/kb-entries.ts` 里强制，本文件只做参数归一与回报。
 *
 * ## 说明下沉（ISSUE-144 约定）
 * 本文件的 description/参数说明是**说明书真源**，进上下文的是压缩后的一句 + 指路
 * （`parent-tool-compact.ts`）。⚠️ **这四把必须被某个场景技能的 `tools` 声明**
 * （`parent-scene-kb`），否则会被判定"不属于任何场景"而**原样保留、且不加场景守卫**。
 */
import { Type } from "typebox";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { defineTool } from "./tool-kit.js";
import { openParentLib } from "../db/parent-lib.js";
import { resolveTopicKey } from "./plan-tools.js";
import { markStale, KB_ENTRY_TEXT_COLUMN } from "./embeddings.js";
import { textify, KB_BODY_MAX } from "./kb-ingest.js";
import { resolveMaterialFile } from "../db/materials.js";
import { coerceArrayArg, coerceObjectArg } from "./db-channel.js";
import { JsonArrayParam } from "./tool-shapes.js";
import {
  bindEntryToCourse,
  deleteKbEntries,
  getKbEntry,
  listKbEntries,
  listKbGaps,
  listKbSuggestions,
  listRiskTerms,
  publishKbEntries,
  saveKbEntries,
  updateRiskTerms,
  type KbAssetInput,
  type KbEntryInput,
} from "../db/kb-entries.js";

export interface ParentKbToolDeps {
  dataDir: string;
  parentId: string;
  /** 主库（读家长 settings 取 embedding 凭证用）。缺省则写入后**不排队建向量**，检索退回纯精确 */
  db?: DatabaseSync;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });

const cut = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const STATUS_ZH: Record<string, string> = { draft: "草稿", published: "已发布", archived: "已收起" };
const ORIGIN_ZH: Record<string, string> = { manual: "家长原话", generated: "助手整理", upload: "上传", extracted: "提取" };

/** 「给孩子看 / 先不给看」——内部字段翻译成家长看得懂的话（**界面上不出现 visibility/口径**） */
const VIS_ZH: Record<string, string> = { child: "可以给她看", parent: "先不给她看" };

export function createParentKbTools(deps: ParentKbToolDeps) {
  /** 每把工具各开一次库；家长维度库很小，开库成本可忽略（与既有家长工具一致） */
  function withLib<T>(fn: (lib: ReturnType<typeof openParentLib>) => T): T {
    const lib = openParentLib(deps.dataDir, deps.parentId);
    try {
      return fn(lib);
    } finally {
      lib.close();
    }
  }

  /**
   * KB P3：把刚写过的条目排队重建向量（`kb_entries` 的**合成检索文本**，见 `embeddings.ts`）。
   *
   * 为什么在这里调、而不是在 `saveKbEntries` 里：`db/kb-entries.ts` 是纯数据层，
   * 不依赖 embedding 凭证与主库；写路径上挂派生索引是**调用层**的事（与 db-channel 的
   * `writeTouchesEmbedded` 同一分工）。没有 `db` 就静默跳过——功能降级为纯精确匹配，不影响落库。
   *
   * 删除也要排一次：worker 查不到行就会把旁表向量删掉（见 `markStale` 的"行已删 → 删向量"分支）。
   */
  function queueEmbed(ids: string[]): void {
    if (!deps.db || !ids.length) return;
    const ctx = { db: deps.db, dataDir: deps.dataDir, parentId: deps.parentId };
    for (const id of ids) {
      try {
        markStale(ctx, "kb_entries", [id]);
      } catch {
        /* 排队失败不影响落库；下次更新会再排 */
      }
    }
  }

  /**
   * P3 backfill：把**还没有向量**的条目补排队。
   *
   * 为什么需要：`markStale` 只在写入那一刻排队，所以**本轮之前建的条目一条向量都没有**——
   * 它们只能被精确匹配找到，语义兜底对它们等于不存在（静默的功能缺失，最难发现的那种）。
   * 在家长看清单时顺手做（清单条目量在 10²，diff 一次可忽略），不另起定时任务。
   */
  function queueEmbedMissing(lib: ReturnType<typeof openParentLib>): number {
    if (!deps.db) return 0;
    try {
      const have = new Set(
        (
          lib
            .prepare("SELECT row_pk FROM embeddings WHERE table_name = 'kb_entries' AND column_name = ?")
            .all(KB_ENTRY_TEXT_COLUMN) as Array<{ row_pk: string }>
        ).map((r) => r.row_pk)
      );
      const missing = (lib.prepare("SELECT id FROM kb_entries").all() as Array<{ id: string }>)
        .map((r) => r.id)
        .filter((id) => !have.has(JSON.stringify([id])));
      queueEmbed(missing);
      return missing.length;
    } catch {
      return 0; // 无 embeddings 表/读不到 → 静默跳过（这只是"顺手补"，不是清单的必要条件）
    }
  }

  const saveTool = defineTool({
    name: "parent_kb_save",
    label: "存下「该怎么说 / 该给她看什么」",
    description:
      "把家长的「这件事该怎么跟她说」和「该给她看哪份资料」存成知识条目，**新建一律先存成草稿、先不给孩子看**。\n\n" +
      "**何时调用**：家长说「以后她问这个就这么说」「按这个口径讲」「这几份资料是给她看的」「这个视频给她看，但第 12 分钟跳过」，\n" +
      "或要调整「哪些话题必须等你开口」（risk_terms）。\n\n" +
      "**必须先做**：把要存的话**整理成清单复述给家长、得到确认**再调用（家长看不到你脑子里的草稿）。\n" +
      "**`summary` 的来源**：能引用家长原话就用原话。自己润色、补句、改词组的 → **传 `drafted_by: \"ai\"`**（缺省值，会被标成「助手整理」）；\n" +
      "家长**一字一句给了原话**、你原样照抄 → 才传 `drafted_by: \"parent\"`。**不要替家长想他没说过的数字、人名、引文。**\n\n" +
      "**两类条目**（`summary` 与资产至少要有一样）：\n" +
      "- 口径类：靠 `summary`（孩子问到时唯一会拿到的依据）；\n" +
      "- 材料类：靠 `assets`（挂纪录片/绘本/网页）+ `usage`（什么时候给她看、要注意什么），`summary` 可以留空。\n\n" +
      "**两条硬规则（代码强制，做不到就是白填）**：新建恒为「草稿 + 先不给她看」，要给孩子看得再调 `parent_kb_publish`；\n" +
      "已发布条目的 `summary` 被改写会**自动退回草稿**，需要家长再确认一次。\n\n" +
      "**参数**：`entries`（条目数组，`title` 必填；给了 `id` 或同名已有条目＝改那一条）·\n" +
      "`assets`（`{ entry_title 或 entry_id, path, title?, seq? }`，`path` 用 `parent_list_materials` 给的相对路径；\n" +
      "**文件必须真实存在**，不存在当场报错）· `risk_terms`（`{add:[...], remove:[...]}`，见下）。\n\n" +
      "**风险词表**：命中这些词的问题会被当成「需要家长口径」、助手不给结论只记待办。\n" +
      "`add` 加词（可带 `note`），`remove` 关掉词。**底线词（自杀/自残/死/去世/身体/亲嘴/打我/欺负）关不掉**——\n" +
      "被拒时如实告诉家长原因，不要改成别的说法绕过去。\n\n" +
      "**`delete`：删掉条目（不可逆）**。家长说「这条不要了」「建错了删掉」时用。\n" +
      "**只能删孩子当前看不到的**（草稿，或已经撤回的）：还给孩子看着的条目会被拒，\n" +
      "**必须先撤回再删**——撤回是可逆的，删除不是，所以不可逆的动作要排在可逆动作之后。\n" +
      "被拒时如实说「我先把它收回来，您再确认一次要不要真的删」，**不要直接说已经删了**。\n\n" +
      "**`ingest`：把资料读成文字收进条目**（html/htm、md、txt）。家长传了资料说「这份收进库里」时用。\n" +
      "**读出来的是「资料讲了什么」，不是「该怎么说」**——正文只进 `body`，用来让孩子**换个问法也能找到这条**；\n" +
      "她真正听到的仍然是 `summary`。所以 ingest 之后**必须追问一句**「这件事你想怎么跟她说？」。\n" +
      "**PDF 与图片还读不了**：被拒时如实说，并给出路（让家长口述要点，或先按「只有资料」的条目挂上）。\n\n" +
      "**五个字段都是「只改你给了的」**：更新时不传 `summary` 就不会动原来那段话（要清空得显式传空串）。",
    parameters: Type.Object({
      entries: Type.Optional(
        JsonArrayParam(
          Type.Object({
            id: Type.Optional(Type.String({ description: "已有条目 id（改那一条）；不传则按 title 找同名条目" })),
            title: Type.String({ description: "条目名（家长认人的标签，也是孩子按名问时的第一顺位）" }),
            aliases: Type.Optional(Type.String({ description: "孩子可能怎么问，逗号分隔（如：甲骨文,卜辞,商朝文字）" })),
            summary: Type.Optional(Type.String({ description: "可以这样跟她说：那段话（家长认过的，孩子只会拿到这段）" })),
            tags: Type.Optional(Type.String({ description: "家长侧归类标签，逗号分隔" })),
            usage: Type.Optional(Type.String({ description: "什么时候给她看、要注意什么（如：第 12 分钟有点吓人，跳过）" })),
            share: Type.Optional(Type.String({ description: "all=所有孩子（缺省）/ <childId>=只给某一个" })),
            drafted_by: Type.Optional(
              Type.Union([Type.Literal("parent"), Type.Literal("ai")], {
                description: "这段说法谁拟的：parent=家长原话照抄 / ai=助手整理（缺省）",
              })
            ),
          }),
          "要存的条目（每条至少要有 title）"
        )
      ),
      assets: Type.Optional(
        JsonArrayParam(
          Type.Object({
            entry_id: Type.Optional(Type.String({ description: "挂到哪条条目（id）" })),
            entry_title: Type.Optional(Type.String({ description: "挂到哪条条目（标题，可与本次 entries 同名）" })),
            path: Type.String({ description: "资料库相对路径，来自 parent_list_materials" }),
            title: Type.Optional(Type.String({ description: "给这份文件起的名字（缺省用文件名）" })),
            seq: Type.Optional(Type.Number({ description: "展示顺序" })),
          }),
          "要挂到条目上的资料（文件必须真实存在）"
        )
      ),
      risk_terms: Type.Optional(
        Type.Object(
          {
            add: Type.Optional(
              JsonArrayParam(
                Type.Object({
                  term: Type.String({ description: "关键词" }),
                  note: Type.Optional(Type.String({ description: "为什么加（给家长自己看）" })),
                }),
                "要加的词"
              )
            ),
            remove: Type.Optional(
              JsonArrayParam(Type.String(), "要关掉的词（底线词关不掉，会被拒并说明原因）")
            ),
          },
          { description: "调整「哪些话题必须等家长开口」的词表" }
        )
      ),
      delete: Type.Optional(
        JsonArrayParam(Type.String(), "要**删掉**的条目（id 或精确标题）。只能删孩子看不见的；删了没法恢复")
      ),
      ingest: Type.Optional(
        JsonArrayParam(
          Type.Object({
            path: Type.String({ description: "资料库相对路径（来自 parent_list_materials）" }),
            title: Type.Optional(Type.String({ description: "新建条目时的条目标题；缺省取文件名" })),
            entry_id: Type.Optional(Type.String({ description: "把提取的正文灌进这条已有条目（id）" })),
            entry_title: Type.Optional(Type.String({ description: "同上，按精确标题" })),
          }),
          "把资料读成文字收进条目（html/md/txt；PDF 与图片暂不支持）"
        )
      ),
    }),
    execute: async (_id: string, params: Record<string, unknown>) => {
      const entriesArg = coerceArrayArg(params?.entries, "entries");
      if (entriesArg.error) throw new Error(entriesArg.error);
      const assetsArg = coerceArrayArg(params?.assets, "assets");
      if (assetsArg.error) throw new Error(assetsArg.error);
      const riskArg = coerceObjectArg(params?.risk_terms, "risk_terms");
      if (riskArg.error) throw new Error(riskArg.error);
      const riskRaw = riskArg.value ?? {};
      const riskAdd = coerceArrayArg(riskRaw.add, "risk_terms.add");
      if (riskAdd.error) throw new Error(riskAdd.error);
      const riskRemove = coerceArrayArg(riskRaw.remove, "risk_terms.remove");
      if (riskRemove.error) throw new Error(riskRemove.error);
      const delArg = coerceArrayArg(params?.delete, "delete");
      if (delArg.error) throw new Error(delArg.error);
      const ingestArg = coerceArrayArg(params?.ingest, "ingest");
      if (ingestArg.error) throw new Error(ingestArg.error);

      const entries = (entriesArg.value as KbEntryInput[]) ?? [];
      const assets = (assetsArg.value as KbAssetInput[]) ?? [];
      const delKeys = delArg.value.map((x) => String(x));
      const hasRisk = riskAdd.value.length > 0 || riskRemove.value.length > 0;
      const ingestItems = (ingestArg.value as Array<{ path?: string; title?: string; entry_id?: string; entry_title?: string }>) ?? [];
      if (!entries.length && !assets.length && !hasRisk && !delKeys.length && !ingestItems.length) {
        throw new Error(
          "parent_kb_save 至少要给 entries（条目）/ assets（资料）/ ingest（把资料读成文字）/ risk_terms（词表）/ delete（删除）之一"
        );
      }

      return withLib((lib) => {
        const out: string[] = [];
        /**
         * **ingest 先展开成 entries/assets，与调用方给的一起、只落一次库**。
         *
         * 为什么必须合并（实测踩到的 bug）：模型会把 `entries` 与 `ingest` 放在**同一次调用**里
         * （"建一条『恐龙小知识（资料）』，正文从这份 html 来"）。若两者分两次落库，
         * 第一趟里那条 `entries` 既没有 `summary` 也没有资产 → 被「至少要有一样」直接拒掉，
         * 而它的资产本该由这一趟的 ingest 提供。**同一批意图必须走同一次校验。**
         */
        const ingNotes = new Map<string, string>();
        const ingEntries: KbEntryInput[] = [];
        const ingAssets: KbAssetInput[] = [];
        for (const it of ingestItems) {
          const rel = String(it?.path ?? "").trim().replace(/\\/g, "/").replace(/^materials\//, "");
          if (!rel) throw new Error("parent_kb_save 的 ingest 每一项都要有 path");
          const abs = resolveMaterialFile(deps.dataDir, deps.parentId, rel);
          if (!fs.existsSync(abs)) {
            throw new Error(`资料不存在：${rel}（先用 parent_list_materials 核对准确相对路径，别猜）`);
          }
          const ex = textify(fs.readFileSync(abs, "utf-8"), rel);
          let target: { id?: string; title: string };
          const anchor = String(it?.entry_id ?? it?.entry_title ?? "").trim();
          if (anchor) {
            // 灌进已有条目：**必须沿用库里那个标题**——`saveKbEntries` 会把 title 一起更新，
            // 若这里传文件名当标题，就等于顺手把家长的条目改名了。
            const exist = getKbEntry(lib, anchor);
            if (!exist) throw new Error(`要灌正文的条目不存在：${anchor}（先用 parent_kb_list 核对标题或 id）`);
            target = { id: exist.id, title: exist.title };
          } else {
            target = { title: String(it?.title ?? "").trim() || rel.split("/").pop()!.replace(/\.[^.]+$/, "") };
          }
          ingEntries.push({ ...target, body: ex.text });
          ingAssets.push({ ...(target.id ? { entry_id: target.id } : { entry_title: target.title }), path: rel });
          ingNotes.set(
            target.title,
            `- 「${target.title}」← ${rel}（${ex.chars} 字${ex.truncated ? `，太长只收了前 ${KB_BODY_MAX} 字` : ""}）`
          );
        }

        const allEntries: KbEntryInput[] = [...entries, ...ingEntries];
        const allAssets: KbAssetInput[] = [...assets, ...ingAssets];
        if (allEntries.length || allAssets.length) {
          const saved = saveKbEntries(lib, deps.dataDir, deps.parentId, allEntries, allAssets);
          queueEmbed(saved.map((s) => s.id));
          // 消息分两段：ingest 来的那些要单独说清"这是资料不是说法"
          const fromIngest = saved.filter((s) => ingNotes.has(s.title));
          const plain = saved.filter((s) => !ingNotes.has(s.title));
          if (plain.length) {
            const lines = plain.map((s) => {
              const bits = [
                `${s.created ? "新建" : "更新"}「${s.title}」`,
                `${STATUS_ZH[s.status] ?? s.status}·${VIS_ZH[s.visibility] ?? s.visibility}`,
                `${ORIGIN_ZH[s.origin] ?? s.origin}`,
                s.assetCount ? `${s.assetCount} 份资料` : "无资料",
                `id=${s.id}`,
              ];
              return `- ${bits.join("｜")}`;
            });
            out.push(`已存 ${plain.length} 条（**都是草稿，还没给孩子看**）：\n${lines.join("\n")}`);
            const requal = plain.filter((s) => s.requalified);
            if (requal.length) {
              out.push(
                `⚠️ 其中 ${requal.length} 条原来是**已发布**的，因为改了「可以这样跟她说」那段话，**已退回草稿**——` +
                  `必须请家长再确认一次，再用 parent_kb_publish 发布：${requal.map((s) => `「${s.title}」`).join("、")}`
              );
            }
            out.push(
              `**下一步（必须做）**：问家长「这几条哪几条现在就可以给她看？」——得到明确答复后调 parent_kb_publish 发布；` +
                `没答复就保持草稿，不要在下一轮自作主张发布。`
            );
          }
          if (fromIngest.length) {
            out.push(
              `已把 ${fromIngest.length} 份资料读成文字收进条目（**仍是草稿、还没给她看**）：\n` +
                fromIngest.map((s) => ingNotes.get(s.title)).join("\n") +
                `\n\n⚠️ **读出来的是「资料讲了什么」，不是「该怎么说」。** 提取的正文只用来让孩子**换个问法也能找到这条**；` +
                `孩子真正听到的仍然是 ` +
                "`summary`（你认过的那段话）。所以要给她看之前，先补一句「这件事该怎么跟她说」——" +
                `再问家长「这条现在可以给她看吗？」。`
            );
          }
        }
        if (hasRisk) {
          const r = updateRiskTerms(lib, {
            add: (riskAdd.value as Array<{ term?: string; note?: string }>).map((x) => ({
              term: String(x?.term ?? ""),
              note: String(x?.note ?? ""),
            })),
            remove: riskRemove.value.map((x) => String(x)),
          });
          const seg: string[] = [];
          if (r.added.length) seg.push(`已加入：${r.added.join("、")}`);
          if (r.removed.length) seg.push(`已关掉：${r.removed.join("、")}`);
          if (r.rejected.length) {
            seg.push(
              `**没关掉（底线词）**：${r.rejected.map((x) => `${x.term}（${x.why}）`).join("；")}——` +
                `这几个词涉及安全问题，代码里关不掉；孩子问到时会记入待补充清单，请如实告诉家长。`
            );
          }
          out.push(`风险词表：${seg.join("；") || "无变化"}`);
        }
        if (delKeys.length) {
          const d = deleteKbEntries(lib, delKeys);
          queueEmbed(d.ids); // 让 worker 发现"行没了"并把旁表向量删掉
          const seg: string[] = [];
          if (d.deleted.length) {
            seg.push(`已删掉 ${d.deleted.length} 条（**没法恢复**）：${d.deleted.map((t) => `「${t}」`).join("、")}`);
            seg.push(`如果孩子之前问过相关的事，她现在查不到了——她再问就会转成「去问爸爸妈妈」。`);
          }
          if (d.refused.length) {
            seg.push(
              `**没删**（现在还给孩子看着）：\n` +
                d.refused.map((x) => `- 「${x.title}」：${x.why}`).join("\n") +
                `\n要删就先撤回：parent_kb_publish({ entry_ids: [...], visibility: "parent" })，然后我立刻删。`
            );
          }
          if (d.missing.length) seg.push(`**没找到**：${d.missing.join("、")}——先用 parent_kb_list 核对标题或 id，别猜。`);
          out.push(`删除：${seg.join("\n") || "无变化"}`);
        }
        return ok(out.join("\n\n"));
      });
    },
  });

  const listTool = defineTool({
    name: "parent_kb_list",
    label: "看知识库 / 待补充 / 建议清单",
    description:
      "查看知识库里的条目、孩子问了但库里没有的问题、还不知道建什么的建议清单、以及高风险词表。\n\n" +
      "**何时调用**：家长问「我都存了什么」「她问过什么我还没回答的」「我该建哪些」，或你要核对某条是否已存在（`query` 按标题/别名/标签模糊找）。\n" +
      "**两个「列表」别混**：`parent_kb_list` 列的是**条目**（说法），`parent_list_materials` 列的是**文件**（资料真源）。\n\n" +
      "`view`：`entries`（缺省，条目清单，默认全部状态）· `gaps`（**孩子问了、库里没有命中**的问题；高风险在前、反复问的在前）·\n" +
      "`suggestions`（**家庭口径域**的建库建议清单，已建过的会标出来）· `risk`（高风险词表：底线词 + 家长可配的那些）。",
    parameters: Type.Object({
      view: Type.Optional(
        Type.Union([Type.Literal("entries"), Type.Literal("gaps"), Type.Literal("suggestions"), Type.Literal("risk")], {
          description: "entries（缺省）/ gaps / suggestions / risk",
        })
      ),
      status: Type.Optional(Type.String({ description: "entries 用：draft / published / archived；不传=全部" })),
      query: Type.Optional(Type.String({ description: "entries 用：按标题/别名/标签模糊找" })),
    }),
    execute: async (_id: string, params: { view?: string; status?: string; query?: string }) => {
      const view = String(params?.view ?? "entries").trim() || "entries";
      return withLib((lib) => {
        if (view === "gaps") {
          const rows = listKbGaps(lib, { status: "open", limit: 30 });
          if (!rows.length) return ok("没有待补充的问题：孩子问过的知识类问题都命中过库里的条目。");
          const lines = rows.map((r) => {
            let hits: Array<{ title?: string }> = [];
            try {
              hits = JSON.parse(r.hits_json || "[]") as Array<{ title?: string }>;
            } catch {
              /* 脏数据当没命中 */
            }
            const why = hits.length ? `当时命中了「${hits.map((h) => h.title).join("、")}」但没解决问题` : "库里完全没有";
            return `- ${r.high_risk ? "⚠️ 高风险｜" : ""}「${cut(r.question, 60)}」${r.count > 1 ? `（问了 ${r.count} 次）` : ""}｜${why}｜${(r.asked_at || "").slice(0, 10)}`;
          });
          return ok(
            `孩子问了、库里没接住的问题（${rows.length} 条，高风险与反复问的排在前面）：\n${lines.join("\n")}\n\n` +
              `**下一步**：挑几条问家长「这件事你想让她知道什么？」，整理后 parent_kb_save 存成条目（草稿）→ 确认 → 发布。`
          );
        }
        if (view === "suggestions") {
          const rows = listKbSuggestions(lib);
          const pending = rows.filter((r) => !r.exists);
          const domains = [...new Set(rows.map((r) => r.domain))];
          const body = domains
            .map((d) => `**${d}**：${rows.filter((r) => r.domain === d).map((r) => (r.exists ? `${r.title}（已建）` : r.title)).join("、")}`)
            .join("\n");
          return ok(
            `建库建议清单（**家庭口径域**——这些几乎都不是百科词条，而是只有你能定的话题；共 ${pending.length} 条还没建）：\n\n${body}\n\n` +
              `**别一次全建**：先挑 5~10 条**最想让她现在就知道的**，两条话就能存一条。冷启动要建的不是库，是习惯。`
          );
        }
        if (view === "risk") {
          const rows = listRiskTerms(lib);
          const floor = rows.filter((r) => r.floor);
          const conf = rows.filter((r) => !r.floor);
          return ok(
            `高风险词表（孩子问句里出现这些词 → 助手不给结论，只记入待补充清单）：\n\n` +
              `**底线词（关不掉）**：${floor.map((r) => r.term).join("、")}\n` +
              `**家长可配**：已启用 ${conf.filter((r) => r.enabled).map((r) => r.term).join("、") || "（无）"}\n` +
              `已关掉：${conf.filter((r) => !r.enabled).map((r) => r.term).join("、") || "（无）"}\n\n` +
              `要加词或关词，让家长说一句「以后她问到 XX 也先问我」，再用 parent_kb_save 的 risk_terms 参数加进去。`
          );
        }
        const rows = listKbEntries(lib, { status: params?.status, query: params?.query });
        const backfilled = queueEmbedMissing(lib); // P3：顺手把还没向量的条目补排队
        if (!rows.length) {
          return ok(
            "知识库还没有条目。可以：① 先说一条「以后她问 XX 就这么说」，我整理成条目；" +
              "② `parent_kb_list({view:\"suggestions\"})` 看建库建议清单。"
          );
        }
        const lines = rows.map(
          (r) =>
            `- [${STATUS_ZH[r.status] ?? r.status}｜${VIS_ZH[r.visibility] ?? r.visibility}｜${ORIGIN_ZH[r.origin] ?? r.origin}] ` +
            `${r.title}｜说法 ${r.summaryChars} 字｜资料 ${r.assetCount} 份` +
            (r.links ? `｜已挂课：${r.links}` : "") +
            `｜id=${r.id}`
        );
        return ok(
          `知识库条目（${rows.length} 条，最近改的在前）：\n${lines.join("\n")}\n\n` +
            `注：**只有「已发布 + 可以给她看」的条目孩子才查得到**；「草稿」是你还没确认过的，「先不给她看」是你确认过但暂时不给。\n` +
            `「已挂课」= 上那节课时助手会自动按这条讲（用 parent_kb_bind 挂的）；没挂的只有孩子问起才查得到。` +
            (backfilled ? `\n（顺手补建了 ${backfilled} 条条目的语义检索索引。）` : "")
        );
      });
    },
  });

  const publishTool = defineTool({
    name: "parent_kb_publish",
    label: "发布给孩子看 / 撤回",
    description:
      "把草稿条目**发布**成孩子能查到的（`visibility: \"child\"`），或**撤回**（`visibility: \"parent\"`）。\n\n" +
      "**撤回的准确含义**（别对家长说过头）：撤回之后**她再问就查不到了**；但如果她**这会儿正在聊的会话**里\n" +
      "已经听到过这句话，那句话还在对话历史里——系统会提醒助手每轮重新核对、核对不到就不再复述，\n" +
      "但**不能保证「她从此完全不知道」**。对孩子已经说出去的话收不回来，如实说。\n\n" +
      "**发布前必须先复述**：把要发布的条目**标题 + 那段话的要点**念给家长，得到**明确同意**再调；家长没点头就不许发布。\n" +
      "**撤回不需要确认**（越收越安全），家长说「这条先别给她看」直接调。\n\n" +
      "**参数**：`entry_ids` 可给**条目 id 或精确标题**（用 parent_kb_list 拿）；`visibility` 见上。\n" +
      "**发布不会检查内容对不对**——它只开门。内容对不对是家长确认那一步的事。",
    parameters: Type.Object({
      entry_ids: JsonArrayParam(Type.String(), "要发布 / 撤回的条目（id 或精确标题）"),
      visibility: Type.Union([Type.Literal("child"), Type.Literal("parent")], {
        description: "child=给孩子看（发布）/ parent=先不给她看（撤回）",
      }),
    }),
    execute: async (_id: string, params: { entry_ids?: unknown; visibility?: string }) => {
      const arg = coerceArrayArg(params?.entry_ids, "entry_ids");
      if (arg.error) throw new Error(arg.error);
      const visibility = String(params?.visibility ?? "").trim() === "child" ? "child" : "parent";
      return withLib((lib) => {
        const r = publishKbEntries(lib, arg.value.map((x) => String(x)), visibility);
        const seg: string[] = [];
        if (r.published.length) {
          seg.push(`已发布 ${r.published.length} 条，**孩子现在问到时就会按这些说**：${r.published.map((t) => `「${t}」`).join("、")}`);
          seg.push(`别忘了告诉家长：这件事以后她会听到的是「你定的说法」，不是你自己的了解。`);
        }
        if (r.withdrawn.length) seg.push(`已撤回 ${r.withdrawn.length} 条（孩子查不到了）：${r.withdrawn.map((t) => `「${t}」`).join("、")}`);
        if (r.refused.length) seg.push(`没发布（既没有说法也没有资料）：${r.refused.map((x) => `「${x.title}」`).join("、")}`);
        if (r.missing.length) seg.push(`**没找到**：${r.missing.join("、")}——先用 parent_kb_list 核对标题或 id，别猜。`);
        return ok(seg.join("\n") || "没有变化。");
      });
    },
  });

  const bindTool = defineTool({
    name: "parent_kb_bind",
    label: "把说法挂到某节课上",
    description:
      "把**已经发布给孩子看**的知识条目挂到某节课上——挂上以后，**一进这节课，助手手里就已经有这些说法**，" +
      "不用等孩子问、也不会漏掉。也可以摘下来（`action: \"unbind\"`）。\n\n" +
      "**何时调用**：家长说「这条讲夏朝的时候要用」「上第一课的时候提一下这个」「这条别挂在课上了」。\n\n" +
      "**三条硬规矩**（写在这里，也由代码强制）：\n" +
      "1. 课程**必须真实存在**——课程名要先从家长库里的课程确认，**不要凭印象写**；\n" +
      "2. 只有**已发布给孩子看**的条目能挂——**草稿不能挂**（没确认过的话不许进课堂）；\n" +
      "3. 标着「先不给她看」的条目也**不能挂**（挂上去就等于绕过了这道门）。\n\n" +
      "**为什么要发布才能挂**：挂上去的说法会在上课时**自动出现在助手面前**，孩子不用问就会听到。" +
      "这和「孩子问了才查得到」是两条路，前者更硬——所以门必须一样严。\n\n" +
      "**参数**：`entry_ids`（**id 或精确标题**，先用 `parent_kb_list` 拿）· `topic`（主题目录名或中文名都可以）· " +
      "`course`（课程名）· `action`（缺省 `bind` 挂上 / `unbind` 摘下）· `seq`（可选，挂上时的先后顺序，越小越先讲；缺省接在最后）。",
    parameters: Type.Object({
      entry_ids: JsonArrayParam(Type.String(), "要挂上 / 摘下的条目（id 或精确标题）"),
      topic: Type.String({ description: "主题（目录名如 preqin，或中文名）" }),
      course: Type.String({ description: "课程名，必须与家长库里的课程标题一致" }),
      action: Type.Optional(
        Type.Union([Type.Literal("bind"), Type.Literal("unbind")], { description: "bind（缺省，挂上）/ unbind（摘下）" })
      ),
      seq: Type.Optional(Type.Number({ description: "挂上时的顺序，越小越先讲；缺省接在最后" })),
    }),
    execute: async (
      _id: string,
      params: { entry_ids?: unknown; topic?: string; course?: string; action?: string; seq?: number }
    ) => {
      const arg = coerceArrayArg(params?.entry_ids, "entry_ids");
      if (arg.error) throw new Error(arg.error);
      const topicIn = String(params?.topic ?? "").trim();
      const course = String(params?.course ?? "").trim();
      if (!topicIn) throw new Error("parent_kb_bind 需要 topic（主题目录名或中文名）");
      if (!course) throw new Error("parent_kb_bind 需要 course（课程名）");
      const unbind = String(params?.action ?? "bind").trim() === "unbind";
      return withLib((lib) => {
        const topic = resolveTopicKey(lib, topicIn);
        const r = bindEntryToCourse(lib, arg.value.map((x) => String(x)), { topic, course, unbind, seq: params?.seq });
        const seg: string[] = [];
        if (r.bound.length) {
          seg.push(
            `已挂到「${course}」上：${r.bound.map((t) => `「${t}」`).join("、")}\n` +
              `上这节课时，助手会**自动**按这些说法讲，孩子不问也会听到。`
          );
        }
        if (r.unbound.length) seg.push(`已从「${course}」摘下来：${r.unbound.map((t) => `「${t}」`).join("、")}`);
        if (r.refused.length) {
          seg.push(
            `**没挂上**：\n` +
              r.refused.map((x) => `- 「${x.title}」：${x.why}`).join("\n") +
              `\n要挂的话：先把这条**发布给她看**（parent_kb_publish），再回来挂。`
          );
        }
        if (r.missing.length) seg.push(`**没找到**：${r.missing.join("、")}——先用 parent_kb_list 核对标题或 id，别猜。`);
        return ok(seg.join("\n\n") || "没有变化。");
      });
    },
  });

  return [saveTool, listTool, publishTool, bindTool];
}

/** 家长会话装配的知识库工具名（P1 三把 + P2 的 parent_kb_bind） */
export const PARENT_KB_TOOL_NAMES = ["parent_kb_save", "parent_kb_list", "parent_kb_publish", "parent_kb_bind"];

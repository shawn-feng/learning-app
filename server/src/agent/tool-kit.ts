/**
 * 工具参数「被模型序列化成字符串」的统一还原层（ISSUE-134，2026-09-23）。
 *
 * ## 问题
 * 某些模型（实测 `mimo-v2.5`）**无法表达 JSON Schema 的 `anyOf` 联合类型**——凡联合类型属性一律退化成
 * JSON 字符串（如 `rows: "[{\"status\":\"done\"}]"`；201 上 26/26 如此，而 `deepseek-v4-flash-0731` 0/20）；
 * 深层嵌套的大数组（`parent_upsert_course_content.items`）也会被整串序列化（实测 12/69）。
 *
 * 而 SDK 的参数校验（`pi-ai/dist/utils/validation.js` 的 `validateToolArguments`）只跑 TypeBox
 * `Value.Convert`（标量转换：`"20"→20`）+ `Compile().Check()`，**不会**把字符串 parse 回对象/数组，
 * 于是校验在**执行器之前**就硬失败，工具一次都没跑；失败报文还只有一句 schema 文案
 * （`rows: must be array / must be object / must match a schema in anyOf`）——模型拿不到可操作线索，
 * 于是在同一形态上反复重试（生产会话实测连败 22 次）。
 *
 * ## 解法
 * 用 SDK **官方预留的钩子** `prepareArguments`（`agent-loop.js:403` 在参数校验**之前**调用它，
 * `types.d.ts:346` 已公开为类型字段），在**校验前**把字符串还原成结构：
 * - 校验层拿到的是真结构 ⇒ 报错自然消失，**schema 一字不改**（不动发给 provider 的 schema / 描述 / 提示词体积）；
 * - 一处覆盖**全部工具**（含以后新增的），不必逐参数打补丁；
 * - `prepareArguments` 抛出的错误会被 `agent-loop.js:445` 转成**模型可见的 isError 结果** ⇒ 可读原因能传达给模型。
 *
 * **官方先例**：SDK 内置 `edit` 工具干的是同一件事（`core/tools/edit.js` 注释原话
 * 「Some models (Opus 4.6, GLM-5.1) send edits as a JSON string instead of an array」）。
 *
 * ## 护栏（防止误伤）
 * 1. **白名单式下沉**：只在 schema **明确声明** `object`/`array` 的节点做 `JSON.parse`；
 *    `additionalProperties`/`patternProperties` 值为 `{}`（`Type.Unknown()`，如 `where` 的值）视为
 *    unknown **不解析** ⇒ `answer` / `scoring` / `content` 这类「内容形如 JSON 的普通文本字段」
 *    **永不被改写**。
 * 2. **parse 后类型必须与 schema 期望吻合**，否则不采用（给可读原因，绝不猜）。
 * 3. **返回新对象**：模型原始输出仍如实落盘（会话 jsonl 里保留原始字符串形态，便于事后诊断），
 *    只有校验与执行看到还原后的结构。
 *
 * ## 与逐参数补丁的关系（三层保险，都保留）
 * ① 本文件（主路径：校验前还原）→ ② `tool-shapes.ts` 的 schema `string` 分支（万一某路径未走本层）
 * → ③ 执行器入口的 `JSON.parse`（`db-channel.ts`，直调执行器的脚本/测试也受益）。②③ 幂等、成本≈0。
 */
import { defineTool as sdkDefineTool } from "@earendil-works/pi-coding-agent";

/** 看起来像 JSON 结构（对象/数组）的字符串——只有这种才值得尝试解析 */
function looksLikeJson(s: string): boolean {
  const t = s.trim();
  return t.startsWith("{") || t.startsWith("[");
}

/** JSON 值的类型（只关心 object / array） */
function jsonKind(v: unknown): "object" | "array" | null {
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return "object";
  return null;
}

/**
 * schema 节点**明确期望**的类型。
 * 只认显式声明：`type: "object" | "array"`，或有 `properties` / `patternProperties` / `additionalProperties`
 * （对象）/ `items`（数组）。`{}`（`Type.Unknown()`）与 `{}` 型 `additionalProperties` 一律返回 null —— 不解析。
 */
function expectedKind(schema: any): "object" | "array" | null {
  if (!schema || typeof schema !== "object") return null;
  if (schema.type === "object") return "object";
  if (schema.type === "array") return "array";
  if (schema.properties || schema.patternProperties || schema.additionalProperties) return "object";
  if (schema.items) return "array";
  return null;
}

/** 值侧未声明类型时的兜底描述（错误文案用） */
const kindLabel = (k: "object" | "array" | null): string => (k === "object" ? "对象" : k === "array" ? "数组" : "值");

/** 把「期望 object/array 的节点」收到的字符串还原成结构；还原不了就抛可读原因（模型能看懂并改对）。 */
function coerceNode(schema: any, value: unknown, path: string): unknown {
  if (!schema || typeof schema !== "object") return value;

  // ① 联合类型（anyOf / oneOf，如 rows = [数组, 对象]）
  for (const key of ["anyOf", "oneOf"] as const) {
    const branches: any[] | undefined = schema[key];
    if (!Array.isArray(branches)) continue;

    // 1a 先看现有类型能否直接命中某个分支（真对象/真数组原样走高，零干扰）
    const actual = jsonKind(value);
    if (actual) {
      const hit = branches.find((b) => expectedKind(b) === actual);
      if (hit) return coerceNode(hit, value, path);
    }
    // 1b 字符串：试每个期望 object/array 的分支，parse 后类型吻合才采用
    if (typeof value === "string") {
      if (!looksLikeJson(value)) return value; // 普通文字原样交回（校验层会报错）
      let parsed: unknown;
      let parseOk = true;
      try {
        parsed = JSON.parse(value);
      } catch {
        parseOk = false;
      }
      if (!parseOk) {
        throw new Error(
          `${path} 收到的是文字但不是合法 JSON（${value.slice(0, 80)}${value.length > 80 ? "…" : ""}）。` +
            "请把它**直接**作为参数结构传入，不要传 JSON 序列化后的字符串。"
        );
      }
      const got = jsonKind(parsed);
      const hit = got ? branches.find((b) => expectedKind(b) === got) : undefined;
      if (hit) return coerceNode(hit, parsed, path);
      return value; // 类型不吻合 → 交回校验层（不猜）
    }
    return value; // 非对象/数组/字符串 → 原样
  }

  const want = expectedKind(schema);

  // ② 期望 object
  if (want === "object") {
    let v = value;
    if (typeof v === "string") {
      const text = v;
      if (!looksLikeJson(text)) return text;
      let parsed: unknown;
      let parseOk = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseOk = false;
      }
      if (!parseOk) {
        throw new Error(
          `${path} 收到的是文字但不是合法 JSON（${text.slice(0, 80)}${text.length > 80 ? "…" : ""}）。` +
            "请把它**直接**作为参数结构传入，不要传 JSON 序列化后的字符串。"
        );
      }
      if (jsonKind(parsed) !== "object") {
        throw new Error(`${path} 应为「{列: 值} 对象」，解析后却是${kindLabel(jsonKind(parsed))}。请直接传对象。`);
      }
      v = parsed;
    }
    if (jsonKind(v) !== "object") return value;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = { ...src };
    const declared = (schema.properties ?? {}) as Record<string, any>;
    for (const [k, sub] of Object.entries(declared)) {
      if (k in out) out[k] = coerceNode(sub, out[k], `${path}.${k}`);
    }
    // 未声明键：patternProperties（如 Type.Record）或 additionalProperties 声明的 schema；
    // 值为 {} （Type.Unknown()）时 expectedKind 返回 null → 原样不动（关键护栏）
    const extra = schema.patternProperties
      ? Object.values(schema.patternProperties as Record<string, any>)[0]
      : schema.additionalProperties;
    if (extra && typeof extra === "object") {
      for (const k of Object.keys(out)) {
        if (k in declared) continue;
        out[k] = coerceNode(extra, out[k], `${path}.${k}`);
      }
    }
    return out;
  }

  // ③ 期望 array
  if (want === "array") {
    let v = value;
    if (typeof v === "string") {
      const text = v;
      if (!looksLikeJson(text)) return text;
      let parsed: unknown;
      let parseOk = true;
      try {
        parsed = JSON.parse(text);
      } catch {
        parseOk = false;
      }
      if (!parseOk) {
        throw new Error(
          `${path} 收到的是文字但不是合法 JSON（${text.slice(0, 80)}${text.length > 80 ? "…" : ""}）。` +
            "请把它**直接**作为参数结构传入，不要传 JSON 序列化后的字符串。"
        );
      }
      if (jsonKind(parsed) !== "array") {
        throw new Error(`${path} 应为数组，解析后却是${kindLabel(jsonKind(parsed))}。请直接传数组。`);
      }
      v = parsed;
    }
    if (jsonKind(v) !== "array") return value;
    const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
    if (!items) return v;
    return (v as unknown[]).map((el, i) => coerceNode(items, el, `${path}[${i}]`));
  }

  // ④ 其它类型（string / number / boolean / enum / const / unknown）→ 原样，绝不 parse
  return value;
}

/**
 * 还原工具参数：把被模型写成 JSON 字符串的复合参数解析回结构。
 * 只在 schema 明确期望 object/array 的位置动手；其余一律原样。
 * 还原不了时抛错——会被 SDK 转成模型可见的 isError 工具结果（可读中文原因）。
 */
export function coerceToolArgs(parameters: unknown, args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  const props = ((parameters as any)?.properties ?? {}) as Record<string, any>;
  for (const [k, sub] of Object.entries(props)) {
    if (k in out) out[k] = coerceNode(sub, out[k], k);
  }
  return out;
}

/** 内部实现：注入 prepareArguments（无类型签名，类型由下方 `as typeof sdkDefineTool` 提供） */
function withPrepareArguments(tool: any): any {
  // 工具自带 prepareArguments 时（SDK 内置工具如 edit 就有）先跑它，再跑我们的还原，避免覆盖别人的兼容逻辑
  const own = typeof tool?.prepareArguments === "function" ? (tool.prepareArguments as (a: unknown) => unknown) : undefined;
  return sdkDefineTool({
    ...tool,
    prepareArguments: (raw: unknown) => coerceToolArgs(tool?.parameters, own ? own(raw) : raw),
  });
}

/**
 * 与 SDK `defineTool` **同签名**的包装器：在原工具上注入 `prepareArguments`（校验前还原参数）。
 * 切换方式只有一处——把 `import { defineTool } from "@earendil-works/pi-coding-agent"`
 * 改成 `import { defineTool } from "./tool-kit.js"`（worker 目录用 `../agent/tool-kit.js`）。
 *
 * 类型说明：声明成 SDK 原函数的类型，调用点的泛型推断与原来完全一致（14 个文件只需改 import 一行）；
 * 内部实现走 `any`，避免踩「SDK 自带一份 typebox、服务端另有一份」导致 `Static<TParams>` 跨包不同源的类型噪音。
 *
 * 注：若将来 SDK 提供官方的「参数自动解码」开关，只需改本文件一处。
 */
export const defineTool = withPrepareArguments as typeof sdkDefineTool;

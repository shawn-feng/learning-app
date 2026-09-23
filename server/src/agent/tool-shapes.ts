/**
 * 工具参数的「兼容形状」构造器（ISSUE-133，2026-09-22）。
 *
 * 背景：`rows` / `where` / `columns` 这类自由对象/数组参数，模型偶尔会**把整个参数序列化成一个
 * JSON 字符串**再传（现场：`rows: "[{\"status\":\"done\"}]"`）。SDK 的参数校验
 * （`pi-ai/dist/utils/validation.js`）只用 TypeBox `Value.Convert` 做标量转换，**不会**把字符串
 * 解析回对象/数组，于是三条 anyOf 分支一起报错（"rows: must be array / must be object /
 * must match a schema in anyOf"），校验失败发生在执行器之前 → 模型只看到一句 schema 报错，
 * 既拿不到自愈提示也不能重试成功。
 *
 * 因此工具 schema 显式**放行 string 分支**（校验通过），由执行器入口 `parseJsonArg` /
 * `coerceObjectArg` / `coerceColumnsArg`（db-channel.ts）把字符串 parse 回结构；
 * parse 不了回可读中文原因，绝不静默。描述里同时明确「优先直接传结构」。
 */
import { Type, type TSchema } from "typebox";

/** {列: 值} 对象参数：真实对象，或被整串 JSON 序列化的字符串 */
export function JsonObjectParam(desc: string) {
  return Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.String()], {
    description: `${desc}；请**直接传 {列: 值} 对象**（不要传 JSON 序列化后的字符串）`,
  });
}

/** 数组类参数（元素类型任意）：真实数组，或被整串 JSON 序列化的字符串 */
export function JsonArrayParam<T extends TSchema>(item: T, desc: string) {
  return Type.Union([Type.Array(item), Type.String()], {
    description: `${desc}；请**直接传数组**（不要传 JSON 序列化后的字符串）`,
  });
}

/** 字符串数组参数：真实数组，或被整串 JSON 序列化的字符串 */
export function JsonStringArrayParam(desc: string) {
  return Type.Union([Type.Array(Type.String()), Type.String()], {
    description: `${desc}；请**直接传字符串数组**（不要传 JSON 序列化后的字符串）`,
  });
}

/** 写侧 rows：行数组 / 列值对象，或被整串 JSON 序列化的字符串 */
export function WriteRowsParam(desc: string) {
  return Type.Union(
    [Type.Array(Type.Record(Type.String(), Type.Unknown())), Type.Record(Type.String(), Type.Unknown()), Type.String()],
    {
      description: `${desc}；请**直接传结构**（对象/数组），不要传 JSON 序列化后的字符串`,
    }
  );
}

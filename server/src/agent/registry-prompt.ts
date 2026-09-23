/**
 * F7/C3：注册表 → 模型可见元数据（紧凑实体/列/关系/路径清单），常驻 system prompt。
 * 目标：读场景零 describe——agent 首次调用前就知道有哪些表、哪些列、能走哪条路径。
 *
 * 口径说明：设计稿 §6.2 的「≈1861 token」基于 F14 补列前的残缺注册表；列补齐后实际体积以
 * 本模块的输出实测为准（验收时回填文档）。Tier 2 namespace 在会话启动时一并并入（一行一个），
 * 使 C3 对两层统一成立——describe 退化为写校验/枚举值域的专项出口（§6.3 收窄后定位）。
 */
import { openParentLib } from "../db/parent-lib.js";
import {
  parentLibTableRegistry,
  parentReadableRegistry,
  parentLibPaths,
  childKbReadableRegistry,
  childKbWritableRegistry,
  childKbAdminWriteSpecs,
  applyPathIndex,
  type ReadableTableSpec,
  type TableSpec,
  type RegistryPath,
} from "./db-channel.js";
import { loadNamespaces, tier2AsReadable, type NamespaceRow } from "./tier2.js";
import { listMistakes } from "../db/mistakes.js";

/** 紧凑表清单：一行一表，列名平铺；refs 以 列→表.列 标注（模型靠它理解关系，不用查） */
function compactTableLines(readSpecs: ReadableTableSpec[]): string[] {
  return readSpecs.map((s) => {
    const refByCol = new Map<string, string[]>();
    for (const r of s.refs ?? []) {
      const arr = refByCol.get(r.column) ?? [];
      arr.push(`${r.column}→${r.refTable}.${r.refColumn}`);
      refByCol.set(r.column, arr);
    }
    const refNotes = [...refByCol.values()].flat();
    const cols = Object.keys(s.columns).join(", ");
    return `- ${s.table}（${s.label}）: ${cols}${refNotes.length ? ` ｜关系: ${refNotes.join(", ")}` : ""}`;
  });
}

function compactWriteLines(writeSpecs: TableSpec[]): string[] {
  return writeSpecs
    .filter((s) => s.ops.length)
    .map((s) => `- ${s.table}: ${s.ops.join("/")}（单次≤${s.rowLimit} 行）`);
}

function compactPathLines(paths: RegistryPath[]): string[] {
  return paths.map(
    (p) => `- ${p.name}（${p.label}）: 主体 ${p.select}；可过滤 ${p.filterable.join(" | ")}；可返回 ${p.returns.length} 列（describe path 可见全部）`
  );
}

function compactNsLines(nsRows: NamespaceRow[]): string[] {
  return nsRows.map((ns) => {
    const refs = (ns.spec.refs ?? []).map((r) => `${r.column}→${r.refTable}.${r.refColumn}`).join(", ");
    return `- ns:${ns.ns}（${ns.label}）: ${Object.keys(ns.spec.columns).join(", ")}${refs ? ` ｜关系: ${refs}` : ""}`;
  });
}

export interface DataChannelBlocks {
  /** 家长库：Tier 1 表 + 命名路径 + Tier 2(parent scope) */
  parentBlock: string;
  /** 孩子库：Tier 1 表 + Tier 2(child scope)（写面仅 daily_entries/redemption_requests） */
  childBlock: string;
}

/** 组装两库的紧凑元数据（会话创建时调用一次；ns 注册行来自家长库 namespaces 表） */
export function buildDataChannelBlocks(dataDir: string, parentId: string): DataChannelBlocks {
  let parentNs: NamespaceRow[] = [];
  let childNs: NamespaceRow[] = [];
  try {
    const pdb = openParentLib(dataDir, parentId);
    try {
      parentNs = loadNamespaces(pdb, "parent");
      childNs = loadNamespaces(pdb, "child");
    } finally {
      pdb.close();
    }
  } catch {
    /* 家长库打不开（极端情况）→ 退化为纯 Tier 1 清单 */
  }

  const parentPaths = parentLibPaths();
  const parentRead = applyPathIndex(parentReadableRegistry(), parentPaths);
  const parentBlock = [
    "【家长库可读表】",
    ...compactTableLines(parentRead),
    "【家长库可写表】",
    ...compactWriteLines(parentLibTableRegistry()),
    ...(parentNs.length ? ["【家长库灵活实体 Tier 2】（table 用 ns:名称）", ...compactNsLines(parentNs)] : []),
    "【命名路径】（parent_db_read 传 path=名称，多跳关联一次查询）",
    ...compactPathLines(parentPaths),
  ].join("\n");

  const childNsRows = childNs;
  const childRead = applyPathIndex(childKbReadableRegistry(), []);
  const childBlock = [
    "【孩子库可读表】",
    ...compactTableLines(childRead),
    // ISSUE-105 修订（2026-09-21）：家长 db 通道按管理口径开放孩子库全部登记表（孩子 agent 自己的写面仍走两表白名单）
    "【孩子库可写表】（管理口径全表可写；状态机表 study_plans/exam_plans/points_ledger 等直写绕过受控流程，改前先 read 确认目标行）",
    ...compactWriteLines(childKbAdminWriteSpecs()),
    ...(childNsRows.length ? ["【孩子库灵活实体 Tier 2】（只读；table 用 ns:名称）", ...compactNsLines(childNsRows)] : []),
  ].join("\n");

  return { parentBlock, childBlock };
}

/** 孩子 agent 自己视角的元数据块（只含自己的库 + 自己的写面 + 错题本摘要）。
 *  childId 传入时附带 open 状态错题摘要（ISSUE-114 复习触达：AI 老师在对话里自然掺入）。 */
export function buildChildSelfBlock(dataDir: string, parentId: string, childId?: string): string {
  let childNs: NamespaceRow[] = [];
  try {
    const pdb = openParentLib(dataDir, parentId);
    try {
      childNs = loadNamespaces(pdb, "child");
    } finally {
      pdb.close();
    }
  } catch {
    /* 同上 */
  }
  let mistakeLines: string[] = [];
  if (childId) {
    try {
      const rows = listMistakes(dataDir, parentId, childId, { status: "open", limit: 8 });
      const KIND_ZH: Record<string, string> = { wrong_question: "错题", unknown_word: "生字词", weak_point: "薄弱点" };
      mistakeLines = rows.map((r) => {
        const day = String(r.last_seen).slice(5, 10);
        return `- [${KIND_ZH[r.kind] ?? r.kind}] ${r.content}${r.count > 1 ? `（${r.count} 次，最近 ${day}）` : `（${day}）`}`;
      });
    } catch {
      /* 读不到不阻塞 prompt 组装 */
    }
  }
  return [
    "【我的数据表】",
    ...compactTableLines(childKbReadableRegistry()),
    "【我可写的表】",
    ...compactWriteLines(childKbWritableRegistry()),
    ...(childNs.length ? ["【灵活实体 Tier 2】（只读；table 用 ns:名称）", ...compactNsLines(childNs)] : []),
    ...(mistakeLines.length
      ? [
          "【错题本 · 待复习】（教学时在合适课时自然掺入复习；孩子说会了先小题验证再 child_mistake_log action=master）",
          ...mistakeLines,
        ]
      : []),
  ].join("\n");
}

import fs from "fs";
import path from "path";
import { getDataDir } from "./config";

/**
 * 考核 AI 会话审计（2026-09-08）。
 *
 * 考核流程里的选课 / 出题 / 判分都是一次性内存会话、用完即弃（SessionManager.inMemory），
 * 不落盘、不留痕——不利于开发分析（复盘选课为何选错、出题内容/格式/背诵题问题、模型输出质量、
 * 每次调用的耗时与错误等）。本模块把这些环节的「输入 prompt + 模型原文回复 + 解析结果 +
 * 耗时 + 错误」追加记录到客户端数据目录，便于事后对照分析。
 *
 * 存放：{dataDir}/exam-audit/{childId}/{YYYYMMDD}.jsonl
 *   每行一个 JSON 事件（append，进程崩溃也不丢已写部分）。
 * 审计失败不影响考核主流程（写盘异常只 console.error）。
 */
export function auditExamEvent(
  childId: string,
  phase: "select" | "generate" | "score",
  payload: Record<string, unknown>
): void {
  try {
    const dataDir = getDataDir();
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = path.join(dataDir, "exam-audit", childId || "unknown");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), phase, ...payload });
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), line + "\n");
  } catch (e) {
    console.error("[exam-audit] 写入失败（不影响考核）:", e);
  }
}

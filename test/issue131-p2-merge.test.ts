/**
 * ISSUE-131 P2 物理归并回归组：materials/uploads 物理并入 workspaces/<pid>/ 后，全链路不断链。
 *
 * 守住（对应 issue 回归清单）：
 * - R-2/R-9 存量附件引用：files 表旧行（旧根 files/<pid>/<stored>）、裸 uuid、
 *   `parents/<pid>/uploads/…` 本机路径引用全部可解析；新根引用（workspaces/<pid>/uploads）也可解析；
 * - R-3 display 三源：存量旧根 materials 路径、新根 materials 路径、孩子 outputs 都能展示（source 兼容前端）；
 * - R-5 考核录音：audio_fileId 指向旧根物理文件可解析（resolveStoredFileAbs）；
 * - R-6 沙箱越权：孩子 agent fs 工具摸 ../materials、../uploads、兄弟目录必须被拒（规则 7 显式断言）；
 * - R-10 索引摘除：listMaterialsMeta 现场双根 walk（合新+旧、跳运行时目录）、diffMaterialIndex 行为等价。
 */
import { describe, expect, it, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { openDb } from "../server/src/db";
import { listMaterialsMeta, diffMaterialIndex } from "../server/src/db/materials";
import { resolveStoredFileAbs } from "../server/src/routes/files";
import { resolveAttachmentRef } from "../server/src/agent/upload-ref";
import { createDisplayContentTool } from "../server/src/agent/display-tool";
import { createServerFsTools } from "../server/src/agent/fs-tools";
import { createCorePaths } from "@pi/agent-core";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "issue131p2-"));
const PID = "p131p2";
const CID = "c131p2";
const db = openDb(dataDir);
const now = new Date().toISOString();

db.prepare("INSERT INTO parents (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)").run(PID, "p131p2@test", now, now);
db.prepare("INSERT INTO children (id, parent_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(CID, PID, "娃", now, now);

const paths = createCorePaths(dataDir);
const NEW_MAT = paths.agentRoot(PID) + path.sep + "materials"; // workspaces/<pid>/materials
const LEGACY_MAT = path.join(dataDir, "materials", PID);
const LEGACY_FILES = path.join(dataDir, "files", PID);

function writeRel(rel: string, content: string): string {
  const abs = path.join(dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return abs;
}

afterAll(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("ISSUE-131 P2 R-2/R-9 存量附件引用解析", () => {
  it("files 表旧行（物理在旧根 files/<pid>）→ 裸 uuid 与 files/<id> 均可解析", () => {
    const stored = "legacy-abc.mp3";
    writeRel(path.join("files", PID, stored), "old-audio");
    db.prepare(
      "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, NULL, ?, ?, ?, 9, ?)"
    ).run("dbc47041-4ee5-4180-af12-b74649cf971f", PID, "旧录音.mp3", stored, "audio/mpeg", now);

    const ctx = { db, dataDir, parentId: PID };
    const byUuid = resolveAttachmentRef(ctx, "dbc47041-4ee5-4180-af12-b74649cf971f");
    expect(byUuid.abs).toBe(path.join(LEGACY_FILES, stored));
    expect(byUuid.fileName).toBe("旧录音.mp3");
    const byPrefixed = resolveAttachmentRef(ctx, `files/dbc47041-4ee5-4180-af12-b74649cf971f`);
    expect(byPrefixed.abs).toBe(path.join(LEGACY_FILES, stored));
  });

  it("新根物理文件（workspaces/<pid>/uploads/<stored>）同样可解析；R-5 考核录音 resolver 新根优先", () => {
    const stored = "new-abc.mp3";
    const newAbs = writeRel(path.join("workspaces", PID, CID, "uploads", stored), "new-audio");
    db.prepare(
      "INSERT INTO files (id, parent_id, child_id, original_name, stored_path, mime, size, created_at) VALUES (?, ?, ?, ?, ?, ?, 9, ?)"
    ).run("a5d26ce4-83a7-48f7-8a12-1f9fd7fd5810", PID, CID, "新录音.mp3", stored, "audio/mpeg", now);

    const ctx = { db, dataDir, parentId: PID };
    expect(resolveAttachmentRef(ctx, "a5d26ce4-83a7-48f7-8a12-1f9fd7fd5810").abs).toBe(newAbs);
    // R-5：speech_assessments.audio_file_id 走同一 resolver
    expect(resolveStoredFileAbs(dataDir, PID, CID, stored)).toBe(newAbs);
    // 旧根兜底仍在
    expect(resolveStoredFileAbs(dataDir, PID, null, "legacy-abc.mp3")).toBe(path.join(LEGACY_FILES, "legacy-abc.mp3"));
  });

  it("parents/<pid>/uploads/<name> 本机路径引用 → 旧位置兜底；uploads/<name> → 新根兜底", () => {
    writeRel(path.join("parents", PID, "uploads", "微信图片_x.jpg"), "img");
    writeRel(path.join("workspaces", PID, "uploads", "作业.txt"), "hw");
    const ctx = { db, dataDir, parentId: PID };
    expect(resolveAttachmentRef(ctx, `parents/${PID}/uploads/微信图片_x.jpg`).abs).toBe(
      path.join(dataDir, "parents", PID, "uploads", "微信图片_x.jpg")
    );
    expect(resolveAttachmentRef(ctx, "uploads/作业.txt").abs).toBe(newAbsOf("uploads", "作业.txt"));
  });

  function newAbsOf(...segs: string[]): string {
    return path.join(dataDir, "workspaces", PID, ...segs);
  }
});

describe("ISSUE-131 P2 R-3 display 三源", () => {
  const tool = createDisplayContentTool({
    dataDir,
    parentId: PID,
    childId: CID,
    streamKey: "test-stream",
    sessionKey: "main",
  });

  async function display(rawPath: string): Promise<{ source: string }> {
    const r = (await tool.execute("t1", { path: rawPath, title: "x" }, undefined, undefined, {})) as unknown as {
      content: Array<{ text: string }>;
    };
    expect(r.content[0].text).toContain("已展示资料");
    return { source: "ok" };
  }

  it("存量旧根 materials 路径可展示", async () => {
    writeRel(path.join("materials", PID, "lunyu", "old.html"), "<p>old</p>");
    await display("lunyu/old.html");
    await display("materials/lunyu/old.html");
  });

  it("新根 materials 路径可展示", async () => {
    writeRel(path.join("workspaces", PID, "materials", "english", "new.html"), "<p>new</p>");
    await display("english/new.html");
  });

  it("孩子 outputs 可展示；不存在的资料报错", async () => {
    writeRel(path.join("workspaces", PID, CID, "outputs", "game.html"), "<p>game</p>");
    await display("outputs/game.html");
    await expect(display("lunyu/nope.html")).rejects.toThrow(/资料不存在/);
  });
});

describe("ISSUE-131 P2 R-6 孩子 agent 沙箱越权（规则 7 显式断言）", () => {
  const childRoot = paths.childWorkspaceDir(PID, CID);
  const tools = createServerFsTools(childRoot);
  const byName = new Map(tools.map((t) => [t.name, t] as const));

  it("孩子 fs 工具根恒为 workspaces/<pid>/<cid>（不变）", () => {
    expect(childRoot).toBe(path.join(dataDir, "workspaces", PID, CID));
  });

  it("摸 ../materials、../uploads、兄弟目录一律被拒", async () => {
    const write = byName.get("write")!;
    await expect(
      (write as any).execute("t", { path: "../materials/hack.html", content: "x" }, undefined, undefined, {})
    ).rejects.toThrow(/越界|越出|非法/);
    await expect(
      (write as any).execute("t", { path: "../uploads/hack.bin", content: "x" }, undefined, undefined, {})
    ).rejects.toThrow();
    await expect(
      (write as any).execute("t", { path: "../c-other/outputs/x.html", content: "x" }, undefined, undefined, {})
    ).rejects.toThrow();
    const read = byName.get("read")!;
    await expect(
      (read as any).execute("t", { path: "../../parents/x/parent.sqlite" }, undefined, undefined, {})
    ).rejects.toThrow();
  });
});

describe("ISSUE-131 P2 R-10 索引摘除后 walk 等价", () => {
  it("listMaterialsMeta 双根合并（新根覆盖同名）、跳过 .pi 运行时目录", () => {
    writeRel(path.join("materials", PID, "topic-a", "legacy.html"), "<p>l</p>");
    writeRel(path.join("workspaces", PID, "materials", "topic-b", "new.html"), "<p>n</p>");
    writeRel(path.join("workspaces", PID, "materials", "topic-a", "legacy.html"), "<p>n-root-wins</p>");
    writeRel(path.join("workspaces", PID, "materials", ".pi", "agent", "state.json"), "{}");

    const metas = listMaterialsMeta(dataDir, PID);
    const pathsList = metas.map((m) => m.path);
    expect(pathsList).toContain("topic-a/legacy.html");
    expect(pathsList).toContain("topic-b/new.html");
    expect(pathsList).not.toContain(".pi/agent/state.json");
    // 新根覆盖旧根同名（size 以新根为准）
    const a = metas.find((m) => m.path === "topic-a/legacy.html")!;
    expect(a.size).toBe("<p>n-root-wins</p>".length);
  });

  it("diffMaterialIndex：updates=变更条目、removed=双根都不存在的 id", () => {
    const metas = listMaterialsMeta(dataDir, PID);
    const known = new Map(metas.map((m) => [m.id, m.updated_at] as const));
    // 完全一致 → 无 updates
    expect(diffMaterialIndex(dataDir, PID, Object.fromEntries(known)).updates).toHaveLength(0);
    // 旧时间戳 → 该条进 updates；幽灵 id → removed
    const staleId = metas[0]!.id;
    const r = diffMaterialIndex(dataDir, PID, { [staleId]: "2000-01-01T00:00:00.000Z", ghost: "x" });
    expect(r.updates.map((u) => u.id)).toContain(staleId);
    expect(r.removed).toContain("ghost");
  });
});

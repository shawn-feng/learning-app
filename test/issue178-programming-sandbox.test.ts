/**
 * ISSUE-178 回归：①transferUploadMaterial（uploads→<topic>/media 二进制转存，原名回填/不覆盖/沙箱）；
 * ②probeRequirementPaths（需求路径预检：存在✓/不存在✗+同目录实际文件名；base 外路径忽略）。
 */
import { describe, expect, it, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { transferUploadMaterial } from "../server/src/agent/parent-materials";
import { probeRequirementPaths } from "../server/src/agent/programming-agent";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issue178-"));
const PID = "p178";

function makeCtx(): { ctx: any; wsRoot: string; matRoot: string } {
  const ctx = {
    db: new DatabaseSync(":memory:"),
    dataDir: dir,
    parentId: PID,
  };
  ctx.db.exec("CREATE TABLE files (id TEXT PRIMARY KEY, parent_id TEXT, original_name TEXT, stored_path TEXT)");
  return { ctx, wsRoot: path.join(dir, "workspaces", PID), matRoot: path.join(dir, "workspaces", PID, "materials") };
}

beforeAll(() => {
  fs.mkdirSync(path.join(dir, "workspaces", PID, "uploads"), { recursive: true });
});

describe("ISSUE-178 transferUploadMaterial", () => {
  it("uploads→<topic>/media 二进制转存：原名回填（files 表）、bytes 一致、uploads 原件保留", () => {
    const { ctx, wsRoot, matRoot } = makeCtx();
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x01]); // 非 utf-8 安全
    fs.writeFileSync(path.join(wsRoot, "uploads", "8f55.jpg"), bin);
    ctx.db
      .prepare("INSERT INTO files (id, parent_id, original_name, stored_path) VALUES (?,?,?,?)")
      .run("f1", PID, "作业照片.png", "8f55.jpg");

    const r = transferUploadMaterial(ctx, { uploadPath: "uploads/8f55.jpg", toTopic: "schoolwork" });
    expect(r.to).toBe("schoolwork/media/作业照片.png");
    expect(r.originalName).toBe("作业照片.png");
    expect(fs.readFileSync(path.join(matRoot, "schoolwork", "media", "作业照片.png"))).toEqual(bin);
    expect(fs.existsSync(path.join(wsRoot, "uploads", "8f55.jpg"))).toBe(true); // 原件保留
  });

  it("toName 缺省=落盘名（files 表无行）；目标已存在拒绝覆盖；路径穿越拒绝", () => {
    const { ctx, wsRoot, matRoot } = makeCtx();
    fs.writeFileSync(path.join(wsRoot, "uploads", "a1.png"), "x");
    const r = transferUploadMaterial(ctx, { uploadPath: "uploads/a1.png", toTopic: "t1" });
    expect(r.to).toBe("t1/media/a1.png");
    expect(fs.existsSync(path.join(matRoot, "t1", "media", "a1.png"))).toBe(true);

    expect(() => transferUploadMaterial(ctx, { uploadPath: "uploads/a1.png", toTopic: "t1" })).toThrow(/目标已存在/);
    expect(() =>
      transferUploadMaterial(ctx, { uploadPath: "uploads/../../secret.txt", toTopic: "t1" })
    ).toThrow(/没有找到|不允许/);
    expect(() =>
      transferUploadMaterial(ctx, { uploadPath: "uploads/a1.png", toTopic: "t1", toName: "../x.png" })
    ).toThrow(/toName/);
  });
});

describe("ISSUE-178 probeRequirementPaths", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "issue178-probe-"));
  beforeAll(() => {
    fs.mkdirSync(path.join(base, "schoolwork", "media"), { recursive: true });
    fs.writeFileSync(path.join(base, "schoolwork", "media", "real.png"), "x");
    fs.writeFileSync(path.join(base, "schoolwork", "media", "另一张.jpg"), "y");
  });

  it("存在的路径标 ✓；不存在的标 ✗ 并列出同目录实际文件名（扩展名猜错的解药）", () => {
    const out = probeRequirementPaths(
      base,
      "请把 schoolwork/media/real.png 和 schoolwork/media/书写格式示例.jpg 做成页面"
    );
    expect(out).toContain("✓ schoolwork/media/real.png");
    expect(out).toContain("✗ schoolwork/media/书写格式示例.jpg");
    expect(out).toContain("real.png"); // 同目录实际文件名提示
  });

  it("无路径提及 → 空串（prompt 不附加）；uploads/ 前缀猜错 → ✗ 明示不存在（201 盲猜形态解药）", () => {
    expect(probeRequirementPaths(base, "做一个九九乘法表页面，无图片")).toBe("");
    const out = probeRequirementPaths(base, "引用 uploads/abc.png 与 schoolwork/media/real.png");
    // uploads/ 在 materials 基座内可解析但不存在 → 明确 ✗，模型不用 ENOENT 试错
    expect(out).toContain("✗ uploads/abc.png");
    expect(out).toContain("✓ schoolwork/media/real.png");
  });
});

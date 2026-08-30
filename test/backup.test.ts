import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// ISSUE-003：备份改为「服务端数据 zip」——createBackup 从服务端拉 zip 存本地，
// restoreBackup 把本地 zip 上传给服务端覆盖（服务端恢复前自动备份）。全部走 server 调用，mock 掉网络层。
vi.mock("../electron/lib/server-client.ts", () => ({
  ServerError: class ServerError extends Error {
    constructor(public status: number, message: string) {
      super(message);
    }
  },
  serverFetchBinary: vi.fn(),
  serverUploadFile: vi.fn(),
  serverBase: () => "http://mock-server",
}));

vi.mock("../electron/lib/auth-manager.ts", () => ({
  getCachedLicense: () => ({ token: "mock-token" }),
}));

import { serverFetchBinary, serverUploadFile } from "../electron/lib/server-client.ts";
import { createBackup, restoreBackup } from "../electron/lib/backup.ts";

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pi-backup-test-"));
const DEST_DIR = path.join(TEST_DIR, "dest");

/** 构造一个与服务端备份同构的 zip（manifest + parent.sqlite + kb/<cid>.sqlite）。 */
function fakeServerZip(): Buffer {
  // 手动构造最小 zip 成本高，这里用「伪 zip」：createBackup 不解析 zip 内容，只保存并尝试读 manifest 计数。
  const manifest = JSON.stringify({
    tool: "学习伙伴数据备份（服务端用户数据）",
    fileCount: 3,
    note: "仅含家长库与孩子学习库；不含账号、模型 API key、登录凭证、材料大文件。",
  });
  return Buffer.from(`PK-MOCK-${manifest}`);
}

beforeAll(() => {
  // 真实 zip（服务端 produce 的格式）由 server 端测试覆盖；这里验证客户端行为
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("createBackup（服务端 → 本地 zip）", () => {
  it("从服务端拉取 zip 保存到 destDir，返回文件名/计数/字节数", async () => {
    const zip = fakeServerZip();
    vi.mocked(serverFetchBinary).mockResolvedValue(zip as never);

    const r = await createBackup(DEST_DIR);
    expect(serverFetchBinary).toHaveBeenCalledWith("/backup", { token: "mock-token" });
    expect(fs.existsSync(r.file)).toBe(true);
    expect(r.file).toMatch(/backup-\d{8}-\d{6}\.zip$/);
    expect(r.bytes).toBe(zip.length);
    // 计数从 manifest 的 fileCount 解析
    expect(r.count).toBe(3);
    expect(fs.readFileSync(r.file).equals(zip)).toBe(true);
  });

  it("服务端不可达时抛错（不落盘半成品）", async () => {
    vi.mocked(serverFetchBinary).mockRejectedValue(new Error("无法连接服务端") as never);
    await expect(createBackup(DEST_DIR)).rejects.toThrow("无法连接服务端");
  });
});

describe("restoreBackup（本地 zip → 服务端覆盖）", () => {
  it("上传 zip，透传 restored/skipped/preRestore", async () => {
    vi.mocked(serverUploadFile).mockResolvedValue({
      ok: true,
      restored: 2,
      skipped: ["kb/other.sqlite"],
      preRestore: "pre-restore-20260830-100000.zip",
    } as never);

    const zipPath = path.join(TEST_DIR, "upload.zip");
    fs.writeFileSync(zipPath, fakeServerZip());

    const r = await restoreBackup(zipPath);
    expect(serverUploadFile).toHaveBeenCalledWith("/backup/restore", zipPath, "mock-token");
    expect(r.restored).toBe(2);
    expect(r.skipped).toContain("kb/other.sqlite");
    expect(r.preRestore).toContain("pre-restore-");
  });

  it("服务端返回失败时抛错", async () => {
    vi.mocked(serverUploadFile).mockResolvedValue({ ok: false, error: "备份文件无效" } as never);
    const zipPath = path.join(TEST_DIR, "bad.zip");
    fs.writeFileSync(zipPath, Buffer.from("not-a-zip"));
    await expect(restoreBackup(zipPath)).rejects.toThrow("备份文件无效");
  });
});

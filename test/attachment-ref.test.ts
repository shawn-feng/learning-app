import { describe, expect, it } from "vitest";
import { attachmentMarker, attachmentRefFor, RESTORE_ATTACHMENT_RE } from "../src/lib/attachment-ref";

/**
 * ISSUE-124 回归：家长聊天附件的「引用」选择与标记格式。
 * 现场故障：家长上传图片后，标记里是本机路径 parents/<pid>/uploads/x.jpg，
 * 服务端 agent 读不到（文件在家长电脑上）→ 让模型去试 materials/uploads/parents 各路径白跑一圈。
 * 修复后：主进程上送服务端并回填 ref（files/<id>），标记优先用 ref。
 */
describe("attachmentRefFor — 发往服务端 agent 的附件引用", () => {
  it("有服务端引用时优先用 ref（服务端才读得到）", () => {
    expect(attachmentRefFor({ path: "parents/p1/uploads/a.jpg", ref: "files/9f2c-uuid" })).toBe("files/9f2c-uuid");
  });

  it("没有 ref 时退回本机相对路径（老主进程 / 上送失败）", () => {
    expect(attachmentRefFor({ path: "parents/p1/uploads/a.jpg" })).toBe("parents/p1/uploads/a.jpg");
  });

  it("都没有 → 未保存（不产生空引用）", () => {
    expect(attachmentRefFor({})).toBe("未保存");
    expect(attachmentRefFor(undefined)).toBe("未保存");
    expect(attachmentRefFor({ ref: "   ", path: "  " })).toBe("未保存");
  });

  it("ref 两端空白被忽略", () => {
    expect(attachmentRefFor({ ref: " files/x " })).toBe("files/x");
  });
});

describe("attachmentMarker — 标记格式与历史恢复解析对齐", () => {
  it("图片标记用 ref", () => {
    const m = attachmentMarker("图片", "作业.jpg", { path: "parents/p1/uploads/作业.jpg", ref: "files/abc" });
    expect(m).toBe("【附件图片：作业.jpg|files/abc】");
  });

  it("文件标记无 ref 时退回本机路径", () => {
    const m = attachmentMarker("文件", "作业.txt", { path: "parents/p1/uploads/作业.txt" });
    expect(m).toBe("【附件文件：作业.txt|parents/p1/uploads/作业.txt】");
  });

  it("标记可被历史恢复正则解析回「类型 / 名字 / 引用」", () => {
    const m = attachmentMarker("图片", "作业.jpg", { ref: "files/abc" });
    const hit = [...m.matchAll(RESTORE_ATTACHMENT_RE)];
    expect(hit).toHaveLength(1);
    expect(hit[0][1]).toBe("图片");
    expect(hit[0][2]).toBe("作业.jpg");
    expect(hit[0][3]).toBe("files/abc");
  });

  it("一条消息里的多个附件标记分别可解析", () => {
    const text = [
      "珊珊的语文作业是图片里的。",
      attachmentMarker("图片", "作业1.jpg", { ref: "files/a" }),
      attachmentMarker("文件", "答案.txt", { ref: "files/b" }),
    ].join("\n");
    const hit = [...text.matchAll(RESTORE_ATTACHMENT_RE)];
    expect(hit.map((h) => h[3])).toEqual(["files/a", "files/b"]);
  });
});

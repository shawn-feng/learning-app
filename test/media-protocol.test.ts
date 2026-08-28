import { describe, it, expect, vi } from "vitest";

// media-protocol.ts 顶部 import { protocol } from "electron"，纯 node 打桩
vi.mock("electron", () => ({ protocol: {} }));

import { resolveMediaTarget } from "../electron/lib/media-protocol";

describe("SPLIT 方案A media:// 协议解析（远程材料相对路径 + 防穿越）", () => {
  it("新格式 parent/{pid}/{topic}/media/{file} → 材料相对路径（posix）", () => {
    const p = resolveMediaTarget("/parent/default/lunyu/media/论语学而篇第一章.mp3");
    expect(p).toBe("lunyu/media/论语学而篇第一章.mp3");
  });

  it("百分号编码的中文文件名被正确解码", () => {
    const p = resolveMediaTarget("/parent/default/lunyu/media/%E8%AE%BA%E8%AF%AD%E5%AD%A6%E8%80%8C%E7%AF%87%E7%AC%AC%E4%B8%80%E7%AB%A0.mp3");
    expect(p).toBe("lunyu/media/论语学而篇第一章.mp3");
  });

  // 旧格式 {childId}/learning/{topic}/media/{file} 已废弃（资料统一走父库共享目录），
  // 解析层不再支持，返回 null（防误用旧链接访问孩子目录）。
  it("旧格式 {childId}/learning/... 不再解析（返回 null）", () => {
    expect(resolveMediaTarget("/abc123/learning/lunyu/media/论语.mp3")).toBeNull();
  });

  it("目录穿越被拒绝（parent 段内 ../）", () => {
    expect(resolveMediaTarget("/parent/default/../../etc/passwd")).toBeNull();
    expect(resolveMediaTarget("/parent/default/lunyu/media/..%2F..%2F..%2Fsecret.mp3")).toBeNull();
  });

  it("parentId 含 .. 或 \\ 被拒绝", () => {
    expect(resolveMediaTarget("/parent/..%2F..%2Fhack/lunyu/media/x.mp3")).toBeNull();
    expect(resolveMediaTarget("/..%5Chack/learning/lunyu/media/x.mp3")).toBeNull();
  });

  it("rest 段含 .. 被拒绝", () => {
    expect(resolveMediaTarget("/parent/default/lunyu/media/a/../../x.mp3")).toBeNull();
  });

  it("片段不足或空路径返回 null", () => {
    expect(resolveMediaTarget("/")).toBeNull();
    expect(resolveMediaTarget("/parent/default")).toBeNull();
    expect(resolveMediaTarget("")).toBeNull();
  });
});

import { describe, it, expect, vi } from "vitest";
import path from "path";

// media-protocol.ts 顶部 import { protocol, net } from "electron"，纯 node 打桩
vi.mock("electron", () => ({ protocol: {}, net: {} }));

import { resolveMediaTarget } from "../electron/lib/media-protocol";

const DATA = path.join("C:", "data"); // 任意 data 根，只测路径解析

describe("ISSUE-029 media:// 协议解析（父库共享 + 旧格式兜底 + 防穿越）", () => {
  it("新格式 parent/{pid}/{topic}/media/{file} → 父库 materials 共享目录", () => {
    const p = resolveMediaTarget(DATA, "/parent/default/lunyu/media/论语学而篇第一章.mp3");
    expect(p).toBe(path.join(DATA, "parents", "default", "materials", "lunyu", "media", "论语学而篇第一章.mp3"));
  });

  it("百分号编码的中文文件名被正确解码", () => {
    const p = resolveMediaTarget(DATA, "/parent/default/lunyu/media/%E8%AE%BA%E8%AF%AD%E5%AD%A6%E8%80%8C%E7%AF%87%E7%AC%AC%E4%B8%80%E7%AB%A0.mp3");
    expect(p).toBe(path.join(DATA, "parents", "default", "materials", "lunyu", "media", "论语学而篇第一章.mp3"));
  });

  it("旧格式 {childId}/learning/{topic}/media/{file} 仍解析到孩子目录（兼容存量）", () => {
    const p = resolveMediaTarget(DATA, "/abc123/learning/lunyu/media/论语.mp3");
    expect(p).toBe(path.join(DATA, "children", "abc123", "learning", "lunyu", "media", "论语.mp3"));
  });

  it("目录穿越被拒绝（parent 段内 ../）", () => {
    expect(resolveMediaTarget(DATA, "/parent/default/../../etc/passwd")).toBeNull();
    expect(resolveMediaTarget(DATA, "/parent/default/lunyu/media/..%2F..%2F..%2Fsecret.mp3")).toBeNull();
  });

  it("parentId/childId 含 .. 或 \\ 被拒绝", () => {
    expect(resolveMediaTarget(DATA, "/parent/..%2F..%2Fhack/lunyu/media/x.mp3")).toBeNull();
    expect(resolveMediaTarget(DATA, "/..%5Chack/learning/lunyu/media/x.mp3")).toBeNull();
  });

  it("片段不足或空路径返回 null", () => {
    expect(resolveMediaTarget(DATA, "/")).toBeNull();
    expect(resolveMediaTarget(DATA, "/parent/default")).toBeNull();
    expect(resolveMediaTarget(DATA, "")).toBeNull();
  });
});

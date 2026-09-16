/**
 * materials 域（Phase 3 实现）：MATERIAL 保鲜——恢复展示的服务端共享 html 内容刷新。
 *
 * 对齐 electron/lib/ipc-handlers.ts 的 materials:refresh 通道（1663-1675 行）：
 *   1. 剥掉可选的 materials/ 前缀；
 *   2. 仅接受 `{topic}/....(html|htm)` 形态且非 outputs/ 的「服务端共享资料」，否则
 *      {success:false, error:"非服务端共享资料，跳过刷新"}；
 *   3. 命中则经服务端 GET /materials/content/:id（id=base64url(相对路径)，语义同
 *      electron/lib/media-protocol.ts fetchMaterialContent）拉最新内容，utf-8 解码返回
 *      {success:true, content}。
 * 渲染层消费点 src/pages/Learn.tsx refreshStaleMaterials：r.success && typeof r.content === "string"。
 */
import { httpBinary, encodeMaterialId } from "../core/server-fetch";

export const materialsDomain = {
  /** materialsRefresh: (filePath: string) => Promise<{ success: boolean; content?: string; error?: string }> */
  materialsRefresh: async (
    filePath: string
  ): Promise<{ success: boolean; content?: string; error?: string }> => {
    const rel = String(filePath || "").replace(/^materials\//, "");
    if (!/^[A-Za-z0-9_\-\u4e00-\u9fa5]+\/.+\.(html|htm)$/i.test(rel) || rel.startsWith("outputs/")) {
      return { success: false, error: "非服务端共享资料，跳过刷新" };
    }
    try {
      const buf = await httpBinary(`/materials/content/${encodeMaterialId(rel)}`);
      return { success: true, content: new TextDecoder("utf-8").decode(buf) };
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
  },
};

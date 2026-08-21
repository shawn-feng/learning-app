// P1 token 收益量化：kb_query(tags) vs read tags/*.md 全文
import { queryTagLinks, tagLinksToMarkdown } from "../electron/lib/kb-sqlite.ts";
import fs from "fs";
import path from "path";

const childDir = "C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674";

// 1) 全量标签查询（agent 想找所有关联时的典型场景）
const all = queryTagLinks(childDir);
const allMd = tagLinksToMarkdown(all);
console.log(`[全部标签] kb_query 返回: ${allMd.length} 字符`);

// 2) 对比：read 全部 tags/*.md 全文（旧方式：agent 需要逐个 read）
const tagsDir = path.join(childDir, "tags");
let total = 0;
let fileCount = 0;
for (const f of fs.readdirSync(tagsDir)) {
  if (f.endsWith(".md") && f !== "taxonomy.md") {
    total += fs.readFileSync(path.join(tagsDir, f), "utf-8").length;
    fileCount++;
  }
}
console.log(`[全部标签] read ${fileCount} 个 tags 文件全文: ${total} 字符（${(total / allMd.length).toFixed(1)}x）`);

// 3) 单标签查询（最典型：教某课前查关联生活事件）
const single = queryTagLinks(childDir, "亲情");
const singleMd = tagLinksToMarkdown(single);
const singleFile = fs.readFileSync(path.join(tagsDir, "亲情.md"), "utf-8");
console.log(`[单标签亲情] kb_query: ${singleMd.length} 字符 vs read 全文: ${singleFile.length} 字符（${(singleFile.length / singleMd.length).toFixed(1)}x）`);

// 4) 按 kind 过滤（只查生活事件）
const life = queryTagLinks(childDir, undefined, "life");
const lifeMd = tagLinksToMarkdown(life);
console.log(`[仅生活事件] kb_query: ${lifeMd.length} 字符（旧方式需读全部文件再让 LLM 筛）`);

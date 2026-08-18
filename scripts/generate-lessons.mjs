// 论语专用脚本：针对论语单章共性格式（原文吟诵 / 白话翻译 / 道理应用）批量把 markdown 转 HTML（含音视频引用）。
// 每个主题文案结构不同，无通用脚本——其他主题由 AI 手工拼 html 展示，或针对该主题共性格式另写专用脚本批量转。
// 用法：node scripts/generate-lessons.mjs lunyu [childId]
//   默认 childId 为珊珊；省略主题参数时默认 lunyu
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// ---- 主题配置 ----
const THEMES = {
  lunyu: {
    topic: "lunyu",
    mediaDir: "learning/lunyu/media", // 相对 childDir（音视频固定在学习主题目录 media/ 下）
    mediaExt: ".mp3",
    mediaKind: "audio",
  },
};

const DEFAULT_CHILD_ID = "1f050a7f-df8a-45b0-925a-1ffe2aa35674";

// ---- 工具函数 ----
function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 行级 markdown：**加粗** -> <strong>
function inline(s) {
  return escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function stripFrontmatter(text) {
  const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? text.slice(m[0].length) : text;
}

// 通用块级 markdown -> html（针对论语单章结构）
function renderBlocks(lines) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    const t = line.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (/^###\s/.test(line)) {
      out.push(`<h3>${inline(line.replace(/^###\s*/, ""))}</h3>`);
      i++;
    } else if (t.startsWith("|")) {
      const tableLines = [];
      while (i < n && lines[i].trim().startsWith("|")) {
        tableLines.push(lines[i].trim());
        i++;
      }
      out.push(tableToHtml(tableLines));
    } else if (/^\*\s/.test(line)) {
      const items = [];
      while (i < n && /^\*\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\*\s*/, ""));
        i++;
      }
      out.push("<ul>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ul>");
    } else if (/^\d+\.\s/.test(line)) {
      const items = [];
      while (i < n && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s*/, ""));
        i++;
      }
      out.push("<ol>" + items.map((x) => `<li>${inline(x)}</li>`).join("") + "</ol>");
    } else {
      const para = [];
      while (
        i < n &&
        lines[i].trim() !== "" &&
        !/^###\s/.test(lines[i]) &&
        !lines[i].trim().startsWith("|") &&
        !/^\*\s/.test(lines[i]) &&
        !/^\d+\.\s/.test(lines[i])
      ) {
        para.push(lines[i].trim());
        i++;
      }
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

function tableToHtml(lines) {
  const rows = lines.map((l) =>
    l
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((c) => c.trim())
  );
  const header = rows[0] || [];
  const data = rows.slice(2); // rows[1] 是 :-- 分隔符
  let html = "<table><thead><tr>";
  for (const h of header) html += `<th>${inline(h)}</th>`;
  html += "</tr></thead><tbody>";
  for (const r of data) {
    html += "<tr>";
    for (const c of r) html += `<td>${inline(c)}</td>`;
    html += "</tr>";
  }
  html += "</tbody></table>";
  return html;
}

// 解析 ## sections
function parseSections(body) {
  const sections = {};
  const lines = body.split("\n");
  let current = null;
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      current = line.replace(/^##\s*/, "").trim();
      sections[current] = [];
    } else if (/^#\s/.test(line)) {
      // 跳过 h1 课程标题
      continue;
    } else if (current) {
      sections[current].push(line);
    }
  }
  return sections;
}

function parseCourseNames(progressContent) {
  const names = [];
  for (const line of progressContent.split("\n")) {
    const t = line.trim();
    if (t.startsWith("### ")) names.push(t.slice(4).trim());
  }
  return names;
}

// ---- HTML 模板 ----
const STYLE = `
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:#FFFBF3;color:#3A3236;font-family:'PingFang SC','Hiragino Sans GB','Microsoft YaHei',system-ui,sans-serif;font-size:17px;line-height:1.75;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 60px}
.hd{display:flex;align-items:center;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.hd .pill{background:#FFE3D6;color:#6B4444;font-weight:600;padding:5px 14px;border-radius:999px;font-size:14px}
.hd h1{margin:0;font-size:22px;font-weight:600;color:#4A2C2A}
.card{background:#fff;border-radius:20px;box-shadow:0 6px 22px rgba(180,120,100,.10);padding:22px 24px;margin-bottom:20px;position:relative;overflow:hidden}
.card::before{content:"";position:absolute;top:0;left:0;right:0;height:5px}
.card-title{font-size:15px;font-weight:600;color:#fff;display:inline-block;padding:4px 14px;border-radius:999px;margin-bottom:14px}
.card.yuanwen::before{background:linear-gradient(90deg,#FFD9B8,#FFC1A4)}
.card.yuanwen .card-title{background:#E88C5B}
.card.vocab::before{background:linear-gradient(90deg,#C7E9F7,#A8DAF1)}
.card.vocab .card-title{background:#4A90C2}
.card.translate::before{background:linear-gradient(90deg,#D6F2D9,#B6E5C0)}
.card.translate .card-title{background:#5BA35B}
.card.story::before{background:linear-gradient(90deg,#EAD7F5,#D9BCEF)}
.card.story .card-title{background:#9A6BBF}
.original-text{font-family:'STKaiti','KaiTi','楷体','Songti SC',serif;font-size:30px;line-height:1.8;letter-spacing:.04em;color:#4A2C2A;padding:8px 4px 4px;word-break:break-all}
audio,video{width:100%;margin:6px 0 12px;border-radius:12px;outline:none}
h3{font-size:17px;font-weight:600;color:#6B4444;margin:14px 0 8px}
p{margin:8px 0}
ul,ol{margin:8px 0;padding-left:22px}
li{margin:6px 0}
table{border-collapse:collapse;width:100%;margin:10px 0}
th,td{border:1px solid #eee;padding:8px 12px;text-align:left;font-size:15px}
th{background:#FBF3EC;color:#6B4444;font-weight:600}
tr:nth-child(even) td{background:#FDF8F2}
strong{color:#B0482A}
`.trim();

function buildHtml(courseName, sections, childId, topic) {
  const cards = [];

  // 原文吟诵（含音频 + 原文大字 + 重点字词）
  if (sections["原文吟诵"]) {
    const lines = sections["原文吟诵"];
    const yuanwenIdx = lines.findIndex((l) => /^###\s/.test(l) && !/重点字词读音/.test(l));
    const yuanwen = yuanwenIdx >= 0 ? lines[yuanwenIdx].replace(/^###\s*/, "").trim() : "";
    const vocabIdx = lines.findIndex((l) => /重点字词读音/.test(l));
    const vocabHtml = vocabIdx >= 0 ? renderBlocks(lines.slice(vocabIdx + 1)) : "";

    const audioSrc = `media://local/${childId}/learning/${topic}/media/${encodeURIComponent(courseName)}.mp3`;
    cards.push(`
<section class="card yuanwen">
  <div class="card-title">原文吟诵</div>
  <audio controls preload="metadata" src="${audioSrc}"></audio>
  <div class="original-text">${inline(yuanwen)}</div>
  ${vocabHtml ? `<h3>重点字词读音</h3>${vocabHtml}` : ""}
</section>`);
  }

  // 白话翻译讲解
  if (sections["白话翻译讲解"]) {
    cards.push(`
<section class="card translate">
  <div class="card-title">白话翻译</div>
  ${renderBlocks(sections["白话翻译讲解"])}
</section>`);
  }

  // 道理应用讲解
  if (sections["道理应用讲解"]) {
    cards.push(`
<section class="card story">
  <div class="card-title">道理应用</div>
  ${renderBlocks(sections["道理应用讲解"])}
</section>`);
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(courseName)}</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">
  <header class="hd"><span class="pill">论语</span><h1>${escapeHtml(courseName)}</h1></header>
  ${cards.join("\n")}
</div>
</body>
</html>`;
}

// ---- 主流程 ----
function main() {
  const topicArg = process.argv[2] || "lunyu";
  const childId = process.argv[3] || DEFAULT_CHILD_ID;
  const cfg = THEMES[topicArg];
  if (!cfg) {
    console.error(`未知主题: ${topicArg}，可用: ${Object.keys(THEMES).join(", ")}`);
    process.exit(1);
  }

  const learningDir = path.join(ROOT, "data", "children", childId, "learning", cfg.topic);
  const progressFile = path.join(learningDir, `${cfg.topic}.md`);
  const materialsDir = path.join(learningDir, "materials");
  const mediaDir = path.join(ROOT, "data", "children", childId, cfg.mediaDir);

  if (!fs.existsSync(progressFile)) {
    console.error(`进度文件不存在: ${progressFile}`);
    process.exit(1);
  }

  const progressContent = fs.readFileSync(progressFile, "utf-8");
  const courseNames = parseCourseNames(progressContent);
  console.log(`主题 ${cfg.topic}：共 ${courseNames.length} 课`);

  let ok = 0;
  let skip = 0;
  let fail = 0;
  for (const name of courseNames) {
    const mdFile = path.join(materialsDir, `${name}.md`);
    const htmlFile = path.join(materialsDir, `${name}.html`);
    const mediaFile = path.join(mediaDir, `${name}${cfg.mediaExt}`);

    if (!fs.existsSync(mdFile)) {
      console.log(`  跳过（缺文案）: ${name}`);
      skip++;
      continue;
    }
    if (!fs.existsSync(mediaFile)) {
      console.log(`  跳过（缺媒体）: ${name}`);
      skip++;
      continue;
    }

    try {
      const mdContent = fs.readFileSync(mdFile, "utf-8");
      const body = stripFrontmatter(mdContent);
      const sections = parseSections(body);
      const html = buildHtml(name, sections, childId, cfg.topic);
      fs.writeFileSync(htmlFile, html, "utf-8");
      ok++;
    } catch (e) {
      console.log(`  失败: ${name} - ${e.message}`);
      fail++;
    }
  }

  console.log(`完成：生成 ${ok}，跳过 ${skip}，失败 ${fail}`);
  if (ok > 0) {
    console.log(`输出目录: ${materialsDir}`);
    const sample = path.join(materialsDir, `${courseNames[0]}.html`);
    console.log(`样例: ${sample}`);
  }
}

main();

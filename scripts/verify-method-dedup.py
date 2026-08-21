# -*- coding: utf-8 -*-
import sqlite3, re

db = sqlite3.connect(r"data/parents/default/parent.sqlite")
rows = db.execute("SELECT name, method FROM topics").fetchall()
pat = re.compile(
    r'\{table:"course"|\{table:"daily"|display_content\(path="learning/'
    r"|读 materials/ 的索引|materials/\{课程名\}\.md|tags/\{tag\}\.md|learning/reading/reading\.md"
)
bad = 0
for name, m in rows:
    hits = pat.findall(m or "")
    if hits:
        bad += 1
        print(f"[{name}] 残留 {len(hits)} 处: {hits[:4]}")
print(f"残留主题数: {bad}/{len(rows)}")

print("\n=== 论语 method 关键段抽查 ===")
m = dict(rows)["论语"]
for line in m.splitlines():
    s = line.strip()
    if any(k in s for k in ["parent_content", "display_content", "kb_update", "kb_insert", "获取该课教学文案"]):
        print(" ", s[:170])
db.close()

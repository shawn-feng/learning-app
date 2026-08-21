# -*- coding: utf-8 -*-
import sqlite3, re

db = sqlite3.connect(r"data/parents/default/parent.sqlite")
rows = db.execute("SELECT name, method FROM topics").fetchall()
pat = re.compile(
    r'type:"teachingCopy"|type:"htmlPath"|table 用|table:"|topic 传|item 传|field 传|value 传|query:"|\{type:|field:"|course 传|date 取|block 用'
)
bad = 0
for name, m in rows:
    hits = pat.findall(m or "")
    if hits:
        bad += 1
        print(f"[{name}] 残留 {len(hits)} 处: {sorted(set(hits))[:6]}")
print(f"残留主题数: {bad}/{len(rows)}")

print("\n=== 各主题工具引用现状（只应看到「用什么工具做什么」）===")
for name, m in rows:
    print(f"--- {name} ---")
    for line in m.splitlines():
        s = line.strip()
        if any(k in s for k in ["parent_content", "kb_update", "kb_insert", "kb_query", "display_content"]):
            print("  ", s[:150])
db.close()

# -*- coding: utf-8 -*-
"""将 subscriptions 表中 active 订阅的 max_children 更新为 4（存量账号升级）。

用法（服务器上）：
    /opt/learning-cloud/venv/bin/python /tmp/deploy/update_max_children.py
"""
import sqlite3

DB = "/opt/learning-cloud/database/app.db"

db = sqlite3.connect(DB)
cur = db.cursor()
print("=== before ===")
for r in cur.execute(
    "SELECT status, max_children, COUNT(*) FROM subscriptions GROUP BY status, max_children ORDER BY status"
):
    print(r)

n = cur.execute(
    "UPDATE subscriptions SET max_children = 4 WHERE status = 'active'"
).rowcount
db.commit()
print("updated rows:", n)

print("=== after ===")
for r in cur.execute(
    "SELECT status, max_children, COUNT(*) FROM subscriptions GROUP BY status, max_children ORDER BY status"
):
    print(r)
db.close()

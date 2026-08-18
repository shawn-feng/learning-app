# -*- coding: utf-8 -*-
"""列出 insert/delete 型差异，检查是否缺字或多字（子曰等）"""
import re, json

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/original_diffs_hanzi.json', encoding='utf-8') as f:
    diffs = json.load(f)

print("=== delete 型（文案比标准多字）和 insert 型（文案比标准少字）===")
for d in diffs:
    if 'ops' not in d:
        continue
    dels = [op for op in d['ops'] if op[0] == 'delete']
    ins = [op for op in d['ops'] if op[0] == 'insert']
    if not dels and not ins:
        continue
    # 只输出没有大规模 delete 的（大规模 delete 是分章差异）
    big_del = any(len(op[1]) > 12 for op in dels)
    if big_del:
        continue
    print(f"◆ {d['file']} ({d['key']})")
    if dels:
        for op in dels:
            print(f"  [文案多出] {op[1]}")
    if ins:
        for op in ins:
            print(f"  [文案缺失] {op[2]}")

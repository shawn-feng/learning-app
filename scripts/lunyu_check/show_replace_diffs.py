# -*- coding: utf-8 -*-
"""用钱穆《论语新解》验证所有 replace 型差异"""
import re, json

def clean_text(s):
    s = re.sub(r'[⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇]', '', s)
    s = s.replace('“', '"').replace('”', '"').replace('‘', "'").replace('’', "'")
    s = s.replace('，', ',').replace('。', '.').replace('？', '?').replace('；', ';')
    s = s.replace('：', ':')
    s = re.sub(r'\s+', '', s)
    return s

def hanzi_only(s):
    s = re.sub(r'[⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇①-⑳]', '', s)
    s = re.sub(r'[^\u4e00-\u9fff]', '', s)
    return s

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/original_diffs_hanzi.json', encoding='utf-8') as f:
    diffs = json.load(f)

# 只输出 replace 型（字词替换）的差异
for d in diffs:
    if 'ops' not in d:
        continue
    reps = [op for op in d['ops'] if op[0] == 'replace']
    if reps:
        print(f"◆ {d['file']} ({d['key']})")
        print(f"  文案: {d['material_text']}")
        print(f"  标准: {d['std_text']}")
        print(f"  replace差异: {reps}")
        print()

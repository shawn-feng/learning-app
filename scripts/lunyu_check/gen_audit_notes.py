# -*- coding: utf-8 -*-
"""生成审读对照文件：每章原文 + 教学文案翻译 + 杨伯峻标准译文，按篇分组输出"""
import re, json, glob, os

MATERIALS = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"
OUT = r"C:/Users/79734/Documents/pi/scripts/lunyu_check/audit_notes"

PIAN_ORDER = ['学而','为政','八佾','里仁','公冶长','雍也','述而','泰伯','子罕','乡党',
              '先进','颜渊','子路','宪问','卫灵公','季氏','阳货','微子','子张','尧曰']
PIAN_NUM = {p: i+1 for i, p in enumerate(PIAN_ORDER)}

def cn2num(s):
    CN = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
          '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,
          '十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,
          '二十六':26,'二十七':27,'二十八':28,'二十九':29,'三十':30,'三十一':31,'三十二':32,
          '三十三':33,'三十四':34,'三十五':35,'三十六':36,'三十七':37,'三十八':38,'三十九':39,
          '四十':40,'四十一':41,'四十二':42,'四十三':43,'四十四':44}
    return CN.get(s, 0)

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/standard_yiwen.json', encoding='utf-8') as f:
    std = json.load(f)
yang = std['yang']

def parse_md(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    r = {'file': os.path.basename(path), 'original': None, 'trans': None, 'meaning': None}
    lines = text.split('\n')
    in_sec = False
    for i, line in enumerate(lines):
        ls = line.strip()
        if ls.startswith('## '):
            in_sec = '原文吟诵' in ls
            continue
        if in_sec and ls.startswith('###') and '读音' not in ls and '字词' not in ls:
            r['original'] = ls.lstrip('#').strip()
            break
    m = re.search(r'## 白话翻译讲解\n(.*?)(?=## 道理应用讲解)', text, re.S)
    if m:
        r['trans'] = m.group(1).strip()
    m = re.search(r'\*\*释义\*\*\n(.*?)(?=\n\*\*生活例子|\n\*\*历史典故|\Z)', text, re.S)
    if m:
        r['meaning'] = m.group(1).strip()
    return r

# 按篇分组
pians = {}
for f in sorted(glob.glob(os.path.join(MATERIALS, '*.md'))):
    m = re.match(r'论语([^篇]+)篇第([一二三四五六七八九十]+)章', os.path.basename(f))
    if not m:
        continue
    p = PIAN_NUM.get(m.group(1))
    c = cn2num(m.group(2))
    if not p:
        continue
    pians.setdefault(p, {})[c] = parse_md(f)

os.makedirs(OUT, exist_ok=True)

for p, chapters in sorted(pians.items()):
    pname = PIAN_ORDER[p-1]
    lines_out = [f'# 审读对照 · {pname}篇\n']
    for c in sorted(chapters.keys()):
        ch = chapters[c]
        key = f'{p}.{c}'
        yw = yang.get(key, '（杨伯峻无此章译文）')
        lines_out.append(f'\n## {key} · {pname}篇第{cn2num(str(c)) if False else c}章')
        lines_out.append(f'**原文**：{ch["original"]}')
        lines_out.append(f'**杨伯峻译文**：{yw}')
        if ch['trans']:
            # 压缩翻译为纯文本
            t = re.sub(r'\*\*', '', ch['trans'])
            t = re.sub(r'\n\s*\n', '\n', t)
            lines_out.append(f'**教学文案翻译**：\n{t}')
        if ch['meaning']:
            lines_out.append(f'**教学文案释义**：{ch["meaning"]}')
    with open(os.path.join(OUT, f'{p:02d}_{pname}篇.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines_out))
    print(f'已生成 {p:02d}_{pname}篇.md ({len(chapters)}章)')

# -*- coding: utf-8 -*-
"""从杨伯峻《论语译注》提取【译文】、钱穆《论语新解》提取白话试译，作为翻译审读基准"""
import re, json

PIAN_ORDER = ['学而','为政','八佾','里仁','公冶长','雍也','述而','泰伯','子罕','乡党',
              '先进','颜渊','子路','宪问','卫灵公','季氏','阳货','微子','子张','尧曰']
PIAN_NUM = {p: i+1 for i, p in enumerate(PIAN_ORDER)}

def clean(s):
    s = re.sub(r'[⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇]', '', s)
    return s.strip()

# ---------- 杨伯峻【译文】 ----------
yang_file = r"C:/Users/79734/Documents/pi/学习技能和资料/论语资料/论语译注-杨伯峻.md"
with open(yang_file, encoding='utf-8-sig') as f:
    yang_lines = f.read().split('\n')

yang_yiwen = {}  # '篇.章' -> 译文
cur_pian = None
cur_chap = None
for i, line in enumerate(yang_lines):
    m = re.match(r'``\s*\*\*([^篇]+)篇第([一二三四五六七八九十]+)\*\*\s*``', line)
    if m:
        pname = m.group(1)
        if pname in PIAN_NUM:
            cur_pian = PIAN_NUM[pname]
        continue
    m = re.match(r'(\d+)\.(\d+)', line)
    if m and cur_pian:
        cur_chap = int(m.group(2))
        continue
    # 【译文】行
    if '【译文】' in line and cur_pian and cur_chap:
        yiwen = line.split('【译文】', 1)[1].strip()
        # 可能译文跨行，这里只取第一行（杨伯峻译文通常单行）
        yang_yiwen[f'{cur_pian}.{cur_chap}'] = clean(yiwen)

print(f'杨伯峻译文提取 {len(yang_yiwen)} 章')

# ---------- 钱穆白话试译 ----------
qian_file = r"C:/Users/79734/Documents/pi/学习技能和资料/论语资料/论语新解-钱穆.txt"
with open(qian_file, encoding='gb18030') as f:
    qian_lines = f.read().split('\n')

qian_shiyi = {}  # '篇.章' -> 白话试译
cur_pian = None
chap_num = 0
CN_NUM = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
          '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,
          '十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,
          '二十六':26,'二十七':27,'二十八':28,'二十九':29,'三十':30,'三十一':31,'三十二':32,
          '三十三':33,'三十四':34,'三十五':35,'三十六':36,'三十七':37,'三十八':38,'三十九':39,
          '四十':40,'四十一':41,'四十二':42,'四十三':43,'四十四':44,'四十五':45,'四十六':46,
          '四十七':47,'四十八':48,'四十九':49,'五十':50}
i = 0
while i < len(qian_lines):
    line = qian_lines[i].strip()
    # 篇标题
    m = re.match(r'[〇○]?([^篇]+)篇第([一二三四五六七八九十]+)', line)
    if m and '篇' in line:
        pname = m.group(1)
        if pname in PIAN_NUM:
            cur_pian = PIAN_NUM[pname]
            chap_num = 0
        i += 1
        continue
    # 章标题
    m = re.match(r'（([一二三四五六七八九十]+)）', line)
    if m and cur_pian:
        chap_num = CN_NUM.get(m.group(1), 0)
        i += 1
        continue
    # 白话试译（紧跟"白话试译"之后的一段）
    if line == '白话试译' and cur_pian and chap_num:
        # 取下一非空行
        j = i + 1
        while j < len(qian_lines) and not qian_lines[j].strip():
            j += 1
        if j < len(qian_lines):
            qian_shiyi[f'{cur_pian}.{chap_num}'] = clean(qian_lines[j].strip())
        i = j + 1
        continue
    i += 1

print(f'钱穆白话试译提取 {len(qian_shiyi)} 章')

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/standard_yiwen.json', 'w', encoding='utf-8') as f:
    json.dump({'yang': yang_yiwen, 'qian': qian_shiyi}, f, ensure_ascii=False, indent=1)
print('已保存 standard_yiwen.json')

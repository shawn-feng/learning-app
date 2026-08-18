# -*- coding: utf-8 -*-
"""从杨伯峻《论语译注》和钱穆《论语新解》提取各章标准原文，作为对照基准"""
import re, json

def clean_text(s):
    """去掉注释编号 ⑴⑵⑶ 等、注音括号等，得到纯原文"""
    s = re.sub(r'[⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇]', '', s)
    s = s.replace('“', '"').replace('”', '"').replace('‘', "'").replace('’', "'")
    s = s.replace('，', ',').replace('。', '.').replace('？', '?').replace('；', ';')
    s = re.sub(r'\s+', '', s)
    return s

PIAN_ORDER = ['学而','为政','八佾','里仁','公冶长','雍也','述而','泰伯','子罕','乡党',
              '先进','颜渊','子路','宪问','卫灵公','季氏','阳货','微子','子张','尧曰']
PIAN_NUM = {p: i+1 for i, p in enumerate(PIAN_ORDER)}

CN_NUM = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
          '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,
          '十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,
          '二十六':26,'二十七':27,'二十八':28,'二十九':29,'三十':30,'三十一':31,'三十二':32,
          '三十三':33,'三十四':34,'三十五':35,'三十六':36,'三十七':37,'三十八':38,'三十九':39,
          '四十':40,'四十一':41,'四十二':42,'四十三':43,'四十四':44}

def cn2num(s):
    return CN_NUM.get(s, 0)

# ---------- 杨伯峻 ----------
yang_file = r"C:/Users/79734/Documents/pi/学习技能和资料/论语资料/论语译注-杨伯峻.md"
with open(yang_file, encoding='utf-8-sig') as f:
    yang_text = f.read()

yang = {}  # (篇序号, 章序号) -> 原文
cur_pian = None
for line in yang_text.split('\n'):
    m = re.match(r'``\s*\*\*([^篇]+)篇第([一二三四五六七八九十]+)\*\*\s*``', line)
    if m:
        pname = m.group(1)
        if pname in PIAN_NUM:
            cur_pian = PIAN_NUM[pname]
        continue
    m = re.match(r'(\d+)\.(\d+)([^【\n]*)', line)
    if m and cur_pian:
        num = int(m.group(1))
        chap = int(m.group(2))
        orig = m.group(3)
        yang[(cur_pian, chap)] = clean_text(orig)

print(f'杨伯峻提取 {len(yang)} 章')

# ---------- 钱穆 ----------
qian_file = r"C:/Users/79734/Documents/pi/学习技能和资料/论语资料/论语新解-钱穆.txt"
with open(qian_file, encoding='gb18030') as f:
    qian_text = f.read()

qian = {}  # (篇序号, 章序号) -> 原文
cur_pian = None
chap_num = 0
lines = qian_text.split('\n')
i = 0
while i < len(lines):
    line = lines[i].strip()
    m = re.match(r'[〇○]?([^篇]+)篇第([一二三四五六七八九十]+)', line.replace('　',''))
    if m and '第' in line and ('篇' in line):
        pname = m.group(1)
        if pname in PIAN_NUM:
            cur_pian = PIAN_NUM[pname]
            chap_num = 0
        i += 1
        continue
    m = re.match(r'（([一二三四五六七八九十]+)）', line)
    if m and cur_pian:
        chap_num = cn2num(m.group(1))
        # 下一行是原文
        if i + 1 < len(lines):
            orig = lines[i+1].strip()
            qian[(cur_pian, chap_num)] = clean_text(orig)
    i += 1

print(f'钱穆提取 {len(qian)} 章')

# 保存
with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/standard_texts.json', 'w', encoding='utf-8') as f:
    json.dump({'yang': {f'{k[0]}.{k[1]}': v for k, v in yang.items()},
               'qian': {f'{k[0]}.{k[1]}': v for k, v in qian.items()}}, f, ensure_ascii=False, indent=1)
print('已保存 standard_texts.json')

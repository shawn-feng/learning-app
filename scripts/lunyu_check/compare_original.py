# -*- coding: utf-8 -*-
"""对比教学文案原文与杨伯峻标准原文，找出文字差异"""
import re, json, difflib

PIAN_ORDER = ['学而','为政','八佾','里仁','公冶长','雍也','述而','泰伯','子罕','乡党',
              '先进','颜渊','子路','宪问','卫灵公','季氏','阳货','微子','子张','尧曰']
PIAN_NUM = {p: i+1 for i, p in enumerate(PIAN_ORDER)}

def cn2num(s):
    CN_NUM = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10,
              '十一':11,'十二':12,'十三':13,'十四':14,'十五':15,'十六':16,'十七':17,'十八':18,
              '十九':19,'二十':20,'二十一':21,'二十二':22,'二十三':23,'二十四':24,'二十五':25,
              '二十六':26,'二十七':27,'二十八':28,'二十九':29,'三十':30,'三十一':31,'三十二':32,
              '三十三':33,'三十四':34,'三十五':35,'三十六':36,'三十七':37,'三十八':38,'三十九':39,
              '四十':40,'四十一':41,'四十二':42,'四十三':43,'四十四':44,'四十五':45,'四十六':46,
              '四十七':47,'四十八':48,'四十九':49,'五十':50,'五十一':51,'五十二':52,'五十三':53,
              '五十四':54,'五十五':55,'五十六':56,'五十七':57,'五十八':58,'五十九':59,'六十':60,
              '六十一':61,'六十二':62,'六十三':63,'六十四':64,'六十五':65,'六十六':66,'六十七':67,
              '六十八':68,'六十九':69,'七十':70}
    return CN_NUM.get(s, 0)

def clean_text(s):
    """去掉注释编号、引号差异、空白，得到可比较的纯文本"""
    s = re.sub(r'[⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽⑾⑿⒀⒁⒂⒃⒄⒅⒆⒇]', '', s)
    s = s.replace('“', '"').replace('”', '"').replace('‘', "'").replace('’', "'")
    s = s.replace('，', ',').replace('。', '.').replace('？', '?').replace('；', ';')
    s = s.replace('：', ':')
    s = re.sub(r'\s+', '', s)
    return s

# 载入数据
with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/materials_extracted.json', encoding='utf-8') as f:
    materials = json.load(f)
with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/standard_texts.json', encoding='utf-8') as f:
    std = json.load(f)

yang = std['yang']  # '篇.章' -> 原文

def loc_key(filename):
    m = re.match(r'论语([^篇]+)篇第([一二三四五六七八九十]+)章', filename)
    if not m:
        return None
    p = PIAN_NUM.get(m.group(1))
    c = cn2num(m.group(2))
    return (p, c)

diffs = []
for mat in materials:
    key = loc_key(mat['file'])
    if not key:
        diffs.append({'file': mat['file'], 'issue': '文件名无法解析'})
        continue
    std_text = yang.get(f'{key[0]}.{key[1]}')
    if not std_text:
        diffs.append({'file': mat['file'], 'issue': f'标准库无 {key[0]}.{key[1]}'})
        continue
    orig = mat['original']
    if not orig:
        diffs.append({'file': mat['file'], 'issue': '文案无原文', 'std': std_text})
        continue
    a = clean_text(orig)
    b = std_text
    if a == b:
        continue
    # 计算差异
    sm = difflib.SequenceMatcher(None, a, b)
    ops = [op for op in sm.get_opcodes() if op[0] != 'equal']
    diffs.append({
        'file': mat['file'],
        'key': f'{key[0]}.{key[1]}',
        'material_text': orig,
        'std_text': std_text,
        'ops': [(op[0], a[op[1]:op[2]], b[op[3]:op[4]]) for op in ops]
    })

print(f'原文一致: {512 - len(diffs)} 篇')
print(f'存在差异: {len(diffs)} 篇')
print()
for d in diffs:
    if 'ops' in d:
        print(f"◆ {d['file']} ({d['key']})")
        print(f"  文案: {d['material_text']}")
        print(f"  标准: {d['std_text']}")
        print(f"  差异: {d['ops']}")
    else:
        print(f"◆ {d['file']} — {d['issue']}")

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/original_diffs.json', 'w', encoding='utf-8') as f:
    json.dump(diffs, f, ensure_ascii=False, indent=1)

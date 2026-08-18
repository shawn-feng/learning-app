# -*- coding: utf-8 -*-
"""检查读音表的常见多音字错误"""
import json, re

with open(r'C:/Users/79734/Documents/pi/scripts/lunyu_check/materials_extracted.json', encoding='utf-8') as f:
    materials = json.load(f)

# 需要重点检查的多音字：说(yuè/xuē/shuō)、乐(yuè/lè/yào)、乘(shèng/chéng)、省(xǐng/shěng)、
# 传(chuán/zhuàn)、为(wéi/wèi)、恶(wù/è)、好(hào/hǎo)、食(sì/shí)、语(yù/yǔ)、
# 见(xiàn/jiàn)、度(duó/dù)、说(shuì/shuō)、契(qì/xiè)、大(tài/dà)、
# 共(gǒng/gòng)、辟(bì/pì)、夫(fú/fū)、行(xíng/hàng)、知(zhì/zhī)、
# 女(rǔ/nǚ)、归(kuì/guī)、说(yuè)、兑、齐(zhāi/qí)、乐(yào)、朝(zhāo/cháo)

suspect = []
for mat in materials:
    for row in mat['pron_table']:
        if len(row) < 3:
            continue
        word, pron, meaning = row[0], row[1], row[2]
        # 检查读音格式
        if not re.match(r'^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜüńňǹḿ]', pron or ''):
            suspect.append((mat['file'], word, pron, meaning, '读音格式异常'))
        # 常见多音字检查
        if word in ('说',) and pron and 'yuè' not in pron and 'shuō' not in pron and 'shuì' not in pron:
            suspect.append((mat['file'], word, pron, meaning, '说读音异常'))
        if word in ('乐',) and pron and not any(p in pron for p in ['yuè','lè','yào']):
            suspect.append((mat['file'], word, pron, meaning, '乐读音异常'))
        if word in ('乘',) and pron and 'shèng' not in pron and 'chéng' not in pron:
            suspect.append((mat['file'], word, pron, meaning, '乘读音异常'))
        if word in ('省',) and pron and 'xǐng' not in pron and 'shěng' not in pron:
            suspect.append((mat['file'], word, pron, meaning, '省读音异常'))

print(f'读音表嫌疑 {len(suspect)} 条:')
for s in suspect[:40]:
    print(s)

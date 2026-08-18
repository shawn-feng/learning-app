# -*- coding: utf-8 -*-
"""修正 html 文件：删除多余子曰、错字修正"""
import os

MATERIALS = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"

# html 修正：删除子曰（不带 ### 前缀）
html_fixes = {
    '论语乡党篇第七章': [
        ('<div class="original-text">子曰：“齐，必有明衣，布。齐必变食，居必迁坐。”', '<div class="original-text">齐，必有明衣，布。齐必变食，居必迁坐。'),
    ],
    '论语乡党篇第二十四章': [
        ('<div class="original-text">子曰：“寝不尸，居不容①。”', '<div class="original-text">寝不尸，居不容。'),
    ],
    '论语先进篇第三章': [
        ('<div class="original-text">子曰：“德行：颜渊、闵子骞、冉伯牛、仲弓。言语：宰我、子贡。政事：冉有、季路。文学：子游、子夏。”', '<div class="original-text">德行：颜渊、闵子骞、冉伯牛、仲弓。言语：宰我、子贡。政事：冉有、季路。文学：子游、子夏。'),
    ],
    '论语述而篇第九章': [
        ('<div class="original-text">子曰：“子食于有丧者之侧，未尝饱也。”', '<div class="original-text">子食于有丧者之侧，未尝饱也。'),
    ],
    '论语述而篇第四章': [
        ('<div class="original-text">子曰：“子之燕居，申申如也；夭夭如也。”', '<div class="original-text">子之燕居，申申如也；夭夭如也。'),
    ],
    '论语雍也篇第二十八章': [
        ('<div class="original-text">子曰：“子见南子，子路不说。夫子矢之曰：', '<div class="original-text">子见南子，子路不说。夫子矢之曰：'),
    ],
    '论语季氏篇第十一章': [
        ('<div class="original-text">子曰：“见善如不及，见不善如探汤。', '<div class="original-text">孔子曰：“见善如不及，见不善如探汤。'),
    ],
}

for name, reps in html_fixes.items():
    html = os.path.join(MATERIALS, f'{name}.html')
    if not os.path.exists(html):
        print(f'  文件不存在: {name}.html')
        continue
    with open(html, encoding='utf-8') as f:
        h = f.read()
    oh = h
    for old, new in reps:
        if old in h:
            h = h.replace(old, new)
            print(f'  ✓ {name}.html: 替换成功')
        else:
            print(f'  ✗ {name}.html: 未找到 "{old[:40]}"')
    if h != oh:
        with open(html, 'w', encoding='utf-8') as f:
            f.write(h)

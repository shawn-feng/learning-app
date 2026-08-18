# -*- coding: utf-8 -*-
"""批量修正翻译审读发现的明确字符串错误（A类：错别字、朝代、读音、国籍）"""
import io, os

MAT = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"

# 每项：(文件名, [(旧串, 新串), ...])，md 和 html 同步
fixes = {
    '论语公冶长篇第十九章': [
        ('| 陈文子 | chén wén zǐ | 陈国大夫，名须无。', '| 陈文子 | chén wén zǐ | 齐国大夫，名须无（陈为氏，非国名）。'),
    ],
    '论语雍也篇第十九章': [
        ('在周朝有一个叫周处的人', '在东吴末年有一个叫周处的人'),
    ],
    '论语阳货篇第三章': [
        ('东晋时期，有一个人名叫周处', '西晋时期，有一个人名叫周处'),
    ],
    '论语阳货篇第二十六章': [
        ('在东晋时期，有一个人叫周处', '在西晋时期，有一个人叫周处'),
    ],
    '论语子路篇第一章': [
        ('身体也不要偷懒松解', '身体也不要偷懒松懈'),
    ],
    '论语阳货篇第十四章': [
        ('没有经过证j实就去传播', '没有经过证实就去传播'),
    ],
    '论语卫灵公篇第十一章': [
        ('戴上周期大方好看的礼帽', '戴上周期大方好看的礼帽'.replace('周期','周朝')),
    ],
    '论语宪问篇第十二章': [
        ('鲁国有一个叫季札的人，他是吴国国君的儿子', '吴国有一个叫季札的人，他是吴国国君的儿子'),
    ],
    '论语阳货篇第二十五章': [
        ('| 女 | rǔ | 同“汝”，你 |', '| 女 | nǚ | 女子、女人 |'),
        ('| 女 | rǔ | 同"汝"，你 |', '| 女 | nǚ | 女子、女人 |'),
    ],
}

count = 0
for name, reps in fixes.items():
    for ext in ['.md', '.html']:
        p = os.path.join(MAT, name + ext)
        if not os.path.exists(p):
            continue
        with io.open(p, encoding='utf-8') as f:
            t = f.read()
        orig = t
        for old, new in reps:
            if old in t:
                t = t.replace(old, new)
        if t != orig:
            with io.open(p, 'w', encoding='utf-8') as f:
                f.write(t)
            count += 1
            print(f'✓ {name}{ext}')

print(f'\n共修正 {count} 个文件')

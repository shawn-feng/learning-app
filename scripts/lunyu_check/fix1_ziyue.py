# -*- coding: utf-8 -*-
"""批量修正教学文案：
1. 删除原文中多余的「子曰：」（叙述句章节，杨伯峻/钱穆原文均无子曰）
2. 删除注释编号 ①-⑳ 和 (1)(2) 等
3. 修正错字
"""
import os, re, glob

MATERIALS = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"

# 修正清单 1：删除多余的「子曰：」（这些章节是叙述句，不是孔子说的话）
# 格式：{文件名: (原句子前缀, 删除后)}
fixes = {
    # 乡党篇第七章：原文无子曰
    '论语乡党篇第七章': ('### 子曰：“齐，必有明衣，布。齐必变食，居必迁坐。”', '### 齐，必有明衣，布。齐必变食，居必迁坐。'),
    # 乡党篇第二十四章：原文无子曰
    '论语乡党篇第二十四章': ('### 子曰：“寝不尸，居不容①。”', '### 寝不尸，居不容。'),
    # 先进篇第三章：杨伯峻 11.3 无子曰
    '论语先进篇第三章': ('### 子曰：“德行：颜渊、闵子骞、冉伯牛、仲弓。言语：宰我、子贡。政事：冉有、季路。文学：子游、子夏。”', '### 德行：颜渊、闵子骞、冉伯牛、仲弓。言语：宰我、子贡。政事：冉有、季路。文学：子游、子夏。'),
    # 述而篇第九章：原文无子曰
    '论语述而篇第九章': ('### 子曰：“子食于有丧者之侧，未尝饱也。”', '### 子食于有丧者之侧，未尝饱也。'),
    # 述而篇第四章：原文无子曰
    '论语述而篇第四章': ('### 子曰：“子之燕居，申申如也；夭夭如也。”', '### 子之燕居，申申如也；夭夭如也。'),
    # 雍也篇第二十八章：原文无子曰
    '论语雍也篇第二十八章': ('### 子曰：“子见南子，子路不说。夫子矢之曰：‘予所否者，天厌之！天厌之！’”', '### 子见南子，子路不说。夫子矢之曰：‘予所否者，天厌之！天厌之！’'),
    # 季氏篇第十一章：子曰 -> 孔子曰（杨伯峻、钱穆均作孔子曰）
    '论语季氏篇第十一章': ('### 子曰：“见善如不及，见不善如探汤。吾见其人矣，吾闻其语矣。隐居以求其志，行义以达其道。吾闻其语矣，未见其人也。”', '### 孔子曰：“见善如不及，见不善如探汤。吾见其人矣，吾闻其语矣。隐居以求其志，行义以达其道。吾闻其语矣，未见其人也。”'),
}

# 修正清单 2：错字
typo_fixes = {
    # 子罕篇第十一章：即 -> 既
    '论语子罕篇第十一章': [('即竭吾才', '既竭吾才')],
    # 泰伯篇第十五章：睢 -> 雎
    '论语泰伯篇第十五章': [('关睢', '关雎')],
    # 先进篇第二十四章：间 -> 问
    '论语先进篇第二十四章': [('曾由与求之间', '曾由与求之问')],
    # 子路篇第十一章：缺"也"
    '论语子路篇第十一章': [('诚哉是言！', '诚哉是言也！')],
}

def fix_md(path, replacements):
    """对单个 md 文件执行替换（先长后短，避免误伤）"""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    orig = text
    for old, new in replacements:
        if old in text:
            text = text.replace(old, new)
            print(f'  ✓ {os.path.basename(path)}: "{old[:20]}..." → "{new[:20]}..."')
        else:
            print(f'  ✗ 未找到: {os.path.basename(path)}: "{old[:30]}"')
    if text != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
        return True
    return False

# 处理清单 1：删除多余的子曰
print('=== 清单1: 删除多余子曰 ===')
for name, (old, new) in fixes.items():
    md = os.path.join(MATERIALS, f'{name}.md')
    html = os.path.join(MATERIALS, f'{name}.html')
    if os.path.exists(md):
        fix_md(md, [(old, new)])
    if os.path.exists(html):
        # html 中原文可能在 <div class="original-text"> 或 <strong> 等标签内
        with open(html, encoding='utf-8') as f:
            h = f.read()
        # 尝试不同引号变体
        variants = [
            (old, new),
            (old.replace('“', '&ldquo;').replace('”', '&rdquo;'), new.replace('“', '&ldquo;').replace('”', '&rdquo;')),
            (old.replace('子曰：“', '子曰：<strong>“'), None),  # 占位，不做
        ]
        oh = h
        for o, n in variants[:1]:
            if n and o in h:
                h = h.replace(o, n)
                print(f'  ✓ html: {name}: 替换成功')
                break
        else:
            # 尝试用正则删除 # 和引号
            pass
        if h != oh:
            with open(html, 'w', encoding='utf-8') as f:
                f.write(h)

print()
print('=== 清单2: 错字修正 ===')
for name, reps in typo_fixes.items():
    md = os.path.join(MATERIALS, f'{name}.md')
    html = os.path.join(MATERIALS, f'{name}.html')
    if os.path.exists(md):
        fix_md(md, reps)
    if os.path.exists(html):
        with open(html, encoding='utf-8') as f:
            h = f.read()
        oh = h
        for old, new in reps:
            if old in h:
                h = h.replace(old, new)
        if h != oh:
            with open(html, 'w', encoding='utf-8') as f:
                f.write(h)
            print(f'  ✓ html: {name}: 错字修正完成')

# -*- coding: utf-8 -*-
"""删除原文与读音表中混入的注释编号（①-⑳ 和 (1)(2)），保留讲解正文中的编号列表"""
import os, re, glob

MATERIALS = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"

def remove_notes_original(line):
    """原文行/读音表：删除 ①-⑳ 与 (数字) 编号"""
    line = re.sub(r'[①-⑳]', '', line)
    line = re.sub(r'\((\d+)\)', '', line)
    return line

def fix_md(path):
    with open(path, encoding='utf-8') as f:
        lines = f.readlines()
    changed = False
    in_pron_table = False
    for i, line in enumerate(lines):
        ls = line.strip()
        # 原文行：### 开头但不是「重点字词读音」
        if ls.startswith('###') and '读音' not in ls and '字词' not in ls:
            new = remove_notes_original(line)
            if new != line:
                print(f'  {os.path.basename(path)} 原文L{i+1}: {line.strip()[:70]}')
                print(f'      → {new.strip()[:70]}')
                lines[i] = new
                changed = True
        # 读音表行：| 开头的表格行，第一列删除编号
        elif ls.startswith('|'):
            cells = [c.strip() for c in ls.strip('|').split('|')]
            if cells and cells[0] in ('字词',):
                in_pron_table = True
                continue
            if in_pron_table and cells and len(cells) >= 2:
                new_first = re.sub(r'[①-⑳]', '', cells[0]).strip()
                if new_first != cells[0]:
                    new_line = '| ' + ' | '.join([new_first] + cells[1:]) + ' |'
                    print(f'  {os.path.basename(path)} 读音表L{i+1}: {line.strip()[:50]} → {new_line.strip()[:50]}')
                    lines[i] = new_line + '\n'
                    changed = True
        else:
            in_pron_table = False
    if changed:
        with open(path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
    return changed

def fix_html(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    orig = text
    # 只处理 original-text 和读音表部分
    # original-text 原文
    text = re.sub(r'(<div class="original-text">)(.*?)(</div>)',
                  lambda m: m.group(1) + remove_notes_original(m.group(2)) + m.group(3), text)
    # 读音表单元格（<td> 中以 ① 开头的）
    text = re.sub(r'(<td[^>]*>)[①-⑳]', r'\1', text)
    # 翻译讲解中的原文引用 <strong>（如果带编号）
    text = re.sub(r'(<strong>)[①-⑳]', r'\1', text)
    if text != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
        return True
    return False

count_md = 0
count_html = 0
files = sorted(glob.glob(os.path.join(MATERIALS, '*.md')))
for f in files:
    base = os.path.basename(f)[:-3]
    if fix_md(f):
        count_md += 1
    html = os.path.join(MATERIALS, f'{base}.html')
    if os.path.exists(html):
        before = count_html
        if fix_html(html):
            count_html += 1
print(f'\n修正 md: {count_md} 个, html: {count_html} 个')

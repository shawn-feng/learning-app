# -*- coding: utf-8 -*-
"""提取教学文案的原文/读音/翻译，输出 JSON 便于对照检查"""
import os, re, json, glob

MATERIALS = r"C:/Users/79734/Documents/pi/data/children/1f050a7f-df8a-45b0-925a-1ffe2aa35674/learning/lunyu/materials"

def parse_md(path):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    result = {
        'file': os.path.basename(path),
        'title': None, 'frontmatter': {},
        'original': None,      # 原文句子（### 后第一句非标题行）
        'pron_table': [],      # 读音表
        'translation': [],     # 翻译讲解句子
        'meaning': None,       # 释义
        'life_examples': [],   # 生活例子
        'story': None,         # 历史典故故事
    }
    # frontmatter
    m = re.match(r'^---\n(.*?)\n---\n', text, re.S)
    if m:
        fm = m.group(1)
        for line in fm.split('\n'):
            if ':' in line and not line.startswith('-') and not line.startswith('#'):
                k, v = line.split(':', 1)
                result['frontmatter'][k.strip()] = v.strip()
        text = text[m.end():]
    # 标题
    m = re.search(r'^# (.+)$', text, re.M)
    if m:
        result['title'] = m.group(1).strip()
    # 原文：找"原文吟诵"章节下的 ### 行（不含"重点字词读音"）
    lines = text.split('\n')
    in_section = False
    for i, line in enumerate(lines):
        ls = line.strip()
        if ls.startswith('## '):
            in_section = ('原文吟诵' in ls)
            continue
        if in_section and ls.startswith('###') and '读音' not in ls and '字词' not in ls:
            result['original'] = ls.lstrip('#').strip()
            break
    # 读音表
    for i, line in enumerate(lines):
        if line.strip() == '## 重点字词读音' or line.strip() == '### 重点字词读音':
            j = i + 1
            rows = []
            while j < len(lines) and not lines[j].strip().startswith('##'):
                ls = lines[j].strip()
                if ls.startswith('|') and not re.match(r'^\|[\s:|-]+\|$', ls):
                    cells = [c.strip() for c in ls.strip('|').split('|')]
                    if cells and cells[0] not in ('字词',):
                        rows.append(cells[:3])
                j += 1
            result['pron_table'] = rows
            break
    # 翻译
    sec = re.search(r'## 白话翻译讲解\n(.*?)(?=## 道理应用讲解)', text, re.S)
    if sec:
        body = sec.group(1)
        cur = None
        for line in body.split('\n'):
            line = line.strip()
            if not line:
                continue
            if line.startswith('**'):
                # 原句小标题
                cur = line.strip('*').strip()
                result['translation'].append({'orig': cur, 'trans': ''})
            elif line.startswith('*') and cur:
                t = line.lstrip('*').strip()
                if result['translation']:
                    result['translation'][-1]['trans'] = t
    # 释义
    m = re.search(r'\*\*释义\*\*\n(.*?)(?=\n\*\*生活例子|\n\*\*历史典故|\Z)', text, re.S)
    if m:
        result['meaning'] = m.group(1).strip()
    # 生活例子
    sec = re.search(r'\*\*生活例子\*\*\n(.*?)(?=\n\*\*历史典故|\Z)', text, re.S)
    if sec:
        for line in sec.group(1).split('\n'):
            line = line.strip()
            if line.startswith('*') or line.startswith('-') or line.startswith('1.') or line.startswith('2.') or line.startswith('3.'):
                result['life_examples'].append(line.lstrip('*- ').strip())
    # 故事
    m = re.search(r'\*\*故事\*\*：?(.*?)(?=\n\*\*道理总结|\Z)', text, re.S)
    if m:
        result['story'] = m.group(1).strip()
    return result

def main():
    out = []
    for f in sorted(glob.glob(os.path.join(MATERIALS, '*.md'))):
        out.append(parse_md(f))
    with open('C:/Users/79734/Documents/pi/scripts/lunyu_check/materials_extracted.json', 'w', encoding='utf-8') as fp:
        json.dump(out, fp, ensure_ascii=False, indent=1)
    print(f'共提取 {len(out)} 篇')
    # 统计：有多少没有原文
    no_orig = [r for r in out if not r['original']]
    print(f'无原文 {len(no_orig)} 篇:', [r['file'] for r in no_orig][:20])
    no_pron = [r for r in out if not r['pron_table']]
    print(f'无读音表 {len(no_pron)} 篇:', [r['file'] for r in no_pron][:20])
    no_trans = [r for r in out if not r['translation']]
    print(f'无翻译 {len(no_trans)} 篇:', [r['file'] for r in no_trans][:20])
    no_story = [r for r in out if not r['story']]
    print(f'无典故 {len(no_story)} 篇:', [r['file'] for r in no_story][:20])

if __name__ == '__main__':
    main()

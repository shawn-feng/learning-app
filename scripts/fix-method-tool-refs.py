# -*- coding: utf-8 -*-
# 一次性/可重复：把家长库 8 个主题 method 里的「参数级工具调用示例」与「文件读取旧指引」清理掉，
# 遵循分层原则：工具描述 = 怎么调（唯一真源）；method = 教学协议 + 「用哪个工具做什么」。
# 教学文案读取 → parent_content；display_content 路径 → 家长库相对路径；kb JSON 示例 → 语义描述。
import sqlite3, re, shutil, sys

DB = r"data/parents/default/parent.sqlite"
shutil.copyfile(DB, DB + ".bak-dedup")
conn = sqlite3.connect(DB)
rows = conn.execute("SELECT name, method FROM topics").fetchall()


def s1(text: str) -> str:
    """kb_update JSON 参数示例 → 语义描述（topic 目录名随主题不同，用正则抓）。"""
    return re.sub(
        r"1\. 更新进度用 `kb_update`（禁止 write/edit 裸写）：`\{table:\"course\", topic:\"[a-z]+\", item:\"<课程名>\", field:\"状态\", value:\"✅\"\}` 等——条目字段 `状态`→✅、`掌握度`、`首次学习`、`最近复习`（字段缺失自动追加）；learned/total/next/updated 由系统自动计算（视图），\*\*不要手动更新\*\*。示例：`kb_update \{table:\"course\", topic:\"<主题目录名>\", item:\"<课程名>\", field:\"掌握度\", value:\"熟练\"\}`",
        "1. 用 kb_update 更新该课进度（table 用 course：topic 传主题目录名、item 传课程名、field 传 `状态`/`掌握度`/`首次学习`/`最近复习`、value 传对应值；字段缺失自动追加）；learned/total/next/updated 由视图自动计算，**不要手动更新**。",
        text,
    )


def s2(text: str) -> str:
    """kb_insert JSON 参数示例 → 语义描述（保留各主题「逐字段详写…」尾巴）。"""
    return re.sub(
        r"2\. 写 daily「学习」记录用 `kb_insert`（禁止 write/edit）：`\{table:\"daily\", date:\"\{今天日期 YYYY-MM-DD\}\", block:\"学习\", content:\"[^\"]*\"\}`——以 `### 课程名` 为标题，逐字段详写(.*)$",
        lambda m: "2. 用 kb_insert 写入当日「学习」记录（table 用 daily：date 取当前日期、block 用 \"学习\"、content 以 `### 课程名` 为标题并直接使用已发给孩子的学习总结原文），逐字段详写"
        + m.group(1),
        text,
        flags=re.M,
    )


def s_read_md(text: str, topic_dir: str) -> str:
    """「先读 learning/<dir>/materials/{课程名}.md」→ parent_content teachingCopy（国学四课模板）。"""
    return re.sub(
        rf"先读 `learning/{topic_dir}/materials/{{课程名}}\.md`（\*\*文件名与课程名完全同名\*\*，如课程名 `[^`]+` → `learning/{topic_dir}/materials/[^`]+\.md`），以(?:文案|markdown 文案)内容为基础引导学习，不自己编教学内容。",
        '用 parent_content 获取该课教学文案（type:"teachingCopy"，topic 传主题目录名、course 传课程名），以文案内容为基础引导学习，不自己编教学内容。',
        text,
    )


def s_notes_materials(text: str) -> str:
    """注意事项/注意里「以 materials/ 的 markdown 为准/回答」→ parent_content。"""
    text = re.sub(r"优先以 materials/ 里的 markdown 内容回答，不自由发挥", "优先以 parent_content 取到的教学文案回答，不自由发挥", text)
    text = re.sub(r"以 materials/ 的 markdown 为准，不凭印象发挥", "以 parent_content 取到的教学文案为准，不凭印象发挥", text)
    return text


def s_tags_file(text: str) -> str:
    """「打开 tags/{tag}.md 找生活事件」→ kb_query 按标签查（数据已入库）。"""
    text = re.sub(r"用课程 tags 打开 tags/\{tag\}\.md 找相关生活事件，结合讲解", '用 kb_query（query:"daily", tag:"<标签>"）查相关生活事件，结合讲解', text)
    text = re.sub(r"可结合该课 tags 打开 tags/\{tag\}\.md 找相关生活事件举例", '可结合该课标签用 kb_query（query:"daily", tag:"<标签>"）找生活事件举例', text)
    return text


def pass2(text: str) -> str:
    """第二轮去重：method 只描述「用什么工具、取/更新什么东西」，删掉全部调用参数脚手架。"""
    # kb_update：只留领域字段（状态/掌握度/首次学习/最近复习），删 table/topic/item/field/value 参数
    text = re.sub(
        r"用 kb_update 更新该课进度（table 用 course：topic 传主题目录名、item 传课程名、field 传 `状态`/`掌握度`/`首次学习`/`最近复习`、value 传对应值；字段缺失自动追加）",
        "用 kb_update 更新该课进度：状态→✅、掌握度、首次学习、最近复习（字段缺失自动追加）",
        text,
    )
    # kb_insert：删 table/date/block/content 参数，保留「### 标题 + 原文」领域语义
    text = re.sub(
        r'用 kb_insert 写入当日「学习」记录（table 用 daily：date 取当前日期、block 用 "学习"、content 以 `### 课程名` 为标题并直接使用已发给孩子的学习总结原文）',
        "用 kb_insert 写入当日「学习」记录（以 `### 课程名` 为标题、直接使用已发给孩子的学习总结原文）",
        text,
    )
    # parent_content teachingCopy：删参数括号
    text = re.sub(r'（type:"teachingCopy"，topic[^）]*）', "", text)
    # kb_query 按标签查：删参数括号
    text = text.replace('用 kb_query（query:"daily", tag:"<标签>"）查相关生活事件', "用 kb_query 查相关生活事件")
    text = text.replace('用 kb_query（query:"daily", tag:"<标签>"）找生活事件举例', "用 kb_query 找生活事件举例")
    # 论语 display htmlPath：删参数
    text = re.sub(r'（path 用家长库相对路径 `materials/lunyu/\{课程名\}\.html`，可先用 parent_content \{type:"htmlPath", topic:"lunyu", course:"<课程名>"\} 获取）', "（html 资料路径可先用 parent_content 获取）", text)
    text = text.replace("用 display_content 展示学习资料：优先 `materials/lunyu/{课程名}.html`（预生成的含音频资料，家长库相对路径）；", "用 display_content 展示学习资料（预生成的含音频资料）；")
    return text


TRANSFORMS = {
    "千字文": lambda t: s_notes_materials(s_tags_file(s_read_md(s2(s1(t)), "qianziwen"))),
    "孝经": lambda t: s_notes_materials(s_tags_file(s_read_md(s2(s1(t)), "xiaojing"))),
    "论语": lambda t: s_notes_materials(s_tags_file(s2(s1(t))))
    .replace(
        "先读教学文案 `learning/lunyu/materials/{课程名}.md`（**文件名与课程名完全同名**，如课程名 `论语先进篇第十四章` → `learning/lunyu/materials/论语先进篇第十四章.md`），以 markdown 文案为基础引导学习，不自己编教学内容。",
        '用 parent_content 获取该课教学文案（type:"teachingCopy"，topic:"lunyu"，course 传课程名），以文案内容为基础引导学习，不自己编教学内容。',
    )
    .replace(
        '引导时用 `display_content(path="learning/lunyu/materials/{课程名}.html")` 把预生成的 html 资料展示给孩子',
        '引导时用 display_content 展示预生成的 html 学习资料（path 用家长库相对路径 `materials/lunyu/{课程名}.html`，可先用 parent_content {type:"htmlPath", topic:"lunyu", course:"<课程名>"} 获取）',
    )
    .replace(
        '用 display_content 工具展示学习资料：优先 `display_content(path="learning/lunyu/materials/{课程名}.html")`（预生成的含音频资料）；',
        "用 display_content 展示学习资料：优先 `materials/lunyu/{课程名}.html`（预生成的含音频资料，家长库相对路径）；",
    ),
    "小篆": lambda t: s_notes_materials(s_tags_file(s2(s1(t))))
    .replace(
        "读 `learning/xiaozhuan/materials/{课程名}.md`（**文件名与课程名完全同名**，如课程名 `篆书第3课` → `learning/xiaozhuan/materials/篆书第3课.md`）",
        '用 parent_content 获取该课教学文案（type:"teachingCopy"，topic:"xiaozhuan"，course 传课程名）',
    )
    .replace("没指明课次但主题明确 → 读 materials/ 的索引（INDEX.md/index.md）定位", "没指明课次但主题明确 → 用 kb_query 查看该主题课程清单定位（不要读索引文件）")
    .replace("1. 读 materials/ 对应课，确认核心知识点", "1. 用 parent_content 获取对应课教学文案，确认核心知识点"),
    "陶笛": lambda t: s_notes_materials(s_tags_file(s2(s1(t))))
    .replace(
        "读 `learning/taodi/materials/{课程名}.md`（**文件名与课程名完全同名**，如课程名 `陶笛第8课` → `learning/taodi/materials/陶笛第8课.md`）",
        '用 parent_content 获取该课教学文案（type:"teachingCopy"，topic:"taodi"，course 传课程名）',
    )
    .replace("没指明课次但主题明确 → 读 materials/ 的索引（INDEX.md/index.md）定位", "没指明课次但主题明确 → 用 kb_query 查看该主题课程清单定位（不要读索引文件）")
    .replace("1. 读 materials/ 对应课，确认核心知识点", "1. 用 parent_content 获取对应课教学文案，确认核心知识点"),
    "春风阅读": lambda t: s2(s1(t))
    .replace("严格按照 learning/reading/reading.md 的顺序逐篇阅读，不让孩子选。", "严格按系统计算的 next 顺序逐篇阅读，不让孩子选。")
    .replace(
        "先读 `learning/reading/materials/{篇名}.md`（**去掉课程名的 `春风·` 前缀**，如课程名 `春风·白色的石桥` → `learning/reading/materials/白色的石桥.md`），以文章原文为基础，不自己编内容",
        '用 parent_content 获取该篇教学文案（type:"teachingCopy"，topic:"reading"，course 传课程名），以文章原文为基础，不自己编内容',
    ),
    "英语": lambda t: s2(s1(t)).replace(
        "先读 `learning/english/materials/{课号}-{课名}.md`（**课程名的 `·` 换成 `-`**，如课程名 `11·基础语法模块` → `learning/english/materials/11-基础语法模块.md`），以文案为基础引导学习，不自己编教学内容",
        '用 parent_content 获取该课教学文案（type:"teachingCopy"，topic:"english"，course 传课程名），以文案为基础引导学习，不自己编教学内容',
    ),
    "汉字宫": lambda t: s2(s1(t)),  # 索引 md + 字卡 html 页面属内容文件流程，保留；仅清理 kb JSON 示例
}

# 统一套 pass2（第二轮去参数），无论从原始文本还是第一轮后的中间态执行，最终态一致（幂等）。
TRANSFORMS = {k: (lambda f: (lambda t: pass2(f(t))))(v) for k, v in TRANSFORMS.items()}

changed = []
for name, method in rows:
    fn = TRANSFORMS.get(name)
    if not fn:
        continue
    new_m = fn(method)
    if new_m != method:
        conn.execute("UPDATE topics SET method = ? WHERE name = ?", (new_m, name))
        changed.append(name)
        print(f"[{name}] {len(method)} -> {len(new_m)} chars (delta {len(new_m) - len(method)})")
    else:
        print(f"[{name}] 无变化")

conn.commit()
conn.close()
print("已更新:", ", ".join(changed) or "(无)")

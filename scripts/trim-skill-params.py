# -*- coding: utf-8 -*-
# 按同一原则清理 recording 技能 SKILL.md 里的调用参数脚手架（保留领域语义与规则）。
import io

P = r"data/shared/skills/recording/SKILL.md"
text = io.open(P, encoding="utf-8").read()
before = text

REPL = [
    (
        "1. 用 kb_update 更新对应课程状态（table 用 \"course\"、item 传课程名、field 传 `状态`、value 传 `✅`）；掌握度、复习次数、首次学习、最近复习、教学资料、学习资料、tags 等字段同样用 kb_update（字段缺失自动追加）。**复习次数自动递增：field 传 复习次数、value 传 \"+1\"。**",
        "1. 用 kb_update 更新对应课程状态（状态→✅），掌握度、复习次数、首次学习、最近复习、教学资料、学习资料、tags 等字段同样用 kb_update（字段缺失自动追加）。**复习次数用 \"+1\" 自动递增。**",
    ),
    (
        '用 kb_insert 写入当日「学习」区块（table 用 "daily"、block 用 "学习"；content 按下方「详情格式」逐条详写、`### 课程名` 开头）',
        "用 kb_insert 写入当日「学习」区块（content 按下方「详情格式」逐条详写、`### 课程名` 开头）",
    ),
    (
        '用 kb_insert 写入当日「生活」区块（table 用 "daily"、block 用 "生活"；按下方「详情格式」详写概要）',
        "用 kb_insert 写入当日「生活」区块（按下方「详情格式」详写概要）",
    ),
    (
        "**打标签（必做）**：先 kb_query 查**标签定义表**（query 用 \"tags\"，含判断标准：什么类型的事件打这个标签）",
        "**打标签（必做）**：先 kb_query 查**标签定义表**（含判断标准：什么类型的事件打这个标签）",
    ),
    (
        "（kb_query 按 tag 反查生活事件）与课程上（kb_update 的 course 类型、field 用 \"tags\"）",
        "（kb_query 按标签反查生活事件）与课程上（kb_update 更新课程标签）",
    ),
    (
        '用 kb_insert 写入当日「问答」区块（table 用 "daily"、block 用 "问答"；详写：孩子的疑问/引导过程/结论）',
        "用 kb_insert 写入当日「问答」区块（详写：孩子的疑问/引导过程/结论）",
    ),
    (
        '用 kb_insert 写入当日「任务」区块（table 用 "daily"、block 用 "任务"；需求/过程/产物/状态）',
        "用 kb_insert 写入当日「任务」区块（需求/过程/产物/状态）",
    ),
    (
        '3. 完成时用 kb_update 更新该条目状态（table 用 "daily"、block 用 "任务"、title 定位、field 用 "状态"、value 用 "done"）。',
        "3. 完成时用 kb_update 更新该条目状态（状态→done）。",
    ),
    (
        "* 新增 daily 条目用 kb_insert（table:\"daily\"，date 取当前日期，block 学习/生活/问答/任务，content 直接用已在回复中输出给孩子的学习总结原文，`### 标题` 开头 + 字段行；同主键已存在时不重复写入）",
        "* 新增 daily 条目用 kb_insert（date 取当前日期、block 学习/生活/问答/任务、content 直接用已在回复中输出给孩子的学习总结原文，`### 标题` 开头 + 字段行；同主键已存在时不重复写入）",
    ),
    (
        "* 更新字段用 kb_update（daily 定位用 date + block + title；course 用 topic + item 课程名；field 支持 状态/掌握状态/掌握度/首次学习/最近复习/复习时间/上次复习/复习次数/教学资料/学习资料/tags；无需知道旧值，字段缺失自动追加；**learned/next/updated 视图自动计算，不要手动更新**）",
        "* 更新字段用 kb_update（daily 定位用 date + block + title；course 按课程名定位；可更新字段：状态/掌握状态/掌握度/首次学习/最近复习/复习时间/上次复习/复习次数/教学资料/学习资料/tags；无需知道旧值，字段缺失自动追加；**learned/next/updated 视图自动计算，不要手动更新**）",
    ),
    (
        "* 查询用 kb_query（daily 按 date/month/block/tag/listOnly 过滤反查；progress 按 topic/tag/listOnly；tags 查标签定义；topics 查主题清单与进度摘要）",
        "* 查询用 kb_query（daily 按日期/月份/区块/标签反查；progress 查主题进度；tags 查标签定义；topics 查主题清单与进度摘要）",
    ),
    (
        "打标签前先 kb_query 查（query 用 \"tags\"）。",
        "打标签前先 kb_query 查标签定义表。",
    ),
    (
        "* 打标签只能从标签定义表选（kb_query 查 \"tags\"），不能自创；无法归类时不打或与家长确认",
        "* 打标签只能从标签定义表选（kb_query 查标签定义表），不能自创；无法归类时不打或与家长确认",
    ),
    (
        "字段说明：",
        "字段说明：",
    ),  # no-op placeholder kept for clarity
]

for old, new in REPL:
    if old == new:
        continue
    if old in text:
        text = text.replace(old, new)
    else:
        print("!! 未匹配:", old[:60])

io.open(P, "w", encoding="utf-8").write(text)
print(f"recording SKILL.md: {len(before)} -> {len(text)} chars (delta {len(text) - len(before)})")

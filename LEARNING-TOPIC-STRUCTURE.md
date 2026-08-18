# 学习主题目录结构规范

> 定义「学习主题包」的标准目录结构。每个学习主题（论语、千字文、英语…）是一个**自包含的目录**，含教学文案、音视频、教学方法、进度文件。主题文件**不随 app 打包**，由家长或服务端**额外下载**放入学习目录。以后新增 / 下载的学习主题文件**必须遵守本规范**，app 才能正确读取进度、文案与音视频。

---

## 教学内容来源

**教学内容（method.md 的教学方法 + materials/ 的教学文案）由家长提供，不由 app 内置、也不用脚本硬编码生成。**

- 家长在**家长模式**下手动提供 / 编辑；
- 或通过 **AI 对话**辅助生成（类似技能机制：家长描述需求，AI 帮忙写 method 与文案）；
- html 学习资料（给孩子看的展示版）由 **AI 灵活生成**，见「六」。

## 一、主题包位置

主题包放在孩子学习目录下：

```
data/children/{childId}/learning/{topic}/
```

- dev 模式 `data/` 为项目根目录的 `data/`；
- 打包后为 `userData/app-data/`。

## 二、标准目录结构

```
learning/{topic}/
├── {topic}.md         # 主题进度文件（frontmatter: learned/total/next/updated + 每课 ### 课程名 + 状态）
├── method.md          # 该主题的教学方法
├── materials/         # 教学文案（给孩子看）
│   ├── {课程名}.md     # markdown 文案（原始，agent 可读）
│   └── {课程名}.html   # 预生成 HTML 资料（含音视频引用，由 generate-lessons.mjs 生成）
└── media/             # 音视频媒体（本主题专用，固定位置）
    └── {课程名}.mp3 / .mp4
```

## 三、命名规则

| 项 | 规则 | 示例 |
|----|------|------|
| 主题目录名 | 主题英文 key（topic） | `lunyu` / `qianziwen` / `english` |
| 进度文件 | `{topic}.md`，放主题目录下 | `learning/lunyu/lunyu.md` |
| 音视频文件 | `{课程名}.{ext}`，**文件名与进度文件 `###` 课程名逐字一致** | `论语先进篇第十三章.mp3` |
| 预生成 html | `{课程名}.html`，与 markdown 文案同名 | `论语先进篇第十三章.html` |

## 四、音视频引用

预生成的 html 里引用本主题音视频，用**固定 URL 格式**：

```
media://local/{childId}/learning/{topic}/media/{课程名}.{ext}
```

由 app 主进程的 `media://` 协议解析到本主题 `media/` 目录下的实际文件。

**音视频只能放在本主题的 `media/` 目录下，不要放到别的地方。**

## 五、打包与下载约定

- app 安装包**不含**任何学习主题文件（文案、音视频、method、进度）。
- 主题包由家长 / 服务端**额外下载**，放入 `data/children/{childId}/learning/{topic}/`。
- 下载后目录结构必须与本规范一致，app 才能正确读取进度、文案与音视频。

## 六、html 学习资料的生成

每个主题的教学文案结构不同，**没有通用脚本**能把所有主题的 markdown 转 html。html 由 AI 灵活处理：

1. **手工生成**：AI 读 markdown 文案后，现场用 `display_content` 拼 html 展示给孩子（适合文案结构各异、无共性格式的主题）。
2. **主题专用脚本**：如果某主题的每一课有共同格式（如论语每章都是「原文吟诵 / 白话翻译 / 道理应用」），AI 可针对该主题写一个专用脚本批量转 html（`scripts/generate-lessons.mjs` 就是论语的专用脚本示例）。

音视频始终由家长放进 `media/`，html 里用 `media://` 引用。

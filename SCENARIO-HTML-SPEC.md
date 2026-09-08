# 场景互动 HTML 标准规范（SCENARIO-HTML-SPEC）

> 配套 ISSUE-061「场景化角色扮演」。**本文件定义一份「场景资料」该长什么样、物品/角色有哪些约定属性、这些属性如何被孩子 agent 获取和操作。** 场景 HTML 作者（编程 agent）与宿主（孩子 agent / MaterialsPanel）共同遵守。
> 当前实现范例：`scenario-demo/lesson12-livingroom.html`（客厅打招呼）。

---

## 0. 定位与边界

- 一份场景资料 = **一个自包含 HTML 文件**，只负责「演出」：展示场景、角色、可点物品，播放台词/单词读音，执行动作动画。
- **语音识别、TTS 主链、agent 会话都不在页面里**（在 app 壳/主进程）。页面只收下行指令、发上行事件。
- 页面没有「结束」概念：主线任务完成由聊天区提示，页面永不收尾（不下发 end 类指令）。
- **页面零手动 UI（红线）**：场景页不得内置任何手动控制/演示 UI——操作面板、「播放剧本」按钮、组合表演等一律不允许出现在正式场景页里；演出只能由 agent 经 `scene_command`（scene: 下行指令）驱动。作者调试请用独立副本、宿主下发的 scene 指令，或控制台直调全局 `Scene` API。
- 场景页标记：`<meta name="pi-scenario" content="1">`（宿主据此把 scene_command 指令放行给该页）。
- **场景对话会话（ISSUE-061 v2）**：孩子用场景页语音球（`scene:mic-press` / `scene:mic-release` 上行，宿主负责录音/ASR/保存）说话 → 独立 **scene agent**（专职扮演、独立 prompt，只有 scene_command 一个工具）→ 角色台词作为回复正文进聊天记录并在页面演出。孩子的语音录音由宿主存到该孩子 `voice/scene/<日期>/`，供以后挑选分析/发音评测；对话 jsonl（scene-<课> 子会话目录）是防丢真源，「结束场景对话」时转交给课程 agent 做收尾总结。

---

## 1. 物品（Props）—— 每个可互动物品的属性约定

一个「可点、可被角色操作、可被 agent 谈论」的物品是一个 `div`（或等价元素）：

```html
<div class="prop" id="p-tv" data-word="TV" data-zh="电视机"
     data-phon="/ˌtiːˈviː/" data-attr-color="black">
</div>
```

| 属性 | 必填 | 含义与约束 |
|---|---|---|
| `class="prop"` | ✅ | 声明为可互动物品（宿主据此采集 + 页面统一挂点击） |
| `id="p-<slug>"` | ✅ | slug 用**小写英文、场景内唯一、稳定**（改 HTML 文案不能改它）。slug 是 agent 引用该物品的 id（highlight target、click 上报 target、move 目标名等） |
| `data-word` | ✅ | 英文单词（**点击时自动朗读 + 上抛给 agent**，如 `sofa`/`TV`） |
| `data-zh` | ✅ | 中文名（弹单词卡与上抛用，如 `沙发`） |
| `data-phon` | 推荐 | 音标（单词卡显示，如 `/ˈsəʊfə/`） |
| `data-attr-<名>` | 可选 | **可观察属性**（agent 回答「它是什么颜色/什么形状」的依据）。任意 `data-attr-x="v"` 会被收进清单的 `attrs:{x:"v"}`。示例：`data-attr-color="black"`、`data-attr-shape="rect"` |

物品的默认行为（页面自带，作者不用重复写）：
- 点击 → 弹单词卡（word + 音标 + 中文）+ 朗读 `data-word` + 上抛 `scene:child-click{target:slug, word, zh}`。
- **台词提及自动高亮**：任何 `scene:say` 台词（英文或中文）提到物品的 id / `data-word` / `data-zh` 时，页面自动高亮该物品约 2 秒——作者只需正常写台词，不需要刻意发 highlight。
- 角色登场 `show` 与隐藏、以及点击/朗读语音球，见 §6 上行/下行。

作者约定：
- 一个物品可以被哪些**角色动作**操作，由 `act` 动作表体现（见 §6），不必在物品上重复声明；
- 想让 agent 能描述这个物品，就给足 `data-attr-*`；给不了的内容，agent 不会（也不该）编造。

---

## 2. 角色（Characters）—— 属性约定

每个角色是一个 `div.character`，id 形如 `ch-<id>`：

```html
<div class="character" id="ch-steve" data-word="Steve" data-zh="老师 Steve"></div>
```

| 属性 | 必填 | 含义 |
|---|---|---|
| `id="ch-<id>"` | ✅ | 角色 id（**小写英文、唯一、稳定**）。agent 的 say/move/act/show/highlight 用这个 id |
| `data-word` | ✅ | 角色英文名（点角色读该名） |
| `data-zh` | ✅ | 角色中文称呼 |

角色的身份细节（persona、性格、声线倾向）放 **manifest**（§4），因为 agent 需要的是文本描述而不是 DOM。

---

## 3. 地标（Landmarks）—— 角色常去的点

场景内给常用停留点起**语义名**（供 move 用目标名定位，agent 不必猜像素）：

```js
landmarks: { window: 120, sofa: 320, table: 600, plant: 510, rug: 560, picture: 500, lamp: 760, tv: 1010 }
```

约定：命名与物品 slug 一致（`window` 就是窗前、`sofa` 就是沙发前）。角色 x 也可直接传 10~1120 任意像素。

---

## 4. 场景清单（Manifest）—— 属性的自述与传递

页面就绪时把整场「能互动什么、长什么样」汇总成一个 JSON，暴露到 `window.__PI_SCENE__` 并上抛一次：

```js
window.__PI_SCENE__ = {
  v: 1,
  title: "客厅 living room",
  props: [                                  // 一般从 DOM 自动采集（.prop + data-*）
    { id: "tv",  word: "TV",  zh: "电视机", phon: "/ˌtiːˈviː/", attrs: { color: "black" } },
    { id: "sofa", word: "sofa", zh: "沙发", phon: "/ˈsəʊfə/",  attrs: { color: "brown" } },
    // …
  ],
  characters: [
    { id: "steve", name: "Steve", zh: "老师 Steve", persona: "友善的英语老师，常穿蓝衬衫", voice: "male" },
    { id: "maggie", name: "Maggie", zh: "小老鼠 Maggie", persona: "活泼爱跳舞", voice: "female" },
  ],
  landmarks: { window: 120, sofa: 320, /* … */ },
};
```

| 段 | 内容 | 用途 |
|---|---|---|
| `props[]` | 物品 id/word/zh/phon/attrs | agent 知道有哪些可点物品、可回答外观属性问题 |
| `characters[]` | 角色 id/name/zh/persona/voice | agent 分清角色、按 persona 扮演、将来按 voice 选音色 |
| `landmarks{}` | 语义名 → x | move 的目标名集合 |

**采集方式推荐**：props 从 DOM 自动收集（遍历 `.prop` 读 data-*），保证清单与实际可见物一致；characters/landmarks 在脚本里登记（角色 persona 无 DOM 等价物）。

**agent 如何获得清单**：页面加载后上抛一次
`{ type:"scene:ready", manifest: <上述对象> }`
→ 宿主把它拼成一句中文摘要（物品名+属性、角色、可点说明），作为一条页面事件随**孩子下一轮消息**附带注入 agent（不入环形缓冲、不实时打断）。此后孩子问「电视是什么颜色」agent 就有据可答。

---

## 5. 上行事件协议（场景页 → 宿主 → agent）

| 消息 | 时机 | 载荷 | 宿主处理 |
|---|---|---|---|
| `scene:ready` | 页面脚本就绪后 1 次 | `manifest`（§4） | 拼中文摘要，注入 agent（随孩子下一条消息） |
| `scene:child-click` | 孩子点击物品/角色 | `{target:slug|角色id, word, zh}` | 实时并入页面事件流注入 agent（点击即感知） |
| `scene:mic-press` / `scene:mic-release` | 按住/松开语音球 | 无 | v1 由聊天语音链路接管（暂不注入） |

页面外的事件（离开/打开资料等）沿用通用 `page:*` 通道，与场景无关。

---

## 6. 下行指令协议（agent → 宿主 → 场景页）

agent 经 `scene_command` 工具下发，宿主原样转发为 `{type:"scene:<command>", ...}`：

| command | 参数 | 语义 |
|---|---|---|
| `say` | `character` + `text`(英文台词) + `zh`(中文) | 角色说话：双语气泡 + 字幕 + 朗读（音色按角色） |
| `move` | `character` + `x`(像素 10~1120 **或** landmarks 目标名) + `duration?` | 角色走到目标位置，自动转向 |
| `act` | `character` + `act` | 角色做动作。**动作表是场景规范的一部分**：作者实现多少，agent 才能用多少。当前客厅动作表：`turn-on-lamp / turn-off-lamp / turn-on-tv / turn-off-tv / open-window / close-window / sit-sofa / stand / jump / dance / watch-tv / drink-water / picture-fall / picture-hang` |
| `show` | `character` | 让隐藏角色登场 |
| `highlight` | `target`(物品 slug 或角色 id) | 高亮某物，引导注意 |
| `update` | `task` + `progress` + `total` | 更新顶部任务进度点（可选） |

**没有 end / 结束类指令**：主线完成由 agent 在聊天里祝贺并询问，页面不收尾。

---

## 7. 动作表声明方式（作者↔agent 对齐的关键）

动作表要**同时出现在三处**，三者必须一致：
1. **HTML**：`Scene.act` 的 switch 实现（动作真正有效）；
2. **规范/文案**：行为规范的指令说明、或教学文案（agent 的 system/task 上下文知道有哪些动作可用）；
3. **实测**：新动作加进 HTML 后，用宿主下发的 scene 指令（或控制台直调全局 `Scene`）验证动画不打架（朝向 scaleX 与 .sit/.jump 等 class 动画冲突 → 翻转移内层元素等）。

> 给 agent 的动作说明若与 HTML 实现不一致，宁可少写（agent 少用）也不多写（agent 调用无效动作会静默失败）。

---

## 8. 作者制作 Checklist

1. 场景 stage 1120px 宽；背景、静态道具就位。
2. 每个可互动对象标 `class="prop"` + `id="p-<slug>"` + `data-word` + `data-zh`（+ 需要的 `data-phon`/`data-attr-*`）。
3. 角色 `div.character id="ch-<id>"`（隐藏角色初始加 `hidden` class）。
4. `Scene.act` 实现动作 switch；与行为规范/文案的动作表核对一致。
5. 登记 manifest（props 自动采集函数 + characters/landmarks 常量），就绪上抛 `scene:ready`。
6. 检查顶部注释协议与本规范一致；`meta name="pi-scenario" content="1"` 在。

---

## 9. 本规范与行为规范的分工

- **本文件**：约束「页面怎么写」（物品/角色属性、事件、动作表），是 HTML 作者契约；
- **孩子行为规范（LEARNING_NAV_INSTRUCTIONS 场景段）**：约束「agent 怎么陪玩」（孩子主导、不评价、卡住才提醒、不主动结束/记录、按清单回答），是 agent 契约；
- 教学法（家长库主题 method）说明**该课教学目标与节奏**，三者不冲突时以教学法为准、冲突时页面/agent 能力以本规范为底线。

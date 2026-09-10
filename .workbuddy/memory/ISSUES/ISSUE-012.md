## [ISSUE-012] 分配学习主题列表与课程管理不一致：课程管理 9 个主题，分配主题时不足 9 个

- **类型**：bug
- **描述**：家长「课程管理」里有 9 个学习主题，但孩子管理「分配学习主题」时列表不足 9 个（数量/条目不一致）。
- **已排查（代码层面两处应一致）**：
  - 服务端真源：`server/data/parents/86a84278-*/parent.sqlite` `topics` 表实测 **9 行**（english / hanzigong / lunyu / qianziwen / reading / taodi / xiaojing / xiaozhuan / feizhougu）。
  - 课程管理：`src/components/CourseManager.tsx:39` `refreshTopics()` → `window.api.parentListTopics()`。
  - 分配主题：`src/components/ChildTopicsModal.tsx:45` `ChildTopicsContent`（孩子详情页「学习主题」tab 用，ChildDetailPage.tsx:112）`refresh()` 同样调 `window.api.parentListTopics()`（:66-67），渲染 `topics.map`（:174）**无过滤**（已分配仅标记「✓ 已添加」）。
  - IPC：`parent:listTopics`（`electron/lib/ipc-handlers.ts:316`）→ `listParentTopics()`（parent-library.ts:298）→ `dbQuery("parent_lib.topics.list")`；服务端 `parent_lib.topics.list`（`server/src/routes/db.ts:226`）全量 SELECT topics 表，**无过滤**；路由按 session 的 parentId（JWT）openParentLib。
- **待排查方向**：
  ① 请提供分配页实际显示的主题名列表/缺失项（对比缺哪几个，判断是数据还是渲染问题）；
  ② 家长登录 session 的 parentId 是否 86a84278…（不同家长账号查各自 parent_lib，库不同）；课程管理与分配主题是否同一登录态；
  ③ 客户端是否为最新构建（out/ 旧产物缓存）——建议先重启/重构建复测；
  ④ `dbQuery("parent_lib.topics.list")` 是否偶发失败：`listParentTopics` 对 topics 查询 `.catch(() => [])`——若服务端接口报错则分配页返回空/少（课程管理同样 catch，但可看主进程/渲染进程控制台是否有 dbQuery 报错）；
  ⑤ 前端字段映射：服务端返回 `topic_key`，`listParentTopics` 映射为 `topicKey`（parent-library.ts:330 附近）——若某行 topic_key 为空/异常，React `key={t.topicKey}` 可能告警但不丢行，仅作兜底检查。
- **优先级**：已完成（2026-08-30 核实：server parent_lib.topics.list 实测返回 9 行全量（english/feizhougu/hanzigong/lunyu/qianziwen/reading/taodi/xiaojing/xiaozhuan）；客户端 listParentTopics 无过滤（parent-library.ts:298-330 全量映射）、IPC parent:listTopics 透传、ChildTopicsContent topics.map 无过滤——当前代码与数据一致，原「不足 9 个」应为旧构建/迁移前数据，无需代码改动）
- **记录时间**：2026-08-30

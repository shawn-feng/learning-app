import { describe, it, expect } from "vitest";
import { countTodoTasks } from "../electron/lib/custom-tools";

// ISSUE-025：todolist markdown 的确定性解析（统计口径）。
// 统计完全由主进程数 checkbox 得出（不依赖 LLM 结构化输出），口径一旦改必须同步改这里。
describe("countTodoTasks", () => {
  it("空内容返回全 0", () => {
    expect(countTodoTasks("")).toEqual({
      total: 0,
      done: 0,
      parentTotal: 0,
      parentDone: 0,
      selfTotal: 0,
      selfDone: 0,
    });
  });

  it("普通行 + [家长] 行混合统计（含 - 与 * 两种前缀、[x]/[X]/[ ] 状态）", () => {
    const md = [
      "- [ ] [家长] 语文（yuwen）：今天学 2 课",
      "- [x] [家长] 必学：数学（shuxue）",
      "* [X] 读课外书 20 分钟",
      "- [ ] 帮妈妈做家务",
      "## 备注（不算任务）",
      "今天要加油哦",
    ].join("\n");
    const c = countTodoTasks(md);
    expect(c.total).toBe(4);
    expect(c.done).toBe(2);
    expect(c.parentTotal).toBe(2);
    expect(c.parentDone).toBe(1);
    expect(c.selfTotal).toBe(2);
    expect(c.selfDone).toBe(1);
  });

  it("[家长] 标记只认行首任务文本里的字面标记，正文出现「家长」不算", () => {
    const md = [
      "- [ ] 和爸爸妈妈一起散步",
      "- [x] 阅读《家长指导手册》",
      "- [ ] [家长] 练字 1 页",
    ].join("\n");
    const c = countTodoTasks(md);
    expect(c.parentTotal).toBe(1);
    expect(c.selfTotal).toBe(2);
  });

  it("缩进与多余空格不影响统计", () => {
    const md = [
      "  - [ ]  [家长] 英语（yingyu）：今天学 1 课",
      "\t* [x]\t晨跑 10 分钟",
    ].join("\n");
    const c = countTodoTasks(md);
    expect(c.total).toBe(2);
    expect(c.done).toBe(1);
    expect(c.parentTotal).toBe(1);
    expect(c.parentDone).toBe(0);
    expect(c.selfTotal).toBe(1);
    expect(c.selfDone).toBe(1);
  });
});

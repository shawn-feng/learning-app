/**
 * 孩子详情页「📝 自定义规范」tab（ISSUE-136 #7）：CustomPromptEditor 的孩子侧包装
 * （scope=child、ref=childId；内容追加为「## 家长设定的额外规范」进孩子 agent system prompt）。
 */
import CustomPromptEditor from "./CustomPromptEditor";

export default function ChildCustomRules({ childId }: { childId: string }) {
  return (
    <CustomPromptEditor
      scope="child"
      refId={childId}
      title="自定义规范"
      entityLabel="孩子"
      description={
        <>
          给孩子的 AI 伙伴追加的额外规范（例如：「讲题先给提示，别直接报答案」「每轮结束夸一句具体的进步」）。
          内容会整段**追加**在 AI 行为规范的最末尾，只影响这一个孩子；基础规范由系统维护，这里改不到。
        </>
      }
      placeholder={"在这里写给 AI 伙伴的额外规范，一行一条即可，例如：\n· 讲题先给提示，别直接报答案\n· 20 点以后不再安排新任务，只鼓励休息"}
    />
  );
}

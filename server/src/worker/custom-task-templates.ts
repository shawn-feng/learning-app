/**
 * ISSUE-182 F5：自定义任务指令模板（除掌握分析外的新增预设）。
 *
 * 与 MASTERY_TASK_TEMPLATE（mastery-tools.ts，固定 id 幂等创建）不同：本文件的模板是**纯指令预填**——
 * 创建时走普通 custom 任务插入（每次创建一条新任务，家长可改名称/时刻/指令后保存），
 * 分配对象由家长创建后在分配弹窗里选（孩子任意多选，也可分配家长本人）。
 * 模板只是预填文本降低写指令门槛，不携带任何特殊执行语义。
 */

export interface CustomTaskTemplate {
  key: string;
  name: string;
  time: string;
  frequency: string;
  description: string;
  instruction: string;
}

/** 天气 + 穿衣提醒：weather_query → create_reminders（once，触发后约 15 分钟播）。 */
export const WEATHER_REMINDER_TEMPLATE: CustomTaskTemplate = {
  key: "weather_outfit_reminder",
  name: "天气与穿衣提醒",
  time: "07:30",
  frequency: "daily",
  description: "每天早上查天气，生成一句穿衣建议推送到孩子设备语音播报。",
  instruction:
    "请完成今天的天气与穿衣提醒：\n" +
    "1) 调 weather_query 查默认城市今天的天气预报（days=1）；\n" +
    "2) 根据天气给孩子写一句简短友好的穿衣建议（今天多少度、要不要加外套、要不要带伞）；\n" +
    "3) 调 create_reminders 创建一条 once 提醒（fireAt=当前时间约 15 分钟后），text=这句穿衣建议（可带天气概况）。只创建今天这一条。",
};

/** 错题复习提醒：child_mistake_log(list) → create_reminders（有错题才提醒）。 */
export const MISTAKE_REVIEW_TEMPLATE: CustomTaskTemplate = {
  key: "mistake_review_reminder",
  name: "错题复习提醒",
  time: "19:00",
  frequency: "daily",
  description: "每晚查看孩子的未复习错题，有错题才生成一条复习提醒推送到孩子设备。",
  instruction:
    "请帮孩子安排今晚的错题复习：\n" +
    "1) 调 child_mistake_log（action=list）查看 open（未复习）状态的错题；\n" +
    "2) 若没有未复习错题，直接汇报「今天没有待复习的错题」，**不要创建提醒**；\n" +
    "3) 若有，挑最需要优先复习的 1~3 道（最早未复习的优先），用 create_reminders 创建一条 once 提醒" +
    "（fireAt=当前时间约 10 分钟后），text 用孩子能听懂的口吻说明今晚复习哪几道、每道一句话点出复习点。",
};

/** 普通模板清单（POST /scheduler/tasks 的 template 白名单；key 与 UI 模板卡一一对应）。 */
export const PLAIN_CUSTOM_TASK_TEMPLATES: CustomTaskTemplate[] = [
  WEATHER_REMINDER_TEMPLATE,
  MISTAKE_REVIEW_TEMPLATE,
];

export function findPlainCustomTaskTemplate(key: string): CustomTaskTemplate | undefined {
  return PLAIN_CUSTOM_TASK_TEMPLATES.find((t) => t.key === key);
}

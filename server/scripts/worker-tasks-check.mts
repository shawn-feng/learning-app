import { listTasks } from "../src/worker/tasks.js";
const tasks = listTasks();
console.log("已注册任务:", tasks.map((t) => t.type).join(", "));
const cfg = { recording: { enabled: true, times: ["21:00", "22:30"] }, todo: { enabled: true, genTime: "08:00", statTime: "21:00" } };
console.log("recording points:", JSON.stringify(tasks[0].points(cfg)));
console.log("todo points:", JSON.stringify(tasks[1].points(cfg)));
const off = { recording: { enabled: false, times: ["21:00"] }, todo: { enabled: false, genTime: "08:00", statTime: "21:00" } };
console.log("未启用 points 数:", tasks[0].points(off).length, tasks[1].points(off).length);

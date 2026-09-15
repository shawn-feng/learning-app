import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync("C:\\Users\\79734\\Documents\\pi\\server\\data\\parents\\86a84278-c8ae-415e-8fbc-6140b1b7c88e\\parent.sqlite");
const r = db.prepare("SELECT MIN(created_at) mn, MAX(created_at) mx, COUNT(*) n FROM question_bank").get();
console.log("question_bank:", JSON.stringify(r));
if (!r.mx.startsWith("2026-09-14")) { console.log("ABORT: 存在非今日数据，不清理"); process.exit(1); }
db.exec("DELETE FROM course_knowledge_questions; DELETE FROM knowledge_points; DELETE FROM question_bank;");
console.log("wiped: knowledge_points=", db.prepare("SELECT COUNT(*) n FROM knowledge_points").get().n, "question_bank=", db.prepare("SELECT COUNT(*) n FROM question_bank").get().n);
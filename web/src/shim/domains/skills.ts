/**
 * skills 域（Phase 3）：学习技能列表/导入/读写。
 *
 * 精读结论：Electron 端 skills:* 通道（ipc-handlers 1162-1235 行）的数据源是**客户端本机**
 * `data/skills/` 目录（readdirSync/copyDir/readFileSync/writeFileSync），服务端无任何 skills
 * 端点（server/src/routes/* 全量核对无 skills）——浏览器既读不到本机目录，服务端也无真源可拉。
 * 故 Web 版为显式 stub：
 *   - skillsList → []（消费方 SkillImport.tsx / SkillEditor.tsx 按「暂无技能」空列表渲染，容错）；
 *   - skillImportFolder → {success:false, error}（消费方 SkillImport.tsx `result?.error` 显式提示）；
 *   - skillRead/skillWrite → {success:false, error}（消费方 SkillEditor.tsx `result?.success` 判空跳过）；
 *   - skillListFiles → []。
 * 若后续服务端补 skills 同步端点，再按同签名接入。
 */
const UNSUPPORTED = "Web 版暂不支持技能管理（技能为桌面端本地目录能力，浏览器与服务端均无该数据源）";

export const skillsDomain = {
  /** skillsList: () => Promise<string[]>（本机目录清单；Web 无数据源 → 空列表） */
  skillsList: async (): Promise<string[]> => [],

  /** skillImportFolder: () => Promise<{ success: false; error: string }>（系统目录选择框为桌面能力，显式不支持） */
  skillImportFolder: async (): Promise<{ success: false; error: string }> => ({
    success: false,
    error: UNSUPPORTED,
  }),

  /** skillRead: (skillName, filePath) => Promise<{ success: false; error: string }>（本机文件读取不可用） */
  skillRead: async (_skillName: string, _filePath: string): Promise<{ success: false; error: string }> => ({
    success: false,
    error: UNSUPPORTED,
  }),

  /** skillWrite: (skillName, filePath, content) => Promise<{ success: false; error: string }>（本机文件写入不可用） */
  skillWrite: async (_skillName: string, _filePath: string, _content: string): Promise<{ success: false; error: string }> => ({
    success: false,
    error: UNSUPPORTED,
  }),

  /** skillListFiles: (skillName) => Promise<string[]>（本机目录清单；Web 无数据源 → 空列表） */
  skillListFiles: async (_skillName: string): Promise<string[]> => [],
};

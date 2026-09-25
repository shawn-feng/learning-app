/**
 * 会话工厂（共享内核）：把「建 agent 会话」的样板集中一处，持久与 ephemeral 两种形态共用一条路径。
 *
 * 依赖反转（重要）：本模块 **不 import agent SDK**，SDK 对象（ModelRuntime / SessionManager /
 * DefaultResourceLoader / createAgentSession）一律由调用方注入。原因：
 *   1. 客户端与服务端各自固定了不同版本的 pi-coding-agent（服务端精确 0.84.1，客户端 ^0.84.1），
 *      若本模块直接 import SDK，Node 解析会从本文件位置向上找到**某一个** node_modules，
 *      从而在另一侧编译/打包时静默用错版本（ISSUE-028 已因版本差异踩过严格类型问题）；
 *   2. 注入后本模块可被两端复用且易于单测（传桩即可）。
 *
 * ephemeral：一次性任务（recording/todo 等），SessionManager.inMemory()，不落盘、不注入项目 prompt。
 * persistent：交互会话（孩子/家长），SessionManager.continueRecent + sessionsDir 落盘（server 权威）。
 */
import fs from "node:fs";

/** SDK 侧最小契约（结构化，避免 import 具体版本类型） */
export interface CoreSessionDeps {
  /** createAgentSession(...) —— 返回 { session } */
  createAgentSession: (opts: any) => Promise<any> | any;
  /** DefaultResourceLoader 构造器 */
  ResourceLoader: new (opts: any) => any;
  /** SessionManager 命名空间（需要 inMemory / continueRecent） */
  SessionManager: {
    inMemory: () => any;
    continueRecent: (dataDir: string, sessionsDir: string) => any;
  };
}

export interface CoreSessionCommonOptions {
  deps: CoreSessionDeps;
  runtime: unknown;
  model: unknown;
  /** 工作目录（agent 工具可见的文件树根，必须已是作用域内路径） */
  cwd: string;
  /** agent 私有目录（缓存/临时态），按 parentId/childId 隔离 */
  agentDir: string;
  /** system prompt（由调用方按会话类型构建；服务端从服务端 prompt 真源读取） */
  systemPrompt: string;
  toolNames: string[];
  customTools: unknown[];
  /** 附加扩展工厂（如 learning-guard），客户端会话会传 */
  extensionFactories?: unknown[];
  /** 是否禁用项目上下文文件（AGENTS.md 等）注入 */
  noContextFiles?: boolean;
  /**
   * 是否禁用 pi 原生 skills 发现。**默认 true＝禁用**（2026-09-25 决策，理由见调用点注释）。
   *
   * 注意语义：`noSkills: true` 只丢掉 settings.json 里那份 `skills` 清单；显式传入的
   * `additionalSkillPaths` 仍会被 pi 加载（resource-loader.js:329-331）。本仓任何调用方都未传后者。
   */
  noSkills?: boolean;
}

export interface CoreEphemeralSessionOptions extends CoreSessionCommonOptions {}

export interface CorePersistentSessionOptions extends CoreSessionCommonOptions {
  /** 服务端会话落盘根（按 parentId/childId 隔离）；给出即为持久会话 */
  sessionsDir: string;
  /** 新建会话判据：由调用方决定（如每日自动新会话策略），返回 true 则 newSession() */
  shouldAutoNewSession?: (sessionsDir: string) => boolean;
}

export interface CoreSessionHandle {
  session: any;
  /** 是否在本次创建时新建了会话文件（持久会话专有） */
  startedNewSession: boolean;
}

/** 一次性任务会话：内存态、隔离目录、noContextFiles + noSkills。 */
export async function createEphemeralSession(opts: CoreEphemeralSessionOptions): Promise<any> {
  return (await createCoreSession(opts)).session;
}

/** 交互会话：默认落盘（给 sessionsDir 时）或内存态（未给时，等价 ephemeral）。 */
export async function createCoreSession(
  opts: CoreEphemeralSessionOptions | CorePersistentSessionOptions
): Promise<CoreSessionHandle> {
  const { deps } = opts;
  fs.mkdirSync(opts.cwd, { recursive: true });
  fs.mkdirSync(opts.agentDir, { recursive: true });

  // pi 原生 skills 一律**禁用**（2026-09-25 决策，别照抄成"没这功能"）：它的 SKILL.md 以
  // **绝对路径**写进 system prompt，而我们的 read 工具是 resolveWithin 沙箱（拒绝绝对路径）→
  // 索引指向模型打不开的门；项目级发现目录 `<cwd>/.pi/skills` 又落在模型**有写权限**的 cwd 里
  // （等于让模型给自己写指令，还会进 prompt）；全局目录是宿主级、多家长共用；且原生技能只是
  // "提示模型自己去 read 正文"，没有执行点，挂不上我们需要的场景守卫（未加载场景不许执行）。
  // 家长场景技能因此自建：正文存 DB（内置随代码发布 + 家长覆盖）、经 `load_skill` 以工具结果
  // 追加到消息尾部（不动 system prompt、不动工具集），由 scenarioGuard 强制。若将来要放行原生
  // skills，必须同时解决 read 的路径策略与技能目录的可写性，不能只把这里改成 false。
  // 详见 docs/家长agent-场景skill实施方案-2026-09-25.md、server/src/agent/parent-skills.ts。
  // ⚠️ 2026-09-25 修正（原来这根线**从来没接通**）：`extensionFactories` 必须交给 **ResourceLoader**，
  // 不是 `createAgentSession`。
  //
  // SDK 里唯一的读取点是 `DefaultResourceLoader` 的 `options.extensionFactories`
  // （`dist/core/resource-loader.js:168` → `loadExtensionFactories()`，在 `reload()` 时执行）；
  // 而 `createAgentSession()` 的实现里**根本没有引用 `options.extensionFactories`**
  // （`dist/core/sdk.js:66` 起：有 `options.resourceLoader` 就直接用它，否则自建一个不带扩展的）。
  // 于是原先"传进 createAgentSession"的写法被**静默忽略**：`learning-guard` 的「每轮注入日期」
  // 与「fs 路径红线」在整个 agent-core 会话路径上一直是**没加载**的
  // （`loadExtensionFactories` 还把工厂异常收进 `errors` 而不抛，所以连报错都没有）。
  // 症状与 learning-guard 自己注释里记的那次实测（跨天沿用旧日期）一致。
  const loader = new deps.ResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noContextFiles: opts.noContextFiles ?? true,
    noSkills: opts.noSkills ?? true,
    systemPromptOverride: () => opts.systemPrompt,
    ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
  });
  await loader.reload();

  const sessionsDir = (opts as CorePersistentSessionOptions).sessionsDir;
  let sessionManager: any;
  let startedNewSession = false;
  if (sessionsDir) {
    fs.mkdirSync(sessionsDir, { recursive: true });
    sessionManager = deps.SessionManager.continueRecent(opts.cwd, sessionsDir);
    const shouldNew = (opts as CorePersistentSessionOptions).shouldAutoNewSession;
    if (shouldNew?.(sessionsDir)) {
      sessionManager.newSession();
      startedNewSession = true;
    }
  } else {
    sessionManager = deps.SessionManager.inMemory();
  }

  const { session } = await deps.createAgentSession({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    modelRuntime: opts.runtime,
    model: opts.model,
    sessionManager,
    resourceLoader: loader,
    tools: opts.toolNames,
    customTools: opts.customTools,
    // 注意：这里**不再**传 extensionFactories——`createAgentSession` 不认这个选项（见上面 loader 处的说明）。
    // 扩展已经在构造 `loader` 时交进去了。
  });
  return { session, startedNewSession };
}

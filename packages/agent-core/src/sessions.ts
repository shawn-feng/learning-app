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

  const loader = new deps.ResourceLoader({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    noContextFiles: opts.noContextFiles ?? true,
    noSkills: opts.noSkills ?? true,
    systemPromptOverride: () => opts.systemPrompt,
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
    ...(opts.extensionFactories ? { extensionFactories: opts.extensionFactories } : {}),
  });
  return { session, startedNewSession };
}

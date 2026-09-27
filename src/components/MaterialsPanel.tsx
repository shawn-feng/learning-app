import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CSSProperties } from "react";
import IconButton from "./IconButton";
import { ArrowLeft, PanelRightClose } from "lucide-react";
import { lookupText, type LookupEntry } from "../lib/dictionary";
import { WordLookupOverlay, WordLookupBubble, type LookupState } from "./WordLookupOverlay";
import {
  EventThrottler,
  genRequestId,
  injectBridge,
  type MaterialsPanelHandle,
  type PageAction,
  type PageEvent,
  type PageExecDownlink,
  type PageExecParams,
  type PageExecResultUplink,
} from "../lib/page-bridge";
// Web 版（window.api.__web）共享文档网关 URL 组装：api/token/材料 id 编解码来自 shim core
//（纯函数模块，Electron 端仅被 web 分支引用，零行为影响）。
import { apiUrl, getStoredToken, encodeMaterialId } from "../../web/src/shim/core/server-fetch";

/** 资料展示类型（KB P1 引入，P2 加 `pdf`）：**由文件扩展名现算、写在事件里**，渲染层不自己猜。缺省=html（兼容旧事件） */
export type MaterialKind = "html" | "image" | "audio" | "video" | "text" | "pdf";

/**
 * KB P1：扩展名 → 展示类型（**渲染层的兜底**）。
 *
 * 为什么渲染层还要自己算一遍：`display_contents`（ISSUE-113 的会话回填登记）**只存 path/title/
 * source/content，不存类型**——这是刻意的，类型是 `f(扩展名)` 的派生数据，落库就会在文件改名后
 * 永远错下去（`kb_entry_assets.role` 当初就是因为这个被删掉的，见
 * docs/知识库-完整方案-2026-09-26.md §3.3.5）。回填路径没有事件里的 `kind`，就按同一规则现算。
 *
 * ⚠️ 这张表与 `server/src/agent/display-tool.ts` 的 `KIND_BY_EXT` **需要同步维护**
 * （跨进程无法共享代码，与 `materials.ts` MIME / `materials-doc.ts` PAGE_MIME 是同一类约定）。
 */
export function kindFromPath(filePath: string | undefined): MaterialKind {
  const ext = String(filePath ?? "").toLowerCase().split(".").pop() ?? "";
  if (["txt", "md"].includes(ext)) return "text";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["mp3", "wav", "ogg", "m4a", "aac", "flac"].includes(ext)) return "audio";
  if (["mp4", "webm"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "html";
}

export interface Material {
  id: string;
  format: "html";
  /** KB P1：展示类型。`html`/`text` 用内联正文，媒体用 URL 直取（二进制不进事件） */
  kind?: MaterialKind;
  content: string;
  title?: string;
  time: string;
  /** 资料文件路径（相对学习目录），用于去重 */
  filePath?: string;
}

interface Props {
  materials: Material[];
  selectedId: string | null;
  onOpen: (id: string) => void;
  onBack: () => void;
  /** iframe 内互动事件上报（节流后），Learn 层转发给主进程注入 agent */
  onPageEvent?: (evt: PageEvent) => void;
  /** ISSUE-008：折叠资料区（收起后聊天区占更多空间） */
  onCollapse?: () => void;
  /** ISSUE-030：资料字号（px）；驱动列表/正文/markdown 的 --material-font 与 HTML iframe 注入 */
  matFontSize?: number;
  // 场景模式的三个回调（onSceneActive / onSceneVoice / onSceneMicNotice）已随场景会话下线删除（2026-09-25）
  /** ISSUE-114：孩子 id（查词自动上报错题本用） */
  childId?: string;
  /** ISSUE-157 反馈：裸渲染模式——详情视图不显示返回按钮与资料标题（进度页课程详情内嵌，
   *  tab 已在上一行、课程名就是标题；列表视图本就不用） */
  bare?: boolean;
}

const EXEC_TIMEOUT_MS = 10000;
const THROTTLE_WINDOW_MS = 3000;
const SCROLL_WINDOW_MS = 800;

interface PendingExec {
  resolve: (r: PageExecResultUplink) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 同一交互序列（mouseup 选中 → 随后 click）内 click 不应关闭浮层的时间窗 */
const LOOKUP_CLICK_GRACE_MS = 400;

/** 简单字符串 hash（用于 iframe key：内容变化即重建，含同长度不同内容的重发场景） */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return String(h);
}

/**
 * 构造指令失败回执（无 requestId 的早退/超时兜底场景）：补全 PageExecResultUplink 必填的
 * type/requestId（requestId 用空串——该回执只经内存 resolve 交给调用方，消费方只读 ok/error）。
 */
function failedExec(error: string): PageExecResultUplink {
  return { type: "page:exec:result", requestId: "", ok: false, error };
}

/**
 * HTML 内容通过沙盒 iframe 渲染。
 * sandbox="allow-scripts" 让 JS 可以运行（番茄钟、点击交互等），
 * 但不带 allow-same-origin，iframe 处于不透明源，脚本无法读取父页面 DOM / cookie，
 * 保证 AI 生成的内容被隔离在安全边界内。
 *
 * 加载通道二选一：
 * - docUrl（ISSUE-061 根治，2026-09-08）：共享 html 资料走 **真实 URL 顶层文档**（asset://...?doc=1，
 *   协议层已注入桥/SDK）。此前 dataURL/srcDoc 内嵌在 app 沙盒下实测正文 <script> 不执行，
 *   真实导航可让页面正文脚本随文档解析正常执行。加载期间显示进度 overlay。
 * - html（回退）：旧资料 / 无 filePath 的本地产物走 dataURL 内嵌 + 渲染层注入桥。
 */
function HtmlFrame({
  html,
  title,
  iframeRef,
  onLoad,
  refreshEpoch,
  docUrl,
  onDocError,
}: {
  html: string;
  title?: string;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  onLoad?: () => void;
  refreshEpoch?: number;
  docUrl?: string;
  onDocError?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const urlMode = !!docUrl;
  // URL 源：docUrl/epoch 变化 → 进入加载态并复位错误态
  useEffect(() => {
    if (!urlMode) return;
    setLoading(true);
    setLoadFailed(false);
  }, [urlMode, docUrl, refreshEpoch]);
  // 超时兜底：10s 仍未 load 完成 → 停止 loading 指示（避免永久转圈），但保留重试语义
  useEffect(() => {
    if (!urlMode || !loading) return;
    const t = setTimeout(() => setLoading(false), 10000);
    return () => clearTimeout(t);
  }, [urlMode, loading]);
  // dataURL 回退：渲染层注入桥（历史行为，本地产物/无 filePath 资料）
  const dataSrc = urlMode ? "" : "data:text/html;charset=utf-8;base64," + btoaUnicode(html);
  const src = urlMode ? docUrl : dataSrc;
  const key =
    urlMode
      ? `doc:${docUrl}:${refreshEpoch || 0}`
      : `${html.length}:${hashStr(html)}:${refreshEpoch || 0}`;
  return (
    <div style={{ position: "relative", flex: 1, minHeight: 320, display: "flex", flexDirection: "column" }}>
      <iframe
        key={key}
        ref={iframeRef}
        className="html-frame"
        sandbox="allow-scripts allow-modals allow-forms"
        // Web 版资料/场景页需要麦克风（场景语音球走宿主 getUserMedia，Electron 由窗口权限兜底，
        // 无条件声明对 Electron 无害）：允许 iframe 请求麦克风设备
        allow="microphone"
        src={src}
        title={title || "学习内容"}
        onLoad={() => {
          setLoading(false);
          setLoadFailed(false);
          onLoad?.();
        }}
        onError={() => {
          setLoading(false);
          setLoadFailed(true);
          onDocError?.();
        }}
      />
      {urlMode && loading && (
        <div className="html-frame-loading">
          <div className="hf-progress"><div className="hf-progress-bar" /></div>
          <div className="hf-progress-text">正在加载学习内容…</div>
        </div>
      )}
      {urlMode && loadFailed && (
        <div className="html-frame-error">
          内容加载失败，请让 AI 老师重新展示
        </div>
      )}
    </div>
  );
}

/** UTF-8 安全的 base64（btoa 只支持 Latin1，含中文/emoji 的资料必须先用 UTF-8 编码字节） */
function btoaUnicode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * 判定资料是否可用「真实 URL 顶层文档」加载，并构造文档 URL。
 * 条件：filePath 存在、去掉 materials/ 前缀后形如 `topic/xxx/name.html`（服务端共享材料）。
 * 本地产物（outputs/ 开头）或无 filePath 的资料返回空串 → HtmlFrame 回退 dataURL 内嵌。
 * URL 语义（二选一）：
 * - Electron：asset://local/parent/{parentId}/{topic}/{rest}?doc=1&font=N&v=epoch
 *   parentId 仅作 URL 路径段占位（协议按 session token 定位家长，不校验段值）——用固定 "default"。
 * - Web（window.api.__web）：服务端文档网关
 *   `{api}/materials/doc/{base64url(相对路径)}?doc=1&token=...&font=N&v=epoch`
 *   （doc=1 语义对齐、font/v 照传；网关完成「拉 HTML→改写相对资源→注桥→text/html」）。
 */
function resolveSharedDocUrl(
  filePath: string | undefined,
  matFont: number | undefined,
  epoch: number
): string {
  if (!filePath) return "";
  const norm = String(filePath).replace(/\\/g, "/").replace(/^materials\//, "").trim();
  if (!norm || norm.startsWith("outputs/")) return "";
  if (!/^[^/]+\/.+\.(html|htm)$/i.test(norm)) return "";
  if (norm.includes("..") || norm.includes(":")) return "";
  const font = typeof matFont === "number" && matFont >= 8 ? `&font=${matFont}` : "";
  if (window.api?.__web) {
    // 目录前缀 page 路由（2026-09-16）：token 在路径段，html 携带 <base href=.../p/<token>/<dir>/ >，
    // 课程 JS 运行期动态拼接的相对媒体路径（如 'emma/'+x+'.mp4'）据此解析并可播（doc/:id 网关的
    // 静态改写覆盖不到动态拼接）。relpath 逐段编码；token 走路径需 encodeURIComponent。
    const token = encodeURIComponent(getStoredToken());
    const segs = norm.split("/").map((s) => encodeURIComponent(s)).join("/");
    return `${apiUrl(`/materials/p/${token}/${segs}`)}?doc=1${font}&v=${epoch}`;
  }
  const segments = norm.split("/").map((s) => encodeURIComponent(s));
  return `asset://local/parent/default/${segments.join("/")}?doc=1${font}&v=${epoch}`;
}

/**
 * KB P1/P2：图片/音视频/PDF 的**直链**（不经过 html 文档通道）。
 *
 * ⚠️ 平台差异是硬的（`electron/lib/media-protocol.ts:19`）：
 * - **音视频必须走 `media://`**——`asset://` 的扩展名白名单不含音视频，走它一律 403；
 * - 图片/文本/**PDF** 走 `asset://`（都在 `ASSET_ALLOWED_EXT` 里；PDF 是 P2 加的）；
 * - Web 端走服务端目录前缀路由 `/materials/p/:token/*`，该路由支持任意 MIME + Range（视频可 seek）。
 *
 * **PDF 的 URL 片段不是可选项**：`#toolbar=0&navpanes=0&view=FitH` 收掉 Chromium 阅读器的
 * 工具栏、缩略图侧栏和**下载/打印按钮**。P2 探针实测：不加就是一个完整阅读器 UI（截图见
 * 方案 §5.4.2.1 偏差 ②），加完才是"就是一页纸"的干净画面，也顺带把「孩子能把资料下载到本地」
 * 这个出口关掉了。
 */
function resolveSharedMediaUrl(filePath: string | undefined, kind: MaterialKind, epoch: number): string {
  if (!filePath) return "";
  const norm = String(filePath).replace(/\\/g, "/").replace(/^materials\//, "").trim();
  if (!norm || norm.startsWith("outputs/")) return "";
  if (!/^[^/]+\/.+/.test(norm)) return "";
  if (norm.includes("..") || norm.includes(":")) return "";
  const segs = norm.split("/").map((s) => encodeURIComponent(s)).join("/");
  const frag = kind === "pdf" ? "#toolbar=0&navpanes=0&view=FitH" : "";
  if (window.api?.__web) {
    const token = encodeURIComponent(getStoredToken());
    return `${apiUrl(`/materials/p/${token}/${segs}`)}?v=${epoch}${frag}`;
  }
  const scheme = kind === "audio" || kind === "video" ? "media" : "asset";
  return `${scheme}://local/parent/default/${segs}${frag}`;
}

/**
 * 学习资料面板：列表 + 详情两态。
 * - 列表：每一行是一次学习资料（当前会话里 AI 展示过的全部资料）
 * - 详情：点开后展示该份资料，可「返回列表」
 */
/** ISSUE-061：场景页就绪清单 → 给 agent 的中文摘要（物品属性/角色，一次注入，agent 据此问答与驱动） */
function sceneReadyText(manifest: unknown): string {
  const m = (manifest ?? {}) as {
    title?: string; props?: Array<Record<string, any>>; characters?: Array<Record<string, any>>;
  };
  const p = (m.props ?? []).map((x) => {
    let s = x.word || x.id || "";
    if (x.zh) s += ` ${x.zh}`;
    if (x.phon) s += ` ${x.phon}`;
    const av = Object.entries((x.attrs as Record<string, unknown>) || {})
      .map(([k, v]) => `${k}=${v}`).join(" ");
    if (av) s += `（${av}）`;
    return s;
  });
  const c = (m.characters ?? []).map((x) => {
    let s = `${x.id}(${x.name || x.id}`;
    if (x.zh) s += ` ${x.zh}`;
    if (x.persona) s += `，${x.persona}`;
    return s + ")";
  });
  if (!p.length && !c.length) return "";
  const title = m.title ? `${m.title}，` : "场景";
  return `${title}已就绪。可点物品（点击会发单词音并上报）：${p.join("、")}。场景角色：${c.join("、")}。`;
}

const MaterialsPanel = forwardRef<MaterialsPanelHandle, Props>(function MaterialsPanel(
  { materials, selectedId, onOpen, onBack, onPageEvent, onCollapse, matFontSize = 16, childId, bare = false },
  ref
) {
  const selected = materials.find((m) => m.id === selectedId);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const readyRef = useRef(false);
  // MATERIAL 保鲜/display_content 同 path 重发等场景下，React/Chromium 更新 srcDoc 属性不保证
  // 触发 iframe 重载；用 epoch 在内容（selected.content）实质变化时 +1，配合 HtmlFrame key 强重建。
  const [htmlEpoch, setHtmlEpoch] = useState(0);
  const activeHtml = selected && selected.format === "html" ? (selected.content ?? "") : "";
  useEffect(() => {
    if (activeHtml) setHtmlEpoch((e) => e + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHtml]);
  const pendingRef = useRef(new Map<string, PendingExec>());
  const throttlerRef = useRef(new EventThrottler());
  const onPageEventRef = useRef(onPageEvent);
  onPageEventRef.current = onPageEvent;
  // ISSUE-011：资料朗读走 edge-tts（与聊天同链路）。audioRef=当前播放；seq 防乱序（新朗读取代旧回执）
  const ttsAudioRef = useRef<HTMLAudioElement | null>(null);
  const ttsSeqRef = useRef(0);
  // ISSUE-2026-09-08：场景多角色连续台词（agent 一轮多条 say → 页面逐条 tts.speak）不得互相覆盖。
  // queue 模式把请求串行：播完一条再取下一条；打断模式（资料朗读/点读/查词）维持「新取代旧」。
  const ttsQueueRef = useRef<{ text: string; seq: number }[]>([]);
  const ttsActiveRef = useRef(false);
  // ISSUE-017：查词两段式状态（anchor=选中点+查询结果，open=弹框是否展开）+ 最近 lookup
  // 时间戳（click 关闭浮层时避开同交互序列）。
  // ⚠️ handler 在 useEffect 注册一次，闭包内 state 恒为初值 → 必须用 ref 同步读取（ISSUE-014 教训）
  const [lookup, setLookup] = useState<{ anchor: LookupState; open: boolean } | null>(null);
  const lookupRef = useRef<{ anchor: LookupState; open: boolean } | null>(null);
  const lastLookupAtRef = useRef(0);
  const showLookup = useCallback((s: { anchor: LookupState; open: boolean } | null) => {
    lookupRef.current = s;
    setLookup(s);
  }, []);
  const closeLookup = useCallback(() => showLookup(null), [showLookup]);
  const openLookupPopup = useCallback(() => {
    const cur = lookupRef.current;
    if (cur) showLookup({ ...cur, open: true });
  }, [showLookup]);

  // ISSUE-030：资料字号经 CSS 变量下传到列表/正文（作用域限定在孩子端 .content-panel，不波及家长端/聊天）
  const materialFontStyle = { "--material-font": `${matFontSize}px` } as CSSProperties;

  /** 资料/场景朗读（edge-tts）。
   * queue=true：排队模式（场景多角色连读逐句顺序播放，后一条等前一条播完，不互相覆盖）。
   * 默认：打断模式（资料朗读/点读/查词等单条意图，新请求取代正在播的）。
   */
  const speakMaterialText = useCallback(async (text: string, opts?: { queue?: boolean }) => {
    const doPlay = async (playText: string, seq: number) => {
      ttsActiveRef.current = true;
      // Web（window.api.__web，Phase 5）：浏览器 speechSynthesis 代播（无 edge-tts MP3 合成）。
      // 队列/打断仍由本组件的 seq+pump 状态机裁决（与 Electron 同一套）；voiceSpeak resolve
      // （播完或被取代）后按 seq 有效性回执 page:tts:done（对齐 edge-tts blob 播完回执时机）。
      if (window.api?.__web && window.api?.voiceSpeak) {
        try {
          await window.api.voiceSpeak(playText, {});
        } catch {
          /* 播报失败按播完收尾（回执复位页面朗读按钮，不卡队列） */
        }
        if (seq !== ttsSeqRef.current) return; // 已被打断（seq 失效），不接管播放链
        iframeRef.current?.contentWindow?.postMessage({ type: "page:tts:done" }, "*");
        ttsActiveRef.current = false;
        ttsAudioRef.current = null;
        pump(); // 播完一条 → 播下一条排队台词
        return;
      }
      try {
        const r = await window.api.voiceTts(playText, {});
        if (seq !== ttsSeqRef.current || !r.success || !r.audio) return; // 已被打断（seq 失效）
        console.log("[pi-tts] ▶ 开始播放 seq=" + seq + " text=" + playText.slice(0, 40));
        const blob = new Blob([r.audio], { type: "audio/mpeg" });
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        ttsAudioRef.current = audio;
        const done = () => {
          if (seq !== ttsSeqRef.current) return; // 过期（已被打断），不接管播放链
          console.log("[pi-tts] ■ 播完 seq=" + seq);
          URL.revokeObjectURL(url);
          // 回执 iframe：桥脚本触发 utterance.onend（朗读按钮复位）
          iframeRef.current?.contentWindow?.postMessage({ type: "page:tts:done" }, "*");
          ttsActiveRef.current = false;
          ttsAudioRef.current = null;
          pump(); // 播完一条 → 播下一条排队台词
        };
        audio.onended = done;
        audio.onerror = done;
        await audio.play();
      } catch (e: any) {
        if (seq === ttsSeqRef.current) {
          ttsActiveRef.current = false;
          ttsAudioRef.current = null;
          pump();
        }
      }
    };
    const pump = () => {
      if (ttsActiveRef.current) return;
      const next = ttsQueueRef.current.shift();
      if (next) void doPlay(next.text, next.seq);
    };
    if (opts?.queue) {
      // 排队模式：快照当前有效 seq 入队（不递增——排队中的各条互不失效，只有打断才 seq++）。
      // 空闲立即由 pump 播放；忙则当前条播完自动取下一条。
      ttsQueueRef.current.push({ text, seq: ttsSeqRef.current });
      pump();
      return;
    }
    // 打断模式（默认，资料朗读/点读/查词）：seq++ 使当前播放/排队全部失效，播新请求
    const seq = ++ttsSeqRef.current;
    ttsQueueRef.current = [];
    ttsAudioRef.current?.pause();
    void doPlay(text, seq);
  }, []);

  /** 停止当前资料朗读（tts-cancel / 卸载时）：清队列并失效全部进行中的合成/播放 */
  const stopMaterialTts = useCallback(() => {
    ttsSeqRef.current++; // 使进行中的合成/播放回执失效
    ttsQueueRef.current = [];
    ttsActiveRef.current = false;
    // Web：取消浏览器 speechSynthesis 播报（ttsAudioRef 恒为 null，voiceSpeakCancel 等价 pause）
    if (window.api?.__web && window.api?.voiceSpeakCancel) {
      window.api.voiceSpeakCancel();
      return;
    }
    ttsAudioRef.current?.pause();
    ttsAudioRef.current = null;
  }, []);

  // 使全部未完成指令失效（页面刷新/切换/面板卸载：旧页面不会再回执）
  const rejectPending = useCallback((error: string) => {
    const pending = pendingRef.current;
    for (const [rid, p] of pending) {
      clearTimeout(p.timer);
      p.resolve({ type: "page:exec:result", requestId: rid, ok: false, error });
    }
    pending.clear();
  }, []);

  // message 监听：组件生命周期内注册一次，handler 实时读 iframeRef（天然跟随 iframe 重建）
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || event.source !== iframeWin) return; // 防伪造：只收当前 iframe 的消息
      const data0 = event.data;
      if (!data0 || typeof data0.type !== "string") return;
      if (data0.type === "page:diag") {
        console.warn("[panel-diag]", JSON.stringify(data0).slice(0, 400));
        return;
      }
      if (data0.type.startsWith("page:") || String(data0.type).startsWith("scene:")) {
        console.debug("[panel-msg]", data0.type);
      }
      let data: any = data0;

      // MATERIAL-BRIDGE-PROTOCOL：页面已改走 PiBridge（page:app）——把场景语义动作归一化回
      // 下方既有 scene:* 处理分支（ready/item-click）；其余 scene.* 或通用动作保留 page:app
      // 走「app 事件」分支（kind=app 注入 agent）。
      // 会话收敛（2026-09-25）：场景页不再是「角色会话」的宿主，但它的**页面事件**照样上报给主会话。
      if (data0.type === "page:app") {
        const action = String(data0.action ?? "");
        const pl = data0.payload ?? {};
        const mapped =
          action === "scene.ready"
            ? { type: "scene:ready", manifest: pl }
            : action === "scene.item-click"
              ? { type: "scene:child-click", target: pl.target, word: pl.word, zh: pl.zh }
              : null;
        if (mapped) data = mapped;
      }

      // 场景页上行事件（场景页自身脚本发出，非桥脚本）。
      // child-click 带语义（单词+中文）→ 转成通用 click 事件走既有节流上抛链给 agent。
      // （mic.press/release 的语音球录音随场景会话下线删除，2026-09-25）
      if (data.type === "scene:child-click") {
        const word = typeof data.word === "string" ? data.word : "";
        const zh = typeof data.zh === "string" ? data.zh : "";
        const evt = {
          type: "page:event",
          kind: "click",
          seq: 0,
          ts: Date.now(),
          detail: { text: word ? `${word}（${zh}）` : "", action: "scene" },
        } as unknown as PageEvent;
        const now = Date.now();
        if (throttlerRef.current.shouldEmit(`scene-click:${word}`, now, THROTTLE_WINDOW_MS)) {
          onPageEventRef.current?.(evt);
        }
        return;
      }
      // 场景页就绪 → 属性清单文本随孩子下一轮消息附带注入 agent（一次）
      if (data.type === "scene:ready") {
        const text = sceneReadyText(data.manifest);
        if (text) {
          onPageEventRef.current?.({
            type: "page:event",
            kind: "scene-ready",
            seq: 0,
            ts: Date.now(),
            detail: { text },
          } as unknown as PageEvent);
        }
        return;
      }
      if (typeof data.type === "string" && data.type.startsWith("scene:")) return; // 其余 scene: 上行忽略

      if (!data.type.startsWith("page:")) return;

      // ISSUE-061：场景页 speak() 直接上抛的朗读请求（page:tts，非 page:event 包装）——
      // 此前被丢弃导致场景内角色/单词「有画面没声音」，接入与资料朗读同一条 edge-tts 链。
      if (data.type === "page:tts") {
        const t = String((data as { text?: unknown }).text ?? "");
        if (t.trim()) void speakMaterialText(t);
        return;
      }

      // —— MATERIAL-BRIDGE-PROTOCOL（PiBridge）三类信封 ——
      if (data.type === "page:app") {
        // 页面作者语义事件 → 构造 PageEvent{kind:"app"} 直接上抛给 agent（语义事件不节流）
        const action = String((data as { action?: unknown }).action ?? "");
        if (!action) return;
        onPageEventRef.current?.({
          type: "page:event",
          kind: "app",
          seq: 0,
          ts: Date.now(),
          detail: { action, payload: (data as { payload?: unknown }).payload },
        } as unknown as PageEvent);
        return;
      }
      if (data.type === "page:req") {
        const action = String((data as { action?: unknown }).action ?? "");
        const requestId = String((data as { requestId?: unknown }).requestId ?? "");
        if (action && requestId) void handleAppRequest(action, (data as { payload?: unknown }).payload, requestId);
        return;
      }

      if (data.type === "page:event") {
        const evt = data as PageEvent;
        // ISSUE-011：资料朗读事件走 edge-tts，不进页面操作记录（不 onPageEvent 上抛）
        if (evt.kind === "tts") {
          const text = (evt.detail as { text?: string })?.text;
          console.log("[pi-tts] 收到 iframe tts 事件 text=", text?.slice(0, 40));
          if (text) void speakMaterialText(text);
          return;
        }
        if (evt.kind === "tts-cancel") {
          stopMaterialTts();
          return;
        }
        // ISSUE-017：选中/双击字词 → 本地字典查询 → 先出悬浮图标（点击才展开弹框，不进页面操作记录）
        if (evt.kind === "lookup") {
          const text = (evt.detail as { text?: string })?.text ?? "";
          const ex = (evt.detail as { x?: number })?.x ?? 0;
          const ey = (evt.detail as { y?: number })?.y ?? 0;
          const entries = lookupText(text);
          if (!entries.length) return; // 无中文/查不到 → 不弹
          lastLookupAtRef.current = Date.now();
          const rect = iframeRef.current?.getBoundingClientRect();
          if (!rect) return;
          // 鼠标点通常落在选区末行文字上，往下偏移让图标弹在字下方而非盖住选中内容（clamp 兜底边缘）
          showLookup({ anchor: { x: rect.left + ex, y: rect.top + ey + 12, text, entries }, open: false });
          return;
        }
        // ISSUE-017：点击 iframe 别处（非本次选中交互）或滚动页面 → 关闭查词浮层
        if (lookupRef.current && (evt.kind === "click" || evt.kind === "scroll")) {
          const isSameGesture = evt.kind === "click" && Date.now() - lastLookupAtRef.current < LOOKUP_CLICK_GRACE_MS;
          if (!isSameGesture) showLookup(null);
        }
        // 节流兜底（桥脚本内已有轻量去重）：click/input/submit 同 key 3s 去重，scroll 800ms
        const now = Date.now();
        let key = evt.kind;
        let windowMs = THROTTLE_WINDOW_MS;
        if (evt.kind === "click") key += `:${evt.detail?.index ?? ""}:${evt.detail?.text ?? ""}`;
        else if (evt.kind === "input") key += `:${evt.detail?.index ?? ""}`;
        else if (evt.kind === "submit") key += `:${evt.detail?.index ?? ""}`;
        else if (evt.kind === "scroll") {
          key = "scroll";
          windowMs = SCROLL_WINDOW_MS;
        }
        if (!throttlerRef.current.shouldEmit(key, now, windowMs)) return;
        onPageEventRef.current?.(evt);
      } else if (data.type === "page:ready") {
        readyRef.current = true;
      } else if (data.type === "page:exec:result" || data.type === "page:app-cmd:result") {
        const rid = (data as { requestId?: string }).requestId;
        const p = pendingRef.current.get(rid as string);
        if (p) {
          clearTimeout(p.timer);
          pendingRef.current.delete(rid as string);
          p.resolve({
            type: "page:exec:result",
            requestId: String(rid ?? ""),
            ok: (data as { ok?: boolean }).ok === true,
            error: (data as { error?: string }).error,
            data: (data as { data?: unknown }).data,
          });
        }
      }
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      rejectPending("页面已关闭");
      readyRef.current = false;
      stopMaterialTts(); // ISSUE-011：面板卸载停止资料朗读
      showLookup(null); // ISSUE-017：卸载关闭查词浮层
    };
  }, [rejectPending, stopMaterialTts, showLookup]);

  // ISSUE-017：Esc 关闭查词浮层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") showLookup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showLookup]);

  // 下行指令：postMessage 到 iframe，requestId 配对等待回执（10s 超时）
  const exec = useCallback(
    (action: PageAction, params?: PageExecParams): Promise<PageExecResultUplink> => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !readyRef.current) {
        return Promise.resolve(failedExec("页面未就绪或已关闭"));
      }
      const requestId = genRequestId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({ type: "page:exec:result", requestId, ok: false, error: "页面无响应（10 秒超时）" });
        }, EXEC_TIMEOUT_MS);
        pendingRef.current.set(requestId, { resolve, timer });
        const downlink: PageExecDownlink = { type: "page:exec", requestId, action, ...(params || {}) };
        iframeWin.postMessage(downlink, "*");
      });
    },
    []
  );

  // MATERIAL-BRIDGE-PROTOCOL：宿主→页面作者命令（page:app-cmd，页面 PiBridge.on 接收；与 exec 同一套 pending/就绪/超时）。
  // 竞态修复（2026-09-08 实测「no handler for action: scene.say」）：iframe 刚加载/重建时 BRIDGE 的 page:ready
  // 先到（宿主放行），而页面 body 的 PiBridge.on 注册可能晚几百毫秒才执行 → 命令早到会 no handler。
  // 对策：no-handler 且命令重试成本低 → 自动稍等重试一次再报错。
  const appCmd = useCallback((action: string, payload?: unknown): Promise<PageExecResultUplink> => {
    const sendOnce = (): Promise<PageExecResultUplink> => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !readyRef.current) {
        return Promise.resolve(failedExec("页面未就绪或已关闭"));
      }
      const requestId = genRequestId();
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pendingRef.current.delete(requestId);
          resolve({ type: "page:exec:result", requestId, ok: false, error: "页面无响应（10 秒超时）" });
        }, EXEC_TIMEOUT_MS);
        pendingRef.current.set(requestId, { resolve, timer });
        iframeWin.postMessage(
          { type: "page:app-cmd", requestId, action, payload: payload === undefined ? null : payload },
          "*"
        );
      });
    };
    return sendOnce().then(async (first) => {
      // 页面已握手但业务 handler 未注册（页面 body 尚未跑完）→ 等 700ms 让注册完成再试一次
      if (!first.ok && typeof first.error === "string" && first.error.indexOf("no handler") === 0) {
        await new Promise((r) => setTimeout(r, 700));
        if (iframeRef.current?.contentWindow && readyRef.current) {
          return sendOnce();
        }
      }
      return first;
    });
  }, []);

  // scene(command, params)（场景演出下行 scene.<cmd>，ISSUE-061）已随场景会话下线删除（2026-09-25）。
  // 页面作者命令仍可走 appCmd（page:app-cmd），供将来其它受控下行使用。

  // 资料内容/选中项变化 → iframe 即将重建，就绪态立即复位（新页面 page:ready 到达前指令一律
  // 报「加载中」，不再把指令发给半成品的 iframe）。组件卸载时也复位。
  const contentKey = selected ? `${selected.id}|${(selected.content ?? "").length}` : "none";
  const wasContentKeyRef = useRef(contentKey);
  if (wasContentKeyRef.current !== contentKey) {
    wasContentKeyRef.current = contentKey;
    readyRef.current = false;
  }

  // —— MATERIAL-BRIDGE-PROTOCOL：页面 PiBridge.request 的宿主能力处理（page:req → page:app-res）——
  const handleAppRequest = useCallback(
    async (action: string, payload: unknown, requestId: string) => {
      const iframeWin = iframeRef.current?.contentWindow;
      if (!iframeWin || !requestId) return;
      let ok = false;
      let data: unknown;
      let error: string | undefined;
      try {
        if (action === "tts.speak") {
          const text = String((payload as { text?: unknown } | null)?.text ?? "");
          if (!text.trim()) {
            error = "tts.speak 缺少 text";
          } else {
            // queue：场景页的多句台词/点读请求逐条排队播放，后一句不覆盖前一句
            await speakMaterialText(text, { queue: true });
            ok = true;
          }
        } else {
          error = `PiBridge 未知宿主能力: ${action}`;
        }
      } catch (e: any) {
        error = e?.message || String(e);
      }
      iframeWin.postMessage(
        { type: "page:app-res", requestId, ok, ...(data !== undefined ? { data } : {}), ...(error ? { error } : {}) },
        "*"
      );
    },
    [speakMaterialText]
  );

  useImperativeHandle(ref, () => ({ exec, appCmd }), [exec, appCmd]);

  // ISSUE-030：资料字号变化 → 运行期下发 iframe（内容未变则 iframe 不重建，靠消息即时生效；
  // 首次挂载的初始化字号由 injectBridge 注入 window.__PI_MAT_FONT，这里只处理后续变更）。
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (win && readyRef.current) {
      win.postMessage({ type: "page:mat-font", px: matFontSize }, "*");
    }
  }, [matFontSize]);

  // 详情视图
  if (selected) {
    const kind: MaterialKind = selected.kind ?? kindFromPath(selected.filePath);
    // 内联类（html/text）没有正文就没得渲染；媒体类**正文本来就是空的**（二进制不进事件），
    // 有路径就能放——不要用"正文为空"把媒体误判成空资料（这是 KB P1 放开媒体时最容易踩的坑）。
    const needsInline = kind === "html" || kind === "text";
    // 兜底：内容为空时显示提示，避免空 srcDoc iframe 白屏（display_content 文件读取竞态、
    // IPC 截断等边缘场景曾触发）；同时清洗后端偶发的 \r 与首尾空白。
    const cleanHtml = (selected.content ?? "").replace(/\r/g, "").trim();
    const mediaUrl = needsInline ? "" : resolveSharedMediaUrl(selected.filePath, kind, htmlEpoch);
    if ((needsInline && !cleanHtml) || (!needsInline && !mediaUrl)) {
      return (
        <div className="content-panel" style={materialFontStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 8 }}>
            <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
            {!bare && selected.title && (
              <h2 className="material-title" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {selected.title}
              </h2>
            )}
          </div>
          <div className="placeholder">
            📄
            <br />
            {needsInline ? "资料内容为空，可让 AI 老师重新展示" : "这份资料读不到，可让 AI 老师重新展示"}
          </div>
        </div>
      );
    }
    return (
      <div className="content-panel" style={materialFontStyle} onClick={closeLookup}>
        {/* ISSUE-158 续（用户反馈）：详情头部的「收起学习资料」折叠按钮去掉（列表页仍可收起）；
            标题移到返回键右侧同一行，省一行高度给资料正文 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, marginBottom: 8 }}>
          <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
          {!bare && selected.title && (
            <h2
              className="material-title"
              style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {selected.title}
            </h2>
          )}
        </div>
        {kind === "html" ? (
          <HtmlFrame
            // ISSUE-061 根治：服务端共享资料（filePath 可解析为 materials 相对路径）走真实 URL 顶层文档
            //（asset://...?doc=1，协议层注入桥）→ 正文脚本随导航执行；本地产物/无 filePath 回退 dataURL。
            docUrl={resolveSharedDocUrl(selected.filePath, matFontSize, htmlEpoch)}
            html={injectBridge(cleanHtml, matFontSize)}
            title={selected.title}
            iframeRef={iframeRef}
            refreshEpoch={htmlEpoch}
            onLoad={() => {
              rejectPending("页面已刷新");
              showLookup(null); // ISSUE-017：资料刷新后旧浮层坐标失效
            }}
          />
        ) : kind === "text" ? (
          /\.md$/i.test(selected.filePath ?? "") ? (
            <div className="markdown-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanHtml}</ReactMarkdown>
            </div>
          ) : (
            <pre className="material-text-body">{cleanHtml}</pre>
          )
        ) : kind === "image" ? (
          <img className="material-media" src={mediaUrl} alt={selected.title || "学习资料"} />
        ) : kind === "audio" ? (
          <audio className="material-media" src={mediaUrl} controls preload="metadata" />
        ) : kind === "pdf" ? (
          // KB P2：Chromium 自带阅读器内联渲染（`#toolbar=0` 已把阅读器 UI 收掉，见 resolveSharedMediaUrl）。
          // 不用 <embed>：Electron 里两者都行（探针实测），iframe 在 Web 端口径一致、样式可控。
          <iframe className="material-media material-pdf" src={mediaUrl} title={selected.title || "学习资料"} />
        ) : (
          <video className="material-media" src={mediaUrl} controls playsInline preload="metadata" />
        )}
        {/* ISSUE-017 优化：选词先出悬浮图标，点击图标才展开查词弹框
            （fixed 定位；点击外部空白/Esc/滚动收起；弹框展示即记错题本） */}
        {lookup && !lookup.open && (
          <WordLookupBubble x={lookup.anchor.x} y={lookup.anchor.y} onOpen={openLookupPopup} />
        )}
        {lookup?.open && (
          <WordLookupOverlay
            state={lookup.anchor}
            onSpeak={speakMaterialText}
            onClose={closeLookup}
            onReport={(text, pinyin, meaning) => {
              if (!childId) return;
              void window.api
                .mistakeReport({ childId, kind: "unknown_word", content: text, detail: [pinyin, meaning].filter(Boolean).join("："), source: "lookup" })
                .catch(() => {});
            }}
          />
        )}
      </div>
    );
  }

  // 列表视图
  return (
    <div className="content-panel" style={materialFontStyle}>
      <div className="material-list-header">
        <span className="material-list-title">学习资料</span>
        <span className="material-list-count">{materials.length} 份</span>
        {onCollapse && (
          <IconButton
            icon={PanelRightClose}
            title="收起学习资料"
            onClick={onCollapse}
            className="material-collapse-btn"
            style={{ marginLeft: "auto" }}
          />
        )}
      </div>
      {materials.length === 0 ? (
        <div className="placeholder">
          📖
          <br />
          AI 老师会把学习资料展示在这里
        </div>
      ) : (
        <div className="material-list">
          {materials.map((m) => (
            <button key={m.id} className="material-row" onClick={() => onOpen(m.id)}>
              <span className="material-row-icon">
                {m.kind === "image" ? "🖼️" : m.kind === "audio" ? "🎵" : m.kind === "video" ? "🎬" : m.kind === "text" ? "📄" : "🎮"}
              </span>
              <span className="material-row-body">
                <span className="material-row-title">{m.title || "未命名资料"}</span>
                <span className="material-row-time">{m.time}</span>
              </span>
              <span className="material-row-arrow">›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

export default MaterialsPanel;

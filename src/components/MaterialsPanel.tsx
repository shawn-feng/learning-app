import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import IconButton from "./IconButton";
import { ArrowLeft } from "lucide-react";

export interface Material {
  id: string;
  format: "html";
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
}

/**
 * HTML 内容通过沙盒 iframe 渲染。
 * sandbox="allow-scripts" 让 JS 可以运行（番茄钟、点击交互等），
 * 但不带 allow-same-origin，iframe 处于不透明源，脚本无法读取父页面 DOM / cookie，
 * 保证 AI 生成的内容被隔离在安全边界内。
 */
function HtmlFrame({ html, title }: { html: string; title?: string }) {
  // key 强制 iframe 重建：React/Chromium 在 srcDoc 字符串变化时更新属性但不保证重载（已知
  // Electron 沙箱 iframe 偶发"内容不渲染/白屏"，必现于 display_content 去重后再展示同一份资料
  // 的场景）。用 html 长度做轻量 key，内容真有变化才重建（避免每次 set render 都销毁重建）。
  return (
    <iframe
      key={html.length}
      className="html-frame"
      sandbox="allow-scripts allow-modals allow-forms"
      srcDoc={html}
      title={title || "学习内容"}
    />
  );
}

/**
 * 学习资料面板：列表 + 详情两态。
 * - 列表：每一行是一次学习资料（当前会话里 AI 展示过的全部资料）
 * - 详情：点开后展示该份资料，可「返回列表」
 */
export default function MaterialsPanel({ materials, selectedId, onOpen, onBack }: Props) {
  const selected = materials.find((m) => m.id === selectedId);

  // 详情视图
  if (selected) {
    // 兜底：内容为空时显示提示，避免空 srcDoc iframe 白屏（display_content 文件读取竞态、
    // IPC 截断等边缘场景曾触发）；同时清洗后端偶发的 \r 与首尾空白。
    const cleanHtml = (selected.content ?? "").replace(/\r/g, "").trim();
    if (!cleanHtml) {
      return (
        <div className="content-panel">
          <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
          {selected.title && <h2 className="material-title">{selected.title}</h2>}
          <div className="placeholder">
            📄
            <br />
            资料内容为空，可让 AI 老师重新展示
          </div>
        </div>
      );
    }
    return (
      <div className="content-panel">
        <IconButton icon={ArrowLeft} title="返回列表" onClick={onBack} className="material-back" />
        {selected.title && <h2 className="material-title">{selected.title}</h2>}
        {selected.format === "html" ? (
          <HtmlFrame html={cleanHtml} title={selected.title} />
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{cleanHtml}</ReactMarkdown>
          </div>
        )}
      </div>
    );
  }

  // 列表视图
  return (
    <div className="content-panel">
      <div className="material-list-header">
        <span className="material-list-title">学习资料</span>
        <span className="material-list-count">{materials.length} 份</span>
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
              <span className="material-row-icon">{m.format === "html" ? "🎮" : "📄"}</span>
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
}

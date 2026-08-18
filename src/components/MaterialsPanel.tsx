import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
  return (
    <iframe
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
    return (
      <div className="content-panel">
        <button className="material-back" onClick={onBack}>
          ← 返回列表
        </button>
        {selected.title && <h2 className="material-title">{selected.title}</h2>}
        {selected.format === "html" ? (
          <HtmlFrame html={selected.content} title={selected.title} />
        ) : (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.content}</ReactMarkdown>
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

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface PanelContent {
  format: "markdown" | "html";
  content: string;
  title?: string;
}

interface Props {
  content: PanelContent | null;
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

export default function ContentPanel({ content }: Props) {
  if (!content) {
    return (
      <div className="content-panel">
        <div className="placeholder">
          📖
          <br />
          AI 老师会把学习内容展示在这里
        </div>
      </div>
    );
  }

  return (
    <div className="content-panel">
      {content.title && <h2 style={{ color: "#667eea", marginBottom: 12 }}>{content.title}</h2>}
      {content.format === "html" ? (
        <HtmlFrame html={content.content} title={content.title} />
      ) : (
        <div className="markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content.content}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

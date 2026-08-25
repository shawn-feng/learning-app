import type { LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** lucide 图标组件，如 Send / Mic / Settings */
  icon: LucideIcon;
  /** 悬停提示文字，同时作为 aria-label（无障碍）；等于原按钮文字描述 */
  title: string;
  /** 激活/选中态（如「显示历史会话」开启时），紫底白字高亮 */
  active?: boolean;
  /** 破坏性操作（删除/清空等），hover 红色提示，避免误触 */
  danger?: boolean;
  /** 图标像素尺寸，默认 20（儿童友好：够大够清晰） */
  size?: number;
  /** 可选的图标旁文字（icon+文字 模式），用于主 CTA 兼顾可读性与紧凑 */
  label?: ReactNode;
  /** 图标额外 className */
  iconClassName?: string;
}

/**
 * 统一图标按钮：把「emoji + 文字」按钮收敛为「纯 icon + 原生 title tooltip」。
 * 设计意图（ISSUE-047）：① 节省横向空间、界面更紧凑；② hover 显示名称（原生 title，
 * 零成本且已被大量按钮复用）；③ 统一可访问性（aria-label=title、focus 可见）、
 * 紫色主题、儿童友好（固定较大尺寸、高对比 hover）。
 * 调用方约定：纯图标用 <IconButton icon={X} title="名称" />；主 CTA 可加 label 做 icon+文字。
 */
export function IconButton({
  icon: Icon,
  title,
  active = false,
  danger = false,
  size = 20,
  label,
  className = '',
  iconClassName = '',
  ...rest
}: IconButtonProps) {
  const cls = [
    'icon-btn',
    active ? 'active' : '',
    danger ? 'danger' : '',
    label != null ? 'with-label' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" title={title} aria-label={title} className={cls} {...rest}>
      <Icon size={size} className={`icon-btn-glyph${iconClassName ? ' ' + iconClassName : ''}`} aria-hidden="true" />
      {label != null && <span className="icon-btn-label">{label}</span>}
    </button>
  );
}

export default IconButton;

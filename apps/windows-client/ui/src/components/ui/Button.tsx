// Button(UI · components/ui 基础组件):统一样式的按钮(变体/尺寸/禁用/加载),纯展示+回调,全站复用。
// 样式集中在 styles.css 的 .ui-btn 体系;组件本身不内联 style,避免内联覆盖 CSS 造成按钮外观不统一。
import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

// 供对比度单测引用:主按钮基准色(与 styles.css --control-primary-bg 对齐)。
export const PRIMARY_ACTION_BACKGROUND = '#b5482f';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  const cls = `ui-btn ui-btn--${variant} ui-btn--${size}${className ? ` ${className}` : ''}`;
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标按钮必须提供的无障碍标签。 */
  label: string;
  size?: ButtonSize;
  children?: ReactNode;
}

export function IconButton({ label, size = 'md', type = 'button', className, children, ...rest }: IconButtonProps) {
  // md 是基础尺寸(styles.css .ui-icon-btn 默认 30px),不额外挂类;仅 sm 需要 --sm 覆盖。
  const cls = `ui-icon-btn${size === 'sm' ? ' ui-icon-btn--sm' : ''}${className ? ` ${className}` : ''}`;
  return (
    <button type={type} aria-label={label} title={label} className={cls} {...rest}>
      {children}
    </button>
  );
}

export default Button;

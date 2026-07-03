// Button(UI · components/ui 基础组件):统一样式的按钮(变体/尺寸/禁用/加载),纯展示+回调,全站复用。
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export const PRIMARY_ACTION_BACKGROUND = '#b5482f';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const base: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  border: '1px solid transparent',
  borderRadius: 12,
  cursor: 'pointer',
  fontSize: 13,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const sizeStyles: Record<ButtonSize, CSSProperties> = {
  sm: { padding: '3px 8px', fontSize: 12 },
  md: { padding: '6px 12px' },
};

const variantStyles: Record<ButtonVariant, CSSProperties> = {
  primary: { background: `var(--primary-action-bg, ${PRIMARY_ACTION_BACKGROUND})`, color: '#fff', borderColor: `var(--primary-action-bg, ${PRIMARY_ACTION_BACKGROUND})` },
  secondary: { background: 'var(--surface, #fff)', color: 'var(--fg, #374151)', borderColor: 'var(--border, #d1d5db)' },
  ghost: { background: 'transparent', color: 'var(--fg, #374151)' },
  danger: { background: 'var(--danger, #b91c1c)', color: '#fff', borderColor: 'var(--danger, #b91c1c)' },
};

export function Button({
  variant = 'secondary',
  size = 'md',
  type = 'button',
  className,
  style,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const cls = `ui-btn ui-btn--${variant} ui-btn--${size}${className ? ` ${className}` : ''}`;
  return (
    <button
      type={type}
      className={cls}
      disabled={disabled}
      style={{ ...base, ...sizeStyles[size], ...variantStyles[variant], ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}), ...style }}
      {...rest}
    >
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

export function IconButton({ label, size = 'md', type = 'button', className, style, children, ...rest }: IconButtonProps) {
  const dim = size === 'sm' ? 24 : 30;
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`ui-icon-btn${className ? ` ${className}` : ''}`}
      style={{
        ...base,
        width: dim,
        height: dim,
        padding: 0,
        background: 'transparent',
        color: 'var(--fg, #374151)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

export default Button;

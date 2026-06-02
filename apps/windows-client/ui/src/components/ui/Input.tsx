// Input(UI · components/ui 基础组件):统一样式的输入框(尺寸/状态/前后缀),纯展示+回调,表单复用。
import type { CSSProperties, InputHTMLAttributes } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

const fieldStyle: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4 };
const labelStyle: CSSProperties = { fontSize: 12, color: 'var(--muted, #6b7280)' };
const inputBase: CSSProperties = {
  padding: '6px 10px',
  fontSize: 13,
  borderRadius: 6,
  border: '1px solid var(--border, #d1d5db)',
  background: 'var(--surface, #fff)',
  color: 'var(--fg, #374151)',
};
const errorTextStyle: CSSProperties = { fontSize: 12, color: 'var(--danger, #b91c1c)' };

export function Input({ label, error, id, className, style, ...rest }: InputProps) {
  const inputId = id ?? (label ? `ui-input-${label}` : undefined);
  return (
    <div className="ui-field" style={fieldStyle}>
      {label ? (
        <label className="ui-field__label" htmlFor={inputId} style={labelStyle}>
          {label}
        </label>
      ) : null}
      <input
        id={inputId}
        className={`ui-input${error ? ' ui-input--error' : ''}${className ? ` ${className}` : ''}`}
        aria-invalid={error ? true : undefined}
        style={{ ...inputBase, ...(error ? { borderColor: 'var(--danger, #b91c1c)' } : {}), ...style }}
        {...rest}
      />
      {error ? (
        <div className="ui-field__error" role="alert" style={errorTextStyle}>
          {error}
        </div>
      ) : null}
    </div>
  );
}

export default Input;

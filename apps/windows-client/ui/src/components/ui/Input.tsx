import type { CSSProperties, InputHTMLAttributes } from 'react';

// UI primitive (FE-2a): labelled text input with optional error message.
// Accessible (label htmlFor, aria-invalid, role=alert on error). Self-contained.

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

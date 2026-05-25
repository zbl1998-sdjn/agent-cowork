import type { CSSProperties, ReactNode } from 'react';

// Reusable empty / loading / error state views (FE-3).
// Self-contained: minimal inline styling so they render correctly without
// touching the shared styles.css. Semantic class names are kept so the theme
// layer can style them later. Chinese, accessible (role/aria) by default.

const container: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 8,
  padding: '24px 16px',
  textAlign: 'center',
  color: 'var(--muted, #6b7280)',
};

const titleStyle: CSSProperties = { fontSize: 14, fontWeight: 600, color: 'var(--fg, #374151)' };
const messageStyle: CSSProperties = { fontSize: 13, lineHeight: 1.5 };

export interface EmptyProps {
  title?: string;
  message?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function Empty({ title = '暂无内容', message, icon, action }: EmptyProps) {
  return (
    <div className="state-view state-view--empty" role="status" style={container}>
      {icon ? <div className="state-view__icon" aria-hidden="true">{icon}</div> : null}
      <div className="state-view__title" style={titleStyle}>{title}</div>
      {message ? <div className="state-view__message" style={messageStyle}>{message}</div> : null}
      {action ? <div className="state-view__action">{action}</div> : null}
    </div>
  );
}

export interface LoadingProps {
  message?: string;
}

export function Loading({ message = '加载中…' }: LoadingProps) {
  const spinner: CSSProperties = {
    width: 14,
    height: 14,
    borderRadius: '50%',
    border: '2px solid var(--border, #d1d5db)',
    borderTopColor: 'var(--accent, #2563eb)',
    display: 'inline-block',
  };
  return (
    <div
      className="state-view state-view--loading"
      role="status"
      aria-busy="true"
      style={{ ...container, flexDirection: 'row' }}
    >
      <span className="state-view__spinner" aria-hidden="true" style={spinner} />
      <span className="state-view__message" style={messageStyle}>{message}</span>
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({
  title = '出错了',
  message = '发生未知错误。',
  onRetry,
  retryLabel = '重试',
}: ErrorStateProps) {
  const retryStyle: CSSProperties = {
    marginTop: 4,
    padding: '4px 12px',
    fontSize: 13,
    cursor: 'pointer',
    borderRadius: 6,
    border: '1px solid var(--border, #d1d5db)',
    background: 'var(--surface, #fff)',
    color: 'var(--fg, #374151)',
  };
  return (
    <div className="state-view state-view--error" role="alert" style={container}>
      <div className="state-view__title" style={{ ...titleStyle, color: 'var(--danger, #b91c1c)' }}>{title}</div>
      <div className="state-view__message" style={messageStyle}>{message}</div>
      {onRetry ? (
        <button type="button" className="state-view__retry" onClick={onRetry} style={retryStyle}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

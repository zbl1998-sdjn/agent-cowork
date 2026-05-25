import type { CSSProperties, ReactNode } from 'react';

// UI primitive (FE-2a): simple content card with an optional title. Themeable
// via class names, minimal inline styling, self-contained.

export interface CardProps {
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--border, #e5e7eb)',
  borderRadius: 10,
  background: 'var(--surface, #fff)',
  overflow: 'hidden',
};

export function Card({ title, children, className, style }: CardProps) {
  return (
    <div className={className ? `ui-card ${className}` : 'ui-card'} style={{ ...cardStyle, ...style }}>
      {title != null && title !== '' ? (
        <div
          className="ui-card__title"
          style={{ padding: '10px 14px', fontSize: 13, fontWeight: 600, borderBottom: '1px solid var(--border, #e5e7eb)' }}
        >
          {title}
        </div>
      ) : null}
      <div className="ui-card__body" style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

export default Card;

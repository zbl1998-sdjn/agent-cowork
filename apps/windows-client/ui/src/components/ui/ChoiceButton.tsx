import type { CSSProperties, ReactNode } from 'react';
import { Button } from './Button';

interface ChoiceButtonProps {
  className?: string;
  detail?: ReactNode;
  disabled?: boolean;
  label: ReactNode;
  selected?: boolean;
  tone?: 'neutral' | 'warm';
  onClick: () => void;
}

export function ChoiceButton({ className, detail, disabled, label, selected = false, tone = 'neutral', onClick }: ChoiceButtonProps) {
  const borderColor = selected ? 'var(--accent)' : tone === 'warm' ? '#d9ded5' : 'var(--border)';
  const style: CSSProperties = {
    width: '100%',
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
    flexDirection: 'column',
    gap: 2,
    textAlign: 'left',
    borderColor,
    background: tone === 'warm' ? '#fff' : 'var(--surface)',
    color: 'var(--text)',
    borderRadius: 10,
    padding: '8px 10px',
  };
  return (
    <Button className={className ? `${className}${selected ? ' is-chosen' : ''}` : selected ? 'is-chosen' : ''} disabled={disabled} onClick={onClick} style={style}>
      <strong style={{ fontSize: 13, fontWeight: 600 }}>{label}</strong>
      {detail ? <span style={{ color: 'var(--muted)', fontSize: 12 }}>{detail}</span> : null}
    </Button>
  );
}

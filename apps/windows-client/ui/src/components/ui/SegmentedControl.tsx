import type { CSSProperties } from 'react';
import { Button } from './Button';

type SegmentValue = string | boolean;

export interface SegmentedControlOption<T extends SegmentValue> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends SegmentValue> {
  ariaLabel: string;
  className: string;
  options: Array<SegmentedControlOption<T>>;
  value: T;
  onChange: (value: T) => void;
  variant?: 'sidebar' | 'segmented';
}

function optionStyle(active: boolean, variant: 'sidebar' | 'segmented'): CSSProperties {
  if (variant === 'sidebar') {
    return {
      width: '100%',
      justifyContent: 'flex-start',
      textAlign: 'left',
      border: 'none',
      background: active ? 'var(--bg)' : 'none',
      color: active ? 'var(--text)' : 'var(--muted)',
      borderRadius: 8,
      padding: '9px 12px',
      fontSize: 13,
      fontWeight: active ? 600 : undefined,
    };
  }
  return {
    border: 'none',
    background: active ? 'var(--surface)' : 'none',
    color: active ? 'var(--text)' : 'var(--muted)',
    borderRadius: 7,
    padding: '6px 16px',
    fontSize: 13,
    fontWeight: active ? 500 : undefined,
    boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
  };
}

export function SegmentedControl<T extends SegmentValue>({
  ariaLabel,
  className,
  options,
  value,
  onChange,
  variant = 'segmented',
}: SegmentedControlProps<T>) {
  const isTabs = variant === 'sidebar';
  return (
    <div className={className} role={isTabs ? 'tablist' : 'group'} aria-label={ariaLabel}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <Button
            key={String(option.value)}
            variant="ghost"
            role={isTabs ? 'tab' : undefined}
            aria-selected={isTabs ? active : undefined}
            aria-pressed={isTabs ? undefined : active}
            className={active ? 'is-active' : ''}
            onClick={() => onChange(option.value)}
            style={optionStyle(active, variant)}
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

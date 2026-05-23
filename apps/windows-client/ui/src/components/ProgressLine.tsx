export interface ProgressLineProps {
  status?: 'pending' | 'running' | 'done' | 'failed' | 'wait';
  icon?: string;
  text: string;
  duration?: string;
}

export function ProgressLine({ status = 'wait', text, duration }: ProgressLineProps) {
  return (
    <div className={`progress-line is-${status}`}>
      <span className="progress-text">{text}</span>
      {duration && <span className="progress-meta">{duration}</span>}
    </div>
  );
}

export function progressStatusFromIcon(icon?: string): ProgressLineProps['status'] {
  if (icon === 'check') return 'done';
  if (icon === 'loader') return 'running';
  return 'wait';
}

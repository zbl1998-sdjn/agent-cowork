import { progressStatusFromIcon, type ProgressStatus } from '../lib/app-logic';

export interface ProgressLineProps {
  status?: ProgressStatus;
  icon?: string;
  text: string;
  duration?: string;
}

export { progressStatusFromIcon };

export function ProgressLine({ status = 'wait', text, duration }: ProgressLineProps) {
  return (
    <div className={`progress-line is-${status}`}>
      <span className="progress-text">{text}</span>
      {duration && <span className="progress-meta">{duration}</span>}
    </div>
  );
}

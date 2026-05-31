// ProgressLine(UI · components):单行进度条目——展示 Agent 运行中的一步进度(图标+文本+状态),用于时间线进度流。纯展示。
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

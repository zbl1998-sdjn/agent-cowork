// 进度行(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:渲染 Agent 运行中的单步进度(状态样式 + 文本 + 可选耗时),用于时间线进度流。只渲染。
// 依赖:lib/app-logic 的 ProgressStatus 类型(并转出 progressStatusFromIcon)。关键 props:status、text、duration。
import { progressStatusFromIcon } from '../lib/app-logic';
import type { ProgressLineProps } from '../lib/types/progress';

export { progressStatusFromIcon };
export type { ProgressLineProps } from '../lib/types/progress';

export function ProgressLine({ status = 'wait', text, duration }: ProgressLineProps) {
  return (
    <div className={`progress-line is-${status}`}>
      <span className="progress-text">{text}</span>
      {duration && <span className="progress-meta">{duration}</span>}
    </div>
  );
}

import type { RunStatus } from '../lib/types';

export interface TaskStatusBadgeProps {
  runId?: string;
  status: RunStatus | string;
  activeForm?: string;
}

const LABEL: Record<string, string> = {
  pending: '排队中',
  planning: '计划中',
  awaiting_approval: '等待审批',
  applying: '执行中',
  done: '完成',
  failed: '失败',
};

export function TaskStatusBadge({ status, activeForm }: TaskStatusBadgeProps) {
  const variant = status === 'failed' ? 'failed' : status === 'done' ? 'done'
    : status === 'awaiting_approval' ? 'warn' : 'active';
  return (
    <span className={`task-badge badge-${variant}`}>
      {activeForm || LABEL[status] || String(status)}
    </span>
  );
}

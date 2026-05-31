// TaskStatusBadge(UI · components):任务状态徽标——把运行状态(运行中/成功/失败/取消等)渲染成带色徽标。纯展示。
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
  cancelled: '已取消',
};

export function TaskStatusBadge({ status, activeForm }: TaskStatusBadgeProps) {
  const variant = status === 'failed' ? 'failed' : status === 'done' ? 'done' : status === 'cancelled' ? 'warn'
    : status === 'awaiting_approval' ? 'warn' : 'active';
  return (
    <span className={`task-badge badge-${variant}`}>
      {activeForm || LABEL[status] || String(status)}
    </span>
  );
}

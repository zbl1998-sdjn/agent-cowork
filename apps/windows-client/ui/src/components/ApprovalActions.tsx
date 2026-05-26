import type { ApprovalState, FileOperation } from '../lib/types';
import { Button } from './ui/Button';

export interface ApprovalActionsProps {
  runId: string;
  operations: FileOperation[];
  approvalState: ApprovalState;
  onApprove: () => void;
  onReject: () => void;
  onViewDiff?: () => void;
}

export function ApprovalActions({ approvalState, onApprove, onReject, onViewDiff }: ApprovalActionsProps) {
  if (approvalState === 'approved') {
    return <div className="approval-done">已审批 · 已写入本机</div>;
  }
  if (approvalState === 'rejected') {
    return <div className="approval-done is-rejected">已拒绝</div>;
  }
  return (
    <div className="approval-actions">
      <Button variant="primary" onClick={onApprove}>审批执行</Button>
      {onViewDiff && <Button variant="secondary" onClick={onViewDiff}>查看 diff</Button>}
      <Button variant="danger" onClick={onReject}>拒绝</Button>
    </div>
  );
}

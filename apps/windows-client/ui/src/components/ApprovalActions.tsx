// 审批操作条(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:按审批状态渲染待审批的写操作——pending 显示「审批执行/查看 diff/拒绝」,完成后显示已审批或已拒绝;仅回传决定。
// 依赖:Button;状态/操作类型来自 lib/types。关键回调:onApprove / onReject / onViewDiff。
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

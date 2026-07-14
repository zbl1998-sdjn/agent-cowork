// ApprovalDecisionBar(UI · components/chat):呈现单项审批风险/预览，并在 Host 明确确认后清除卡片。
import { usePendingAction } from '../../hooks/usePendingAction';
import { respondApproval } from '../../lib/api';
import type { AssistantMessage } from '../../lib/app-types';
import { clearAcknowledgedAssistantRequest, requireAcknowledgement } from '../../lib/pending-action';
import { Button } from '../ui/Button';
import { ApprovalDiffView, isDiffPreview } from './ApprovalDiffView';

type PatchAssistant = (id: string, patch: (message: AssistantMessage) => AssistantMessage) => void;

function formatApprovalPreview(preview: unknown): string {
  if (typeof preview === 'string') return preview;
  try {
    return JSON.stringify(preview, null, 2);
  } catch {
    return '审批预览无法显示';
  }
}

export function ApprovalDecisionBar({ message, onPatchAssistant }: { message: AssistantMessage; onPatchAssistant: PatchAssistant }) {
  const approval = message.approval;
  const { pending, error, run } = usePendingAction('提交审批决定');
  const respond = (decision: 'once' | 'session' | 'reject') => {
    if (!approval) return;
    void run(() => requireAcknowledgement(
      () => respondApproval(approval.id, decision),
      () => onPatchAssistant(message.id, (current) => clearAcknowledgedAssistantRequest(current, 'approval', approval.id)),
    ));
  };
  if (!approval) return null;
  return (
    <div className="approval-bar">
      <span className="approval-q">需要批准操作：<code>{approval.name}</code></span>
      {approval.risk && <span className="approval-q">风险级别：<code>{approval.risk}</code></span>}
      {isDiffPreview(approval.preview)
        ? <ApprovalDiffView preview={approval.preview} />
        : approval.preview != null && <pre className="approval-preview">{formatApprovalPreview(approval.preview)}</pre>}
      <div className="approval-actions">
        <Button variant="primary" disabled={pending} onClick={() => respond('once')}>{pending ? '提交中…' : '本次批准'}</Button>
        {approval.sessionReusable === true && <Button variant="secondary" disabled={pending} onClick={() => respond('session')}>本会话批准</Button>}
        <Button variant="danger" disabled={pending} onClick={() => respond('reject')}>拒绝</Button>
      </div>
      {(error || approval.error) && <div className="panel-error" role="alert">{error || approval.error}</div>}
    </div>
  );
}

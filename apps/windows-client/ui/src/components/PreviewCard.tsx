import type { FileOperation } from '../lib/types';

export interface PreviewCardProps {
  operations: FileOperation[];
  summary?: string;
  risk?: 'low' | 'medium' | 'high' | string;
}

function opTarget(op: FileOperation): string {
  return op.targetPath || op.path || '待执行操作';
}

export function PreviewCard({ operations, summary = '等待审批', risk }: PreviewCardProps) {
  const shown = operations.slice(0, 4);
  return (
    <div className="preview-card">
      <header>
        <strong>操作预览</strong>
        <em className={`risk-${risk || 'low'}`}>{summary}</em>
      </header>
      {shown.map((op, index) => (
        <div className="preview-op" key={`${op.type}-${index}`}>
          <span className={op.type === 'write' ? 'op is-write' : 'op'}>{op.type}</span>
          <p>{opTarget(op)}</p>
        </div>
      ))}
      {operations.length > shown.length && (
        <p className="preview-more">另有 {operations.length - shown.length} 个操作会在审批后执行。</p>
      )}
    </div>
  );
}

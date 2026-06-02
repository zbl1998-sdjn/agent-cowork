// 文件操作预览卡(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:把待审批的文件操作列表(write/rename/move 等)渲染成预览卡,展示操作类型、目标路径与风险等级,超出 4 条折叠提示。只渲染。
// 依赖:lib/types 的 FileOperation。关键 props:operations、summary、risk。
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

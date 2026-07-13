// ComposerAttachments(UI · components):输入框附件区——展示已选文件/图片缩略、支持移除,供随消息上传。纯展示+回调。
import { IconButton } from './ui/Button';

interface ComposerAttachmentsProps {
  attachments: File[];
  templateFiles?: File[] | undefined;
  onRemove: (index: number) => void;
  onToggleTemplate?: ((index: number) => void) | undefined;
}

export function formatAttachmentSize(size: unknown): string {
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function attachmentBatchSummary(files: File[]): string {
  const total = files.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  return `已选 ${files.length} 个文件 · ${formatAttachmentSize(total)}`;
}

const TEMPLATE_FILE_RE = /\.(docx|xlsx|pptx|html?)$/i;

export function ComposerAttachments({ attachments, templateFiles = [], onRemove, onToggleTemplate }: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null;
  const summary = attachmentBatchSummary(attachments);
  return (
    <div className="composer-attachments" aria-label={summary}>
      {attachments.length > 1 && <span className="attachment-summary">{summary}</span>}
      {attachments.map((file, index) => (
        <span key={`${file.name}-${file.size}-${index}`} className="attachment-chip" title={`${file.name} · ${formatAttachmentSize(file.size)}`}>
          <span className="attachment-name">{file.name}</span>
          <span className="attachment-size">{formatAttachmentSize(file.size)}</span>
          {templateFiles.includes(file) && <span className="attachment-template-badge">模板已锁定</span>}
          {onToggleTemplate && TEMPLATE_FILE_RE.test(file.name) && (
            <IconButton
              className="attachment-template-toggle"
              label={`${templateFiles.includes(file) ? '取消' : '设为'}版式模板 ${file.name}`}
              size="sm"
              onClick={() => onToggleTemplate(index)}
            >T</IconButton>
          )}
          <IconButton
            className="attachment-remove"
            label="移除附件"
            size="sm"
            onClick={() => onRemove(index)}
            style={{ width: 18, height: 18, border: 'none', background: 'transparent', color: '#8a8f84', fontSize: 14, lineHeight: 1 }}
          >
            ×
          </IconButton>
        </span>
      ))}
    </div>
  );
}

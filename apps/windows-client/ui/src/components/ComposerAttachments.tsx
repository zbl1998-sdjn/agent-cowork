import { IconButton } from './ui/Button';

interface ComposerAttachmentsProps {
  attachments: File[];
  onRemove: (index: number) => void;
}

export function ComposerAttachments({ attachments, onRemove }: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null;
  return (
    <div className="composer-attachments">
      {attachments.map((file, index) => (
        <span key={`${file.name}-${index}`} className="attachment-chip">
          {file.name}
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

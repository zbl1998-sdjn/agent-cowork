import { useState } from 'react';

interface MessageActionsProps {
  onCopy: () => void;
  onRegenerate?: () => void;
}

// Hover/inline actions under an assistant message: copy the text, or regenerate
// the response — the Claude Cowork message-affordance pattern.
export function MessageActions({ onCopy, onRegenerate }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="msg-actions">
      <button
        type="button"
        className="msg-act"
        onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      >
        {copied ? '已复制' : '复制'}
      </button>
      {onRegenerate && (
        <button type="button" className="msg-act" onClick={onRegenerate}>重新生成</button>
      )}
    </div>
  );
}

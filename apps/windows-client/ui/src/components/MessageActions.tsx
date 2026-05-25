import { useState } from 'react';

interface MessageActionsProps {
  onCopy: () => void;
  onContinue?: () => void;
  onRegenerate?: () => void;
}

// Inline actions under a completed assistant message.
export function MessageActions({ onCopy, onContinue, onRegenerate }: MessageActionsProps) {
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
      {onContinue && (
        <button type="button" className="msg-act" onClick={onContinue}>继续</button>
      )}
      {onRegenerate && (
        <button type="button" className="msg-act" onClick={onRegenerate}>重新生成</button>
      )}
    </div>
  );
}

import { useState } from 'react';
import { Button } from './ui/Button';

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
      <Button
        variant="ghost"
        size="sm"
        className="msg-act"
        onClick={() => { onCopy(); setCopied(true); setTimeout(() => setCopied(false), 1200); }}
      >
        {copied ? '已复制' : '复制'}
      </Button>
      {onContinue && (
        <Button variant="ghost" size="sm" className="msg-act" onClick={onContinue}>继续</Button>
      )}
      {onRegenerate && (
        <Button variant="ghost" size="sm" className="msg-act" onClick={onRegenerate}>重新生成</Button>
      )}
    </div>
  );
}

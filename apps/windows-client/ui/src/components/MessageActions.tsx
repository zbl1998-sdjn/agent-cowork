import { useState } from 'react';
import { Button } from './ui/Button';

interface MessageActionsProps {
  onCopy: () => void;
  onContinue?: () => void;
  onCaptureRecipe?: () => void;
  captureRecipeDisabled?: boolean;
  captureRecipeLabel?: string;
  onRegenerate?: () => void;
}

// Inline actions under a completed assistant message.
export function MessageActions({ onCopy, onContinue, onCaptureRecipe, captureRecipeDisabled, captureRecipeLabel, onRegenerate }: MessageActionsProps) {
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
      {(onCaptureRecipe || captureRecipeLabel) && (
        <Button variant="ghost" size="sm" className="msg-act" disabled={captureRecipeDisabled} onClick={onCaptureRecipe}>
          {captureRecipeLabel || '存为技能'}
        </Button>
      )}
      {onRegenerate && (
        <Button variant="ghost" size="sm" className="msg-act" onClick={onRegenerate}>重新生成</Button>
      )}
    </div>
  );
}

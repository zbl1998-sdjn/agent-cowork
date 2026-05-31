// MessageActions(UI · components):消息悬浮操作——复制/重答(分叉)/编辑等单条消息动作。纯展示+回调。
import { useState } from 'react';
import { Button } from './ui/Button';

interface MessageActionsProps {
  onCopy: () => void;
  onContinue?: (() => void) | undefined;
  onCaptureRecipe?: (() => void) | undefined;
  captureRecipeDisabled?: boolean | undefined;
  captureRecipeLabel?: string | undefined;
  onRegenerate?: (() => void) | undefined;
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

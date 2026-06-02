// MessageActions 消息操作条(UI · 组件层 · components)
// ---------------------------------------------------------------------------
// 职责:助手消息底部的内联动作——复制(带"已复制"反馈)、继续、存为技能、重新生成,均通过回调上抛。
// 依赖:ui/Button。关键回调:onCopy、onContinue、onCaptureRecipe、onRegenerate。
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

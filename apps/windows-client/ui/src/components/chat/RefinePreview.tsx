import { useState } from 'react';
import type { PromptRefineResult } from '../../lib/api/prompt';

export type RefinePreviewAction = 'apply' | 'edit' | 'ignore';

export interface RefinePreviewProps {
  original: string;
  result: PromptRefineResult;
  onResolve: (action: RefinePreviewAction, prompt: string) => void;
}

export function refinePreviewPrompt(action: RefinePreviewAction, original: string, refined: string, edited: string): string {
  if (action === 'ignore') return original;
  if (action === 'edit') return edited.trim() || refined;
  return refined;
}

export function refinePreviewDisabled(result: PromptRefineResult): boolean {
  return !result.changed && result.missing.length === 0;
}

export function RefinePreview({ original, result, onResolve }: RefinePreviewProps) {
  const [edited, setEdited] = useState(result.refined);
  const missing = result.missing.length > 0;

  return (
    <section className="refine-preview" aria-label="提示优化预览">
      <header className="refine-preview-head">
        <div>
          <strong>{missing ? '需要补充信息' : '提示优化预览'}</strong>
          <span>{result.intent}</span>
        </div>
      </header>
      {missing ? (
        <div className="refine-missing">
          {result.missing.map((item) => <span key={item}>{item}</span>)}
        </div>
      ) : (
        <textarea
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
          aria-label="可编辑的优化后提示"
        />
      )}
      <div className="refine-preview-actions">
        <button
          type="button"
          disabled={missing || refinePreviewDisabled(result)}
          onClick={() => onResolve('apply', refinePreviewPrompt('apply', original, result.refined, edited))}
        >
          采用
        </button>
        <button
          type="button"
          disabled={missing}
          onClick={() => onResolve('edit', refinePreviewPrompt('edit', original, result.refined, edited))}
        >
          编辑后采用
        </button>
        <button
          type="button"
          onClick={() => onResolve('ignore', refinePreviewPrompt('ignore', original, result.refined, edited))}
        >
          忽略
        </button>
      </div>
    </section>
  );
}

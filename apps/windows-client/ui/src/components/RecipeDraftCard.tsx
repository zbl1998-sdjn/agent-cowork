// RecipeDraftCard(UI · components):配方草稿卡——展示「把这次运行存为配方」的草稿(步骤/产物),供命名后保存。纯展示+回调。
import type { CapturedRecipeDraft } from '../lib/app-types';

interface RecipeDraftCardProps {
  draft: CapturedRecipeDraft;
}

export function RecipeDraftCard({ draft }: RecipeDraftCardProps) {
  const stepCount = draft.steps.length;
  const artifactCount = draft.artifacts.length;
  return (
    <div className="recipe-draft-card">
      <div className="recipe-draft-head">
        <strong>{draft.name || '技能草稿'}</strong>
        <span>{draft.redacted ? '已脱敏' : '草稿'}</span>
      </div>
      {(draft.description || draft.prompt) && <p>{draft.description || draft.prompt}</p>}
      <div className="recipe-draft-meta">
        <span>{stepCount} 步</span>
        <span>{artifactCount} 产物</span>
        <code>{draft.id || draft.sourceRunId}</code>
      </div>
    </div>
  );
}

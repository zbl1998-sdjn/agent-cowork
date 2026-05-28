import { ComposerSendAction, ComposerToolActions } from './ComposerActions';
import { ComposerModelControls } from './ComposerModelControls';

export type ThinkingLevel = 'fast' | 'standard' | 'deep';

const THINKING_OPTIONS: Array<{ value: ThinkingLevel; label: string }> = [
  { value: 'fast', label: '快速' },
  { value: 'standard', label: '标准' },
  { value: 'deep', label: '深度' },
];

interface ComposerFooterProps {
  listening: boolean;
  refining: boolean;
  canRefine: boolean;
  model: string;
  modelOptions: string[];
  provider: string;
  defaultModel: string;
  thinking: ThinkingLevel;
  onUpload: () => void;
  onToggleVoice: () => void;
  onRefine: () => void;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
  onThinking: (value: ThinkingLevel) => void;
  onSend: () => void;
}

export function ComposerFooter({
  listening,
  refining,
  canRefine,
  model,
  modelOptions,
  provider,
  defaultModel,
  thinking,
  onUpload,
  onToggleVoice,
  onRefine,
  onProvider,
  onModel,
  onThinking,
  onSend,
}: ComposerFooterProps) {
  return (
    <div className="composer-footer">
      <div className="composer-tools">
        <ComposerToolActions
          listening={listening}
          refining={refining}
          canRefine={canRefine}
          onUpload={onUpload}
          onToggleVoice={onToggleVoice}
          onRefine={onRefine}
        />
        <ComposerModelControls
          model={model}
          modelOptions={modelOptions}
          provider={provider}
          defaultModel={defaultModel}
          onProvider={onProvider}
          onModel={onModel}
        />
        <select
          className="thinking-select"
          value={thinking}
          onChange={(e) => onThinking(e.target.value as ThinkingLevel)}
          title="思考强度:快速=秒回但浅,标准=平衡,深度=慢但仔细"
        >
          {THINKING_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>思考·{opt.label}</option>)}
        </select>
      </div>
      <ComposerSendAction refining={refining} onSend={onSend} />
    </div>
  );
}

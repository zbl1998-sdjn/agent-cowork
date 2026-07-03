// ComposerFooter(UI · components):输入框底部栏——组合模型控制、工具开关与发送动作的一行布局。纯展示+回调。
import { ComposerSendAction, ComposerToolActions } from './ComposerActions';
import { ComposerModelControls } from './ComposerModelControls';
import { ComposerTriggers, type ComposerTriggerChar } from './ComposerTriggers';
import type { ModelProviderOption } from '../lib/api/kimiConfig';

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
  modelProviders?: ModelProviderOption[] | undefined;
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
  onInsertTrigger: (char: ComposerTriggerChar) => void;
}

export function ComposerFooter({
  listening,
  refining,
  canRefine,
  model,
  modelOptions,
  modelProviders,
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
  onInsertTrigger,
}: ComposerFooterProps) {
  return (
    <div className="composer-footer">
      <details className="composer-insert">
        <summary title="插入和工具" aria-label="插入和工具">+</summary>
        <div className="composer-insert-body">
          <ComposerTriggers onTrigger={onInsertTrigger} />
          <div className="composer-tools">
            <ComposerToolActions
              listening={listening}
              refining={refining}
              canRefine={canRefine}
              onUpload={onUpload}
              onToggleVoice={onToggleVoice}
              onRefine={onRefine}
            />
            <details className="composer-advanced">
              <summary>高级</summary>
              <div className="composer-advanced-body">
                <ComposerModelControls
                  model={model}
                  modelOptions={modelOptions}
                  providerOptions={modelProviders}
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
            </details>
          </div>
        </div>
      </details>
      <ComposerSendAction refining={refining} onSend={onSend} />
    </div>
  );
}

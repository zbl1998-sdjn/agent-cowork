// ComposerFooter(UI · components):输入框底部栏——对标 Claude:左组工具图标(附件/语音/优化 · 模板/引用/历史),
// 右组推到最右(模型 · 思考 · 发送),中间留白,一行疏朗。纯展示+回调。
import { ComposerSendAction, ComposerToolActions } from './ComposerActions';
import { ComposerModelControls } from './ComposerModelControls';
import { ComposerTriggers } from './ComposerTriggers';
import type { ModelProviderOption } from '../lib/api/kimiConfig';
import type { ComposerTriggerChar, ThinkingLevel } from '../lib/types/composer';

export type { ThinkingLevel } from '../lib/types/composer';

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
      <div className="composer-footer-left">
        <ComposerToolActions
          listening={listening}
          refining={refining}
          canRefine={canRefine}
          onUpload={onUpload}
          onToggleVoice={onToggleVoice}
          onRefine={onRefine}
        />
        <span className="composer-divider" aria-hidden="true" />
        <ComposerTriggers onTrigger={onInsertTrigger} />
      </div>
      <div className="composer-footer-right">
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
        <ComposerSendAction refining={refining} onSend={onSend} />
      </div>
    </div>
  );
}

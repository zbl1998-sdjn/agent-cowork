// ComposerModelControls(UI · components):输入框模型控制——选择提供商/模型、临时调参(会话级覆盖)。纯展示+回调。
import type { ModelProviderOption } from '../lib/api/kimiConfig';

const FALLBACK_PROVIDER_OPTIONS = [
  { id: 'kimi-api', displayName: 'Kimi' },
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Claude' },
  { id: 'ollama', displayName: 'Ollama' },
  { id: 'openai/local', displayName: '本地 OpenAI-compatible' },
  { id: 'lmstudio', displayName: 'LM Studio' },
];

interface ComposerModelControlsProps {
  model: string;
  modelOptions: string[];
  providerOptions?: ModelProviderOption[] | undefined;
  provider: string;
  defaultModel: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
}

// 本轮提供商 + 模型选择器。Base URL / API Key 故意不在此处——
// 那属于凭据,应放在设置(⚙)里,而非输入框。
export function ComposerModelControls({
  model, modelOptions, providerOptions, provider, defaultModel,
  onProvider, onModel,
}: ComposerModelControlsProps) {
  const options = (providerOptions?.length ? providerOptions : FALLBACK_PROVIDER_OPTIONS)
    .map((item) => ({ id: item.id, displayName: item.displayName }));
  if (provider && !options.some((item) => item.id === provider)) {
    options.unshift({ id: provider, displayName: provider });
  }
  return (
    <>
      <select className="provider-select" value={provider} onChange={(e) => onProvider(e.target.value)} title="本轮模型提供商">
        {options.map((opt) => <option key={opt.id} value={opt.id}>{opt.displayName}</option>)}
      </select>
      {modelOptions.length > 0 && (
        <datalist id="composer-model-options">
          {modelOptions.map((m) => <option key={m} value={m} />)}
        </datalist>
      )}
      <input className="model-input" value={model} list="composer-model-options" onChange={(e) => onModel(e.target.value)} placeholder={defaultModel || '模型'} title="本轮模型" />
    </>
  );
}

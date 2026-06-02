// ComposerModelControls(UI · components):输入框模型控制——选择提供商/模型、临时调参(会话级覆盖)。纯展示+回调。
const PROVIDER_OPTIONS = [
  { value: 'kimi-api', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Claude' },
  { value: 'openai/local', label: '本地' },
];

interface ComposerModelControlsProps {
  model: string;
  modelOptions: string[];
  provider: string;
  defaultModel: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
}

// 本轮提供商 + 模型选择器。Base URL / API Key 故意不在此处——
// 那属于凭据,应放在设置(⚙)里,而非输入框。
export function ComposerModelControls({
  model, modelOptions, provider, defaultModel,
  onProvider, onModel,
}: ComposerModelControlsProps) {
  return (
    <>
      <select className="provider-select" value={provider} onChange={(e) => onProvider(e.target.value)} title="本轮模型提供商">
        {PROVIDER_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
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

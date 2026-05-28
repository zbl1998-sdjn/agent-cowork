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

// Per-turn provider + model picker. Base URL / API Key are intentionally NOT
// here — those are credentials and belong in Settings (⚙), not in the composer.
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

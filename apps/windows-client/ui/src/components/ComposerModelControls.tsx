const PROVIDER_OPTIONS = [
  { value: 'kimi-api', label: 'Kimi' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'openai/local', label: '本地' },
];

interface ComposerModelControlsProps {
  model: string;
  modelOptions: string[];
  provider: string;
  defaultModel: string;
  defaultBaseUrl: string;
  baseUrl: string;
  apiKey: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
  onBaseUrl: (value: string) => void;
  onApiKey: (value: string) => void;
}

export function ComposerModelControls({
  model, modelOptions, provider, defaultModel, defaultBaseUrl, baseUrl, apiKey,
  onProvider, onModel, onBaseUrl, onApiKey,
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
      <input className="base-url-input" value={baseUrl} onChange={(e) => onBaseUrl(e.target.value)} placeholder={defaultBaseUrl || 'Base URL'} title="本轮 Base URL" />
      <input className="api-key-input" type="password" value={apiKey} onChange={(e) => onApiKey(e.target.value)} placeholder="本轮 API Key" title="本轮 API Key" autoComplete="off" />
    </>
  );
}
